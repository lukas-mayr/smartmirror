#!/usr/bin/env bash
#
# Richtet einen Raspberry Pi als Smartmirror ein.
#
#   sudo ./install.sh --repo benutzer/smartmirror --pubkey ./minisign.pub
#
# Danach bootet der Pi ohne Anmeldung direkt in die Anzeige, und die
# Fernbedienung ist unter http://smartmirror.local:8080 erreichbar.
#
# Das Skript ist wiederholbar: ein zweiter Lauf aktualisiert nur, was sich
# geaendert hat, und laesst Konfiguration und Kopplungen unberuehrt.
set -euo pipefail

INSTALL_ROOT="/opt/smartmirror"
SERVICE_USER="mirror"
NODE_MAJOR="22"

REPO=""
PUBKEY=""
BUNDLE=""
CHANNEL="stable"
SKIP_BOOT_CONFIG="no"

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Optionen:
  --repo <benutzer/repo>   GitHub-Repository, aus dem Updates geholt werden
  --pubkey <datei>         Oeffentlicher minisign-Schluessel zur Update-Pruefung (Pflicht)
  --bundle <datei.tar.gz>  Lokales Release statt Download von GitHub
  --channel <stable|beta>  Update-Kanal (Standard: stable)
  --skip-boot-config       /boot/firmware/config.txt nicht anfassen
  -h, --help               Diese Hilfe
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --pubkey) PUBKEY="${2:-}"; shift 2 ;;
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --skip-boot-config) SKIP_BOOT_CONFIG="yes"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unbekannte Option: $1" ;;
  esac
done

# --------------------------------- Pruefungen ---------------------------------

[[ $EUID -eq 0 ]] || die "Bitte mit sudo ausfuehren."

ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
if [[ "$ARCH" != "arm64" && "$ARCH" != "aarch64" ]]; then
  die "Dieses Paket ist fuer arm64. Erkannt: $ARCH.
Auf einem Pi 4 bedeutet das meist: es laeuft das 32-Bit-Image. Bitte Raspberry Pi OS 64-bit verwenden."
fi

if [[ -z "$PUBKEY" ]]; then
  die "--pubkey fehlt.
Ohne oeffentlichen Schluessel kann der Updater keine Signaturen pruefen, und ein
uebernommener GitHub-Zugang oder manipuliertes DNS wuerde beliebigen Code auf
diesem Geraet ausfuehren. Schluessel erzeugen: minisign -G -p minisign.pub -s minisign.key"
fi
[[ -f "$PUBKEY" ]] || die "Schluesseldatei nicht gefunden: $PUBKEY"
grep -q '^untrusted comment' "$PUBKEY" || warn "Die Schluesseldatei sieht ungewoehnlich aus – bitte pruefen."

[[ -n "$REPO" || -n "$BUNDLE" ]] || die "Entweder --repo oder --bundle angeben."

# ------------------------------- Pakete ---------------------------------------

log "Systempakete installieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl tar \
  cage wlr-randr \
  libgtk-3-0 libnotify4 libnss3 libxss1 libasound2 libgbm1 libdrm2 \
  avahi-daemon \
  >/dev/null

# ddcutil ist optional: viele Monitore koennen kein DDC/CI, dann regelt die
# Anzeige die Helligkeit selbst.
apt-get install -y --no-install-recommends ddcutil >/dev/null 2>&1 || \
  warn "ddcutil nicht installierbar – Helligkeit wird softwareseitig geregelt."

# --------------------------------- Node ---------------------------------------

install_node() {
  log "Node.js ${NODE_MAJOR} installieren"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
}

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE="$(node -p 'process.versions.node.split(".")[0]')"
  if (( CURRENT_NODE < 20 )); then
    warn "Node ${CURRENT_NODE} ist zu alt."
    install_node
  else
    log "Node $(node -v) ist bereits vorhanden"
  fi
else
  install_node
fi

# ------------------------------ Benutzer und Pfade ----------------------------

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Dienstbenutzer '$SERVICE_USER' anlegen"
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# Ohne diese Gruppen kommt die Anzeige nicht an Grafikausgabe und Eingabe.
for group in video render input; do
  getent group "$group" >/dev/null && usermod -aG "$group" "$SERVICE_USER"
