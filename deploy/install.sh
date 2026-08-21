#!/usr/bin/env bash
#
# Richtet einen Raspberry Pi als Smartmirror ein.
#
#   curl -fsSL https://raw.githubusercontent.com/lukas-mayr/smartmirror/main/deploy/install.sh -o /tmp/i.sh && sudo bash /tmp/i.sh
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

REPO="lukas-mayr/smartmirror"
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
                           (Standard: lukas-mayr/smartmirror)
  --pubkey <datei>         Oeffentlicher minisign-Schluessel. Ohne Angabe wird er
                           aus dem Repository geholt.
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

# Plattform zuerst, noch vor der Rechtepruefung: dann bekommt man die richtige
# Auskunft, ohne vorher ein Passwort eintippen zu muessen.
#
# Die Reihenfolge ist wichtig. "uname -m" allein reicht nicht: ein Mac mit
# Apple Silicon meldet ebenfalls "arm64" und kaeme durch die Architekturpruefung
# hindurch – um dann Schritte spaeter an einem fehlenden apt-get zu scheitern.
if [[ "$(uname -s)" != "Linux" ]]; then
  die "Dieses Skript richtet einen Raspberry Pi ein und laeuft nur unter Linux.
Erkannt: $(uname -s).

Fuehre es auf dem Pi aus, nicht auf dem Rechner, an dem du entwickelst:
  ssh <benutzer>@smartmirror.local
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/install.sh -o /tmp/install.sh && sudo bash /tmp/install.sh"
fi

command -v apt-get >/dev/null 2>&1 \
  || die "apt-get nicht gefunden. Erwartet wird Raspberry Pi OS oder ein anderes Debian-basiertes System."
command -v systemctl >/dev/null 2>&1 \
  || die "systemd nicht gefunden. Die Dienste des Spiegels werden von systemd gestartet."

[[ $EUID -eq 0 ]] || die "Bitte mit sudo ausfuehren."

ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
if [[ "$ARCH" != "arm64" && "$ARCH" != "aarch64" ]]; then
  die "Dieses Paket ist fuer arm64. Erkannt: $ARCH.
Auf einem Pi 4 bedeutet das meist: es laeuft das 32-Bit-Image. Bitte Raspberry Pi OS 64-bit verwenden."
fi

# Andere arm64-Einplatinenrechner koennen funktionieren, sind aber ungetestet.
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unbekannt)"
case "$MODEL" in
  *"Raspberry Pi"*) log "Erkannt: $MODEL" ;;
  *) warn "Kein Raspberry Pi erkannt (${MODEL}). Ungetestet, wird aber versucht." ;;
esac

[[ -n "$REPO" || -n "$BUNDLE" ]] || die "Entweder --repo oder --bundle angeben."

# Der oeffentliche Schluessel ist kein Geheimnis und liegt im Repository. Ihn von
# Hand herzutragen wuerde die Sicherheit nicht erhoehen: dieses Skript kommt aus
# derselben Quelle. Entscheidend ist, dass der Schluessel ab jetzt fest auf dem
# Geraet liegt – danach kann selbst ein uebernommener GitHub-Zugang kein Update
# mehr unterschieben, weil dafuer der geheime Schluessel noetig waere.
if [[ -z "$PUBKEY" ]]; then
  [[ -n "$REPO" ]] || die "Ohne --repo muss --pubkey angegeben werden."
  log "Signierschluessel aus $REPO holen"
  PUBKEY="$(mktemp)"
  curl -fsSL "https://raw.githubusercontent.com/$REPO/HEAD/minisign.pub" -o "$PUBKEY" \
    || die "Signierschluessel nicht abrufbar. Erwartet: minisign.pub im Wurzelverzeichnis von $REPO"
fi

[[ -f "$PUBKEY" ]] || die "Schluesseldatei nicht gefunden: $PUBKEY"
grep -q '^untrusted comment' "$PUBKEY" || die "Die Datei ist kein minisign-Schluessel: $PUBKEY"

KEY_ID="$(head -1 "$PUBKEY" | grep -oE '[0-9A-F]{16}' || true)"
log "Schluessel ${KEY_ID:-unbekannt} wird auf diesem Geraet verankert"

# ------------------------------- Pakete ---------------------------------------

# Vorab pruefen, statt mitten in der Installation an die Wand zu fahren.
FREE_MB="$(df -Pm / | awk 'NR==2 {print $4}')"
if [[ "$FREE_MB" -lt 2000 ]]; then
  die "Zu wenig freier Speicher: ${FREE_MB} MB. Gebraucht werden mindestens 2 GB
(Electron entpackt allein rund 300 MB, dazu Pakete und ein zweites Release fuer den Rueckfall)."
fi

# Ein bereits kaputter Paketzustand wird durch weitere Installationen nur
# schlimmer. Einmal aufraeumen lassen, bevor wir etwas anfassen.
if ! dpkg --audit 2>/dev/null | head -1 | grep -q '^$'; then
  log "Paketzustand aufraeumen"
  dpkg --configure -a >/dev/null 2>&1 || true
  apt-get --fix-broken install -y >/dev/null 2>&1 || true
fi

log "Systempakete installieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Pflicht: ohne diese startet nichts. cage zieht den kompletten
# wlroots-/Mesa-Unterbau nach, das dauert auf einer SD-Karte einige Minuten.
log "Compositor und Grundpakete (das dauert ein paar Minuten) ..."
apt-get install -y --no-install-recommends \
  ca-certificates curl tar \
  cage wlr-randr seatd \
  avahi-daemon \
  || die "Grundpakete liessen sich nicht installieren. Bitte zuerst:
  sudo apt --fix-broken install && sudo apt update && sudo apt full-upgrade -y"

# Bibliotheken, die Electron braucht.
#
# Die Namen wandern zwischen Debian-Versionen: auf Trixie heissen einige wegen
# der 64-Bit-time_t-Umstellung "...t64". Deshalb erst mit apt-cache nachsehen,
# welcher Name auf diesem System existiert – das ist eine lokale Abfrage und
# kostet nichts – und danach alles in einem einzigen Durchgang installieren.
# Sieben einzelne apt-get-Aufrufe waeren deutlich langsamer, weil jeder die
# Paketdatenbank neu einliest.
pick_package() {
  for candidate in "$@"; do
    if apt-cache show "$candidate" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  warn "Keines dieser Pakete ist verfuegbar: $*"
  return 0
}

ELECTRON_LIBS=()
for entry in "libgtk-3-0t64 libgtk-3-0" "libasound2t64 libasound2" "libnotify4" \
             "libnss3" "libxss1" "libgbm1" "libdrm2"; do
  # shellcheck disable=SC2086
  resolved="$(pick_package $entry)"
  [[ -n "$resolved" ]] && ELECTRON_LIBS+=("$resolved")
done

log "Bibliotheken fuer die Anzeige: ${ELECTRON_LIBS[*]}"
# Ausgabe bewusst sichtbar lassen: dieser Schritt dauert auf einer SD-Karte
# mehrere Minuten, und ein stiller Installer sieht dabei aus wie ein haengender.
if ! apt-get install -y --no-install-recommends "${ELECTRON_LIBS[@]}"; then
  # Zwei Reparaturversuche, in der Reihenfolge ihrer Haeufigkeit.
  warn "Installation fehlgeschlagen – versuche den Paketzustand zu reparieren."
  apt-get --fix-broken install -y || true

  if ! apt-get install -y --no-install-recommends "${ELECTRON_LIBS[@]}"; then
    # Zweiter Anlauf mit geleertem Cache. "Invalid archive signature" oder
    # "is not a Debian format archive" bedeutet: die zwischengespeicherten
    # .deb-Dateien sind beschaedigt. apt merkt das von sich aus nicht und laedt
    # sie nicht neu – es haelt den Cache fuer gueltig und scheitert bei jedem
    # Versuch aufs Neue an denselben kaputten Dateien.
    warn "Paketcache leeren und erneut laden."
    apt-get clean
    apt-get update -qq || true
    apt-get --fix-broken install -y || true

    if ! apt-get install -y --no-install-recommends "${ELECTRON_LIBS[@]}"; then
      die "Die Bibliotheken der Anzeige liessen sich nicht installieren.