done

log "Verzeichnisse unter $INSTALL_ROOT anlegen"
mkdir -p "$INSTALL_ROOT/releases" "$INSTALL_ROOT/data"
# Die Daten gehoeren dem Dienst, der Rest bleibt root: ein kompromittierter
# Core kann damit den installierten Code nicht veraendern.
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_ROOT/data"
chmod 700 "$INSTALL_ROOT/data"

install -m 0644 "$PUBKEY" "$INSTALL_ROOT/minisign.pub"
log "Signaturschluessel hinterlegt: $INSTALL_ROOT/minisign.pub"

# ------------------------------ Release einspielen ----------------------------

fetch_release() {
  log "Neuestes Release aus $REPO holen"
  local api="https://api.github.com/repos/$REPO/releases"
  local json archive checksum signature version tmp
  json="$(curl -fsSL "$api?per_page=20")" || die "GitHub nicht erreichbar."

  # Ohne jq auskommen: das Skript soll auf einem frischen System laufen.
  version="$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  [[ -n "$version" ]] || die "Kein Release in $REPO gefunden."
  archive="$(printf '%s' "$json" | grep -o 'https://[^"]*-arm64\.tar\.gz' | head -1)"
  checksum="$(printf '%s' "$json" | grep -o 'https://[^"]*-arm64\.tar\.gz\.sha256' | head -1)"
  signature="$(printf '%s' "$json" | grep -o 'https://[^"]*-arm64\.tar\.gz\.minisig' | head -1)"
  [[ -n "$archive" && -n "$checksum" ]] || die "Release $version enthaelt kein arm64-Archiv mit Pruefsumme."

  tmp="$(mktemp -d)"
  curl -fsSL "$archive" -o "$tmp/release.tar.gz"
  curl -fsSL "$checksum" -o "$tmp/release.sha256"
  [[ -n "$signature" ]] && curl -fsSL "$signature" -o "$tmp/release.minisig"

  ( cd "$tmp" && awk '{print $1"  release.tar.gz"}' release.sha256 | sha256sum -c - >/dev/null ) \
    || die "Pruefsumme des Downloads stimmt nicht."
  log "Pruefsumme stimmt ($version)"

  BUNDLE="$tmp/release.tar.gz"
  BUNDLE_VERSION="${version#v}"
}

BUNDLE_VERSION=""
if [[ -z "$BUNDLE" ]]; then
  fetch_release
fi

STAGING="$(mktemp -d)"
tar -xzf "$BUNDLE" -C "$STAGING"
# Archive mit einzelnem Wurzelverzeichnis ebenfalls akzeptieren.
if [[ ! -f "$STAGING/VERSION" ]]; then
  inner="$(find "$STAGING" -maxdepth 2 -name VERSION -printf '%h\n' | head -1)"
  [[ -n "$inner" ]] || die "Archiv enthaelt keine VERSION-Datei."
  STAGING="$inner"
fi
[[ -n "$BUNDLE_VERSION" ]] || BUNDLE_VERSION="$(cat "$STAGING/VERSION")"

TARGET="$INSTALL_ROOT/releases/$BUNDLE_VERSION"
log "Release $BUNDLE_VERSION nach $TARGET installieren"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -a "$STAGING/." "$TARGET/"
chmod +x "$TARGET/deploy/cage-session.sh" 2>/dev/null || true
chmod +x "$TARGET/shell/smartmirror-shell" 2>/dev/null || true

# Symlink atomar setzen, damit ein abgebrochener Lauf kein halbes "current" hinterlaesst.
ln -sfn "$TARGET" "$INSTALL_ROOT/current.new"
mv -T "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"

# --------------------------- Erstkonfiguration --------------------------------