Hier abzubrechen ist Absicht: Nach einem gescheiterten dpkg-Lauf ist die
Paketdatenbank in einem Zwischenzustand, und alles Weitere – auch die
Node-Installation – wuerde daran ebenfalls scheitern.

Ein geleerter Cache hat nicht geholfen. Damit bleiben zwei Ursachen, und beide
liegen ausserhalb dieses Skripts:

  1. Die SD-Karte schreibt oder liest fehlerhaft. Pruefen mit:
       dmesg | grep -iE 'mmc|I/O error|EXT4-fs error' | tail -20
     Kommen dort Fehler, hilft nur eine neue Karte und ein frisches Image.

  2. Das Netzwerk liefert etwas anderes aus als angefordert – ein Captive
     Portal oder filternder Router. Pruefen mit:
       curl -sI http://deb.debian.org/debian/dists/trixie/Release | head -3

Danach dieses Skript erneut ausfuehren."
    fi
  fi
fi

# ddcutil ist optional: viele Monitore koennen kein DDC/CI, dann regelt die
# Anzeige die Helligkeit selbst.
apt-get install -y --no-install-recommends ddcutil >/dev/null 2>&1 || \
  warn "ddcutil nicht installierbar – Helligkeit wird softwareseitig geregelt."

# --------------------------------- Node ---------------------------------------

install_node() {
  log "Node.js ${NODE_MAJOR} installieren"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
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

# seatd verwaltet den Zugriff auf Grafik- und Eingabegeraete fuer Compositor,
# die ausserhalb einer Login-Sitzung laufen. Ohne ihn kommt cage nicht an die
# Grafikausgabe: es fragt zuerst systemd-logind, findet keine Sitzung und gibt
# nach zehn Sekunden auf.
log "Seat-Verwaltung aktivieren"
systemctl enable --now seatd >/dev/null 2>&1 \
  || warn "seatd liess sich nicht starten – die Anzeige kommt dann nicht an die Grafikausgabe."
getent group _seatd >/dev/null && usermod -aG _seatd "$SERVICE_USER"

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

# Electrons Sandbox-Helfer braucht setuid-root, sonst startet die Anwendung mit
# "The SUID sandbox helper binary was found, but is not configured correctly".
# Bei einem entpackten Build – und genau das liefern wir aus – setzt das kein
# Paketmanager, es muss hier passieren. Die Alternative waere --no-sandbox, also
# den Schutz abzuschalten; das ist kein Tausch, den man auf einem dauerhaft
# laufenden Netzwerkgeraet machen sollte.
if [[ -f "$TARGET/shell/chrome-sandbox" ]]; then
  chown root:root "$TARGET/shell/chrome-sandbox"
  chmod 4755 "$TARGET/shell/chrome-sandbox"
  log "Sandbox-Helfer der Anzeige eingerichtet."
fi

# Gegenprobe: fehlt Electron eine Bibliothek, startet die Anzeige spaeter
# wortlos nicht. Lieber jetzt sagen, welche.
if command -v ldd >/dev/null 2>&1 && [[ -x "$TARGET/shell/smartmirror-shell" ]]; then
  MISSING="$(ldd "$TARGET/shell/smartmirror-shell" 2>/dev/null | awk '/not found/ {print "  " $1}' | sort -u)"
  if [[ -n "$MISSING" ]]; then
    warn "Der Anzeige fehlen Bibliotheken:"
    printf '%s\n' "$MISSING" >&2
    warn "Installieren mit: sudo apt-get install -y <passendes Paket> (Suche: apt-file search <name>)"
  else
    log "Alle Bibliotheken der Anzeige sind vorhanden."
  fi
fi

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