CONFIG="$INSTALL_ROOT/data/config.json"
if [[ ! -f "$CONFIG" && -n "$REPO" ]]; then
  log "Grundkonfiguration anlegen (Repository: $REPO, Kanal: $CHANNEL)"
  cat > "$CONFIG" <<JSON
{
  "schemaVersion": 1,
  "update": {
    "repository": "$REPO",
    "channel": "$CHANNEL",
    "autoUpdate": true,
    "checkIntervalMinutes": 15
  }
}
JSON
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG"
  chmod 600 "$CONFIG"
fi

# ------------------------------ Bildschirm/Boot -------------------------------

BOOT_CONFIG="/boot/firmware/config.txt"
[[ -f "$BOOT_CONFIG" ]] || BOOT_CONFIG="/boot/config.txt"

if [[ "$SKIP_BOOT_CONFIG" == "no" && -f "$BOOT_CONFIG" ]]; then
  log "Bildschirm-Einstellungen in $BOOT_CONFIG pruefen"
  # Der moderne KMS-Treiber ist Voraussetzung dafuer, dass cage ohne
  # Desktop direkt auf die Grafikausgabe zeichnen kann.
  if ! grep -qE '^\s*dtoverlay=vc4-kms-v3d' "$BOOT_CONFIG"; then
    printf '\n# Smartmirror: KMS-Treiber fuer Wayland ohne Desktop\ndtoverlay=vc4-kms-v3d\n' >> "$BOOT_CONFIG"
    warn "vc4-kms-v3d ergaenzt – ein Neustart ist noetig."
  fi
  if ! grep -qE '^\s*disable_overscan=1' "$BOOT_CONFIG"; then
    printf 'disable_overscan=1\n' >> "$BOOT_CONFIG"
  fi
fi

# Textkonsole nicht abdunkeln und keinen Blinkcursor zeigen: beides waere in den
# Sekunden vor dem Start der Anzeige durch den Spiegel sichtbar.
CMDLINE="/boot/firmware/cmdline.txt"
[[ -f "$CMDLINE" ]] || CMDLINE="/boot/cmdline.txt"
if [[ -f "$CMDLINE" ]] && ! grep -q 'vt.global_cursor_default=0' "$CMDLINE"; then
  sed -i '1 s/$/ consoleblank=0 vt.global_cursor_default=0 logo.nologo quiet/' "$CMDLINE"
fi

if [[ "$(hostname)" != "smartmirror" ]]; then
  log "Hostname auf 'smartmirror' setzen (fuer smartmirror.local)"
  hostnamectl set-hostname smartmirror || warn "Hostname konnte nicht gesetzt werden."
  sed -i "s/127\.0\.1\.1.*/127.0.1.1\tsmartmirror/" /etc/hosts || true
fi
systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

# --------------------------------- Dienste ------------------------------------

log "systemd-Units installieren"
install -m 0644 "$INSTALL_ROOT/current/deploy/systemd/"*.service /etc/systemd/system/
install -m 0644 "$INSTALL_ROOT/current/deploy/systemd/"*.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable mirror-core.service mirror-shell.service mirror-updater.timer >/dev/null
systemctl restart mirror-core.service
systemctl restart mirror-shell.service
systemctl start mirror-updater.timer

# --------------------------------- Abschluss ----------------------------------

sleep 3
if curl -sf --max-time 5 http://127.0.0.1:8080/healthz >/dev/null; then
  log "Core antwortet."
else
  warn "Core antwortet noch nicht. Log ansehen mit: journalctl -u mirror-core -n 50"
fi

cat <<DONE

Fertig. Version $BUNDLE_VERSION ist installiert.

  Fernbedienung   http://smartmirror.local:8080
  Kopplung        Der Spiegel zeigt einen sechsstelligen Code, sobald sich ein
                  ungekoppeltes Geraet verbindet.
  Logs            journalctl -u mirror-core -u mirror-shell -u mirror-updater -f
  Update von Hand systemctl start mirror-updater.service

DONE

if ! grep -qE '^\s*dtoverlay=vc4-kms-v3d' "${BOOT_CONFIG:-/dev/null}" 2>/dev/null; then
  warn "Bitte neu starten, damit die Grafik-Einstellungen greifen: sudo reboot"
fi
