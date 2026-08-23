#!/usr/bin/env bash
#
# Sorgt dafuer, dass beim Booten der Spiegel zu sehen ist und nicht der Pi.
#
# Vier Dinge, die alle ausserhalb des Releases liegen und die ein Update
# deshalb sonst nie erreichen wuerde:
#
#   1. Das Regenbogenquadrat der Firmware abschalten und den Moduswechsel
#      zwischen Firmware und Kernel vermeiden, ueber den der Bildschirm mit
#      seinem blauen "kein Signal" stolpert (config.txt).
#   2. Die Textkonsole auf ein Terminal legen, das nie angezeigt wird
#      (cmdline.txt und die Anmeldeaufforderung).
#   3. Plymouth mit dem Wortzeichen des Spiegels bestuecken, damit in den
#      vierzig Sekunden bis zur Anzeige nicht nur Schwarz dasteht.
#   4. Das Startabbild neu bauen, damit dieses Wortzeichen schon dann steht,
#      wenn Plymouth aus dem initramfs startet - und nicht erst danach.
#
# Warum das ein Dienst ist und nicht nur ein Teil des Installers: ein Spiegel
# haengt an der Wand, oft ohne dass jemand kurzfristig per SSH drankommt. Wer
# nicht ans Terminal kann, bekommt sonst Aenderungen an /boot nie - der Updater
# tauscht das Release und nichts sonst. Dieses Skript kommt als Teil des
# Releases mit, und der Updater aktiviert neue Units von selbst.
#
# Es ist wiederholbar und aendert nur, was fehlt. Laeuft es zum zweiten Mal,
# passiert nichts.
set -euo pipefail

INSTALL_ROOT="${MIRROR_INSTALL_ROOT:-/opt/smartmirror}"
DATA_DIR="${MIRROR_DATA_DIR:-$INSTALL_ROOT/data}"
SERVICE_USER="${MIRROR_SERVICE_USER:-mirror}"
THEME_SOURCE="${MIRROR_THEME_SOURCE:-$INSTALL_ROOT/current/deploy/plymouth}"
THEME_DIR="${MIRROR_THEME_DIR:-/usr/share/plymouth/themes/smartmirror}"
STATUS_FILE="$DATA_DIR/bootlook-status.json"

BOOT_DIR="${MIRROR_BOOT_DIR:-}"
if [[ -z "$BOOT_DIR" ]]; then
  BOOT_DIR="/boot/firmware"
  [[ -f "$BOOT_DIR/cmdline.txt" ]] || BOOT_DIR="/boot"
fi
CONFIG_TXT="$BOOT_DIR/config.txt"
CMDLINE_TXT="$BOOT_DIR/cmdline.txt"

# Wie oft hoechstens versucht wird, Plymouth nachzuinstallieren. Ohne Grenze
# liefe bei einem Pi ohne Netz bei jedem Start ein apt-Aufruf ins Leere.
MAX_INSTALL_ATTEMPTS=3

log() { printf 'mirror-bootlook: %s\n' "$*"; }

CHANGED=()
merke() { CHANGED+=("$1"); log "geaendert: $1"; }

# ---------------------------------------------------------------- Konfiguration

lies_drehung() {
  # Die Drehung steht in der Konfiguration des Cores. Faellt das Lesen aus -
  # keine Datei, kein node, kaputtes JSON -, ist 0 die richtige Annahme: ein
  # quer haengender Spiegel ist der Normalfall.
  local config="$DATA_DIR/config.json"
  [[ -f "$config" ]] || { printf '0'; return; }
  node -e '
    try {
      const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const rotation = Number(config.display?.rotation ?? 0);
      process.stdout.write([0, 90, 180, 270].includes(rotation) ? String(rotation) : "0");
    } catch { process.stdout.write("0"); }
  ' "$config" 2>/dev/null || printf '0'
}

# ------------------------------------------------------------------- config.txt

letzter_wert() {
  # Die Firmware liest die Datei von oben nach unten, die letzte Zuweisung
  # gewinnt. Auskommentiertes zaehlt nicht mit.
  #
  # Genau genommen gilt das nur innerhalb der Abschnitte, die auf das Modell
  # passen - eine Zeile unter [pi4] zaehlt auf einem Pi 5 nicht. Fuer das, was
  # hier davon abhaengt, reicht die einfache Lesart trotzdem: gefragt wird, ob
  # der Block weiter unten schon steht, den dieses Skript selbst anhaengt.
  grep -E "^[[:space:]]*$1=" "$CONFIG_TXT" 2>/dev/null | tail -1 \
    | sed -E "s/^[[:space:]]*$1=//" | tr -d '[:space:]'
}

setze_config_txt() {
  [[ -f "$CONFIG_TXT" ]] || { log "Keine $CONFIG_TXT - uebersprungen."; return; }

  local fehlend=()

  # Das Regenbogenquadrat der Firmware ist das erste Bild nach dem Einschalten
  # und die einzige grosse helle Flaeche im ganzen Startvorgang.
  [[ "$(letzter_wert disable_splash)" == '1' ]] || fehlend+=('disable_splash=1')

  # Und der blaue Hinweis des Bildschirms mitten im Start.
  #
  # Raspberry Pi OS setzt disable_fw_kms_setup=1. Die Firmware richtet die
  # Anzeige dann nicht ein, der Kernel tut es Sekunden spaeter selbst - und
  # dazwischen liegt ein Moduswechsel. Fuer den Bildschirm heisst das: Signal
  # weg, eigenes Menue an ("kein Signal", blau), Signal wieder da. Mitten im
  # Startbildschirm ist das das Auffaelligste am ganzen Vorgang.
  #
  # Mit 0 stellt die Firmware den Modus ein und der Kernel uebernimmt ihn
  # unveraendert. Es gibt keinen Wechsel mehr, ueber den der Bildschirm
  # stolpern koennte, und das Bild steht durchgehend.
  [[ "$(letzter_wert disable_fw_kms_setup)" == '0' ]] || fehlend+=('disable_fw_kms_setup=0')

  (( ${#fehlend[@]} > 0 )) || return 0

  # Ans Ende, aber mit eigenem [all]-Abschnitt davor. Ohne den koennten die
  # Zeilen hinter einem Filter wie [pi4] landen und gaelten dann nur fuer ein
  # Modell - ein Fehler, den man erst am fertig aufgehaengten Spiegel sieht.
  {
    printf '\n# Smartmirror: kein Regenbogenquadrat, kein Moduswechsel beim Start\n[all]\n'
    printf '%s\n' "${fehlend[@]}"
  } >> "$CONFIG_TXT"
  merke 'config.txt'
}

# ------------------------------------------------------------------ cmdline.txt

# Die Parameter, die die Textkonsole unsichtbar machen.
#
# "quiet" allein reicht nicht: es daempft, laesst aber Warnungen, Fehler und
# Dateisystempruefungen durch. Deshalb wandert die Konsole als Ganzes auf tty3,
# ein Terminal, das nie angezeigt wird. "splash" und
# "plymouth.ignore-serial-consoles" braucht Plymouth, um statt einer
# Textausgabe das Bild zu zeigen.
CMDLINE_PARAMS=(
  logo.nologo
  vt.global_cursor_default=0
  consoleblank=0
  quiet
  splash
  plymouth.ignore-serial-consoles
)

setze_cmdline_txt() {
  [[ -f "$CMDLINE_TXT" ]] || { log "Keine $CMDLINE_TXT - uebersprungen."; return; }

  local original zeile
  original="$(head -1 "$CMDLINE_TXT")"
  zeile="$original"

  # tty1 ist das Terminal, das beim Booten sichtbar ist. Steht dort schon ein
  # anderes, wurde die Zeile von Hand angepasst - dann nicht hineinregieren.
  if [[ " $zeile " == *" console=tty1 "* ]]; then
    zeile="${zeile// console=tty1 / console=tty3 }"
  elif [[ "$zeile" != *"console="* ]]; then
    zeile="$zeile console=tty3"
  fi

  local param
  for param in "${CMDLINE_PARAMS[@]}"; do
    # Wort fuer Wort pruefen und nur Fehlendes anhaengen: so bleibt ein zweiter
    # Lauf folgenlos, und von Hand Eingetragenes bleibt stehen.
    [[ " $zeile " == *" ${param%%=*} "* || " $zeile " == *" ${param%%=*}="* ]] && continue
    zeile="$zeile $param"
  done

  [[ "$zeile" == "$original" ]] && return 0

  # Ab hier wird an der Datei geschrieben, mit der der Pi bootet. Eine kaputte
  # cmdline.txt heisst: das Geraet startet nicht mehr, und genau der Fall - kein
  # Terminal in Reichweite - ist der Grund, warum es dieses Skript gibt.
  #
  # Deshalb erst gegenlesen und nur schreiben, wenn das Ergebnis plausibel ist.
  if [[ "$zeile" != *"root="* || "$zeile" != *"console="* || "$zeile" == *$'\n'* ]]; then
    log "Ergebnis sieht nicht nach einer Kernel-Zeile aus - nichts geaendert."
    return 0
  fi

  # Eine Sicherung, einmalig. Sie ueberlebt spaetere Laeufe: die erste Fassung
  # ist die, auf die man zurueck will.
  [[ -f "$CMDLINE_TXT.smartmirror-orig" ]] || cp -a "$CMDLINE_TXT" "$CMDLINE_TXT.smartmirror-orig"

  # Daneben schreiben und umbenennen: ein Stromausfall mitten im Schreiben darf
  # keine halbe Kernel-Zeile hinterlassen.
  printf '%s\n' "$zeile" > "$CMDLINE_TXT.smartmirror-neu"
  mv -f "$CMDLINE_TXT.smartmirror-neu" "$CMDLINE_TXT"
  sync
  merke 'cmdline.txt'
}

# ------------------------------------------------------- Anmeldeaufforderung

setze_getty() {
  command -v systemctl >/dev/null 2>&1 || return 0

  # Die Anmeldeaufforderung zieht mit auf tty3. Sie ganz abzuschalten waere
  # kuerzer, nimmt aber den letzten Weg auf ein Geraet, dessen Netzwerk nicht
  # mehr geht: Bildschirm und Tastatur anstecken, Alt+F3 druecken.
  if systemctl is-enabled getty@tty1.service >/dev/null 2>&1; then
    if systemctl disable --now getty@tty1.service >/dev/null 2>&1; then
      merke 'Anmeldung auf tty3 (Alt+F3)'
    else
      log "getty auf tty1 liess sich nicht abschalten."
    fi
  fi
  systemctl is-enabled getty@tty3.service >/dev/null 2>&1 \
    || systemctl enable --now getty@tty3.service >/dev/null 2>&1 \
    || log "getty auf tty3 liess sich nicht einrichten."
}

# --------------------------------------------------------------------- Plymouth

# Die drei Werte gehen so, wie sie sind, ueber das Protokoll an die Handy-App –
# deshalb englisch wie alles andere dort, waehrend die Meldungen hier deutsch
# bleiben.
PLYMOUTH_STATE='missing'

hole_plymouth() {
  if command -v plymouth-set-default-theme >/dev/null 2>&1; then
    PLYMOUTH_STATE='ready'
    return 0
  fi

  local versuche=0
  [[ -f "$DATA_DIR/.bootlook-plymouth-versuche" ]] \
    && versuche="$(cat "$DATA_DIR/.bootlook-plymouth-versuche" 2>/dev/null || echo 0)"
  [[ "$versuche" =~ ^[0-9]+$ ]] || versuche=0

  if (( versuche >= MAX_INSTALL_ATTEMPTS )); then
    log "Plymouth fehlt; nach $versuche Versuchen nicht mehr probiert."
    return 0
  fi

  command -v apt-get >/dev/null 2>&1 || return 0
  printf '%s' "$(( versuche + 1 ))" > "$DATA_DIR/.bootlook-plymouth-versuche"

  log "Plymouth nachinstallieren (Versuch $(( versuche + 1 )) von $MAX_INSTALL_ATTEMPTS) ..."
  # Ein einzelnes Paket aus derselben Quelle, aus der das System ohnehin
  # stammt. Schlaegt es fehl - kein Netz, apt gerade belegt -, bleibt es beim
  # schwarzen Bildschirm bis zur Anzeige; das ist kein Grund, den Start
  # aufzuhalten.
  export DEBIAN_FRONTEND=noninteractive
  if timeout 300 apt-get install -y --no-install-recommends plymouth >/dev/null 2>&1 \
    || { timeout 120 apt-get update -qq >/dev/null 2>&1 \
         && timeout 300 apt-get install -y --no-install-recommends plymouth >/dev/null 2>&1; }; then
    PLYMOUTH_STATE='installed'
    merke 'Plymouth installiert'
    rm -f "$DATA_DIR/.bootlook-plymouth-versuche"
  else
    log "Plymouth liess sich nicht installieren - der Start bleibt bis zur Anzeige schwarz."
  fi
}

setze_plymouth_thema() {
  [[ "$PLYMOUTH_STATE" != 'missing' ]] || return 0
  [[ -d "$THEME_SOURCE" ]] || { log "Kein Thema unter $THEME_SOURCE."; return 0; }

  local drehung
  drehung="$(lies_drehung)"

  # Die vier Ebenen des Wortzeichens: das Wort und die drei Punkte einzeln,
  # damit das Thema die Punkte atmen lassen kann, ohne das Wort mitzunehmen.
  # Jede liegt fertig gedreht bei; das Thema legt sie mittig uebereinander.
  local ebenen=(mark dot1 dot2 dot3) ebene
  for ebene in "${ebenen[@]}"; do
    # Fehlt auch nur eine Fassung fuer diese Drehung, gilt fuer alle die quere:
    # ein halb gedrehtes Wortzeichen waere schlimmer als ein gerades.
    [[ -f "$THEME_SOURCE/$ebene-$drehung.png" ]] || { drehung=0; break; }
  done
  for ebene in "${ebenen[@]}"; do
    [[ -f "$THEME_SOURCE/$ebene-$drehung.png" ]] \
      || { log "Kein Bild fuer den Startbildschirm gefunden."; return 0; }
  done

  mkdir -p "$THEME_DIR"
  local geaendert='nein' datei
  for datei in smartmirror.plymouth smartmirror.script; do
    if ! cmp -s "$THEME_SOURCE/$datei" "$THEME_DIR/$datei"; then
      install -m 0644 "$THEME_SOURCE/$datei" "$THEME_DIR/$datei"
      geaendert='ja'
    fi
  done
  for ebene in "${ebenen[@]}"; do
    if ! cmp -s "$THEME_SOURCE/$ebene-$drehung.png" "$THEME_DIR/$ebene.png"; then
      install -m 0644 "$THEME_SOURCE/$ebene-$drehung.png" "$THEME_DIR/$ebene.png"
      geaendert='ja'
    fi
  done
  # Bis Version 0.19 lag hier ein einziges Bild. Bleibt es liegen, verwirrt es
  # nur den, der spaeter in das Verzeichnis sieht.
  rm -f "$THEME_DIR/splash.png"

  # Das Thema auch wirklich einschalten. Ohne Argument gibt der Befehl nur aus,
  # was gerade gilt; das Setzen ist ein Symlink auf die .plymouth-Datei. Um das
  # Startabbild kuemmert sich erneuere_initramfs weiter unten.
  if [[ "$(plymouth-set-default-theme 2>/dev/null || true)" != 'smartmirror' ]]; then
    plymouth-set-default-theme smartmirror >/dev/null 2>&1 \
      && geaendert='ja' \
      || log "Thema liess sich nicht als Standard setzen."
  fi

  # Plymouth soll liegen bleiben, bis die Anzeige zeichnet.
  #
  # Von Haus aus endet es, sobald multi-user.target erreicht ist - also einige
  # Sekunden bevor Electron sein erstes Bild hat. Genau diese Luecke waere
  # wieder schwarz. Mit --retain-splash bleibt das letzte Bild stehen, bis cage
  # darueber zeichnet, und "After=mirror-shell.service" sorgt dafuer, dass das
  # ueberhaupt erst passiert, wenn die Anzeige gestartet ist.
  local dropin="${MIRROR_DROPIN_DIR:-/etc/systemd/system}/plymouth-quit.service.d"
  local wunsch
  wunsch=$'[Unit]\nAfter=mirror-shell.service\n\n[Service]\nExecStart=\nExecStart=/usr/bin/plymouth quit --retain-splash\n'
  # Byteweise vergleichen und nicht ueber "$(cat ...)": eine
  # Kommandosubstitution schneidet den Zeilenumbruch am Ende ab, und der
  # Vergleich schluege dann bei jedem Lauf fehl. Die Folge waere nicht nur ein
  # ueberfluessiges daemon-reload, sondern ein Hinweis auf einen ausstehenden
  # Neustart, der nie wieder verschwindet.
  if ! printf '%s' "$wunsch" | cmp -s - "$dropin/smartmirror.conf" 2>/dev/null; then
    mkdir -p "$dropin"
    printf '%s' "$wunsch" > "$dropin/smartmirror.conf"
    systemctl daemon-reload >/dev/null 2>&1 || true
    geaendert='ja'
  fi

  [[ "$geaendert" == 'ja' ]] && merke "Plymouth-Thema (Drehung ${drehung}°)"

  # Und einmal aufschreiben, was tatsaechlich gilt. Wenn beim Booten etwas
  # anderes zu sehen ist als das Wortzeichen, ist das die erste Frage – und die
  # einzige Stelle, an der sie sich ohne Bildschirm beantworten laesst, ist
  # "journalctl -u mirror-bootlook".
  log "Plymouth-Thema in Betrieb: $(plymouth-set-default-theme 2>/dev/null || echo unbekannt)"
  return 0
}

# ------------------------------------------------------------------- initramfs

# Das Thema muss ins Startabbild, sonst ist es nie zu sehen.
#
# Raspberry Pi OS baut seit Bookworm ein initramfs (auto_initramfs=1). Plymouth
# startet daraus - lange bevor das Wurzeldateisystem eingehaengt ist - und
# behaelt fuer den ganzen Start das Thema, das beim Bauen des Abbilds
# hineinkopiert wurde. Ein Thema, das nur unter /usr/share/plymouth liegt,
# kommt deshalb nie auf den Bildschirm: zu sehen ist bis zum Schluss das, was
# im Abbild steht - auf einem frischen Pi das Vorgefundene der Distribution.
#
# Genau das ist der Grund, warum beim Booten die Punkte einer fremden Anzeige
# standen und das Wortzeichen erst am Ende kam, als die Anzeige selbst zeichnete.

initramfs_im_einsatz() {
  compgen -G "$BOOT_DIR/initramfs*" >/dev/null && return 0
  compgen -G "$BOOT_DIR/initrd.img*" >/dev/null && return 0
  [[ -f "$CONFIG_TXT" ]] \
    && grep -qE '^[[:space:]]*(auto_initramfs=1|initramfs[[:space:]])' "$CONFIG_TXT"
}

thema_fingerabdruck() {
  # Ueber den Inhalt und nicht ueber Zeitstempel: der Updater legt bei jedem
  # Release neue Dateien an, gleich ob sich am Wortzeichen etwas geaendert hat.
  # Waere die Zeit das Mass, baute der Spiegel bei jedem Update ein Abbild neu,
  # das er nicht braucht.
  cat "$THEME_DIR"/smartmirror.plymouth "$THEME_DIR"/smartmirror.script "$THEME_DIR"/*.png 2>/dev/null \
    | sha256sum 2>/dev/null | cut -d' ' -f1
}

erneuere_initramfs() {
  [[ "$PLYMOUTH_STATE" != 'missing' ]] || return 0
  command -v update-initramfs >/dev/null 2>&1 || return 0
  initramfs_im_einsatz || return 0

  local fingerabdruck stempel="$DATA_DIR/.bootlook-initramfs"
  fingerabdruck="$(thema_fingerabdruck)"
  # Ohne Fingerabdruck liesse sich nicht sagen, wann es genug ist - dann lieber
  # nichts tun, als bei jedem Start ein Abbild neu zu bauen.
  [[ -n "$fingerabdruck" ]] || { log "Fingerabdruck des Themas nicht zu bilden."; return 0; }
  [[ -f "$stempel" && "$(cat "$stempel" 2>/dev/null)" == "$fingerabdruck" ]] && return 0

  log "Startabbild neu bauen, damit das Wortzeichen von Anfang an steht ..."
  # Grosszuegig, aber nicht unbegrenzt: auf einem Pi dauert das eine halbe
  # Minute. Haengt es, soll der Dienst trotzdem irgendwann fertig werden.
  if timeout 300 update-initramfs -u >/dev/null 2>&1; then
    printf '%s' "$fingerabdruck" > "$stempel"
    merke 'Startabbild (initramfs)'
  else
    # Kein Abbruch: alles andere wirkt weiterhin, nur die erste Sekunde des
    # Starts zeigt dann noch das alte Bild.
    log "update-initramfs schlug fehl - der Start zeigt bis zum Wurzeldateisystem das alte Bild."
  fi
}

# ----------------------------------------------------------------------- Bericht

schreibe_status() {
  local boot_id vorher_boot_id ausstehend='false'
  # Die Kennung der laufenden Sitzung. Ueber die Umgebung ueberschreibbar,
  # damit die Tests mehrere Starts nacheinander nachstellen koennen.
  boot_id="${MIRROR_BOOT_ID:-$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unbekannt)}"

  # Ob ein Neustart aussteht, laesst sich nicht am Dateiinhalt ablesen: die
  # Kernel-Zeile wirkt erst beim naechsten Start, und die Firmware liest die
  # config.txt noch frueher. Gemerkt wird deshalb, in welcher Sitzung zuletzt
  # etwas geaendert wurde. Ist das die laufende, steht der Neustart noch aus;
  # ist es eine frueherer, ist alles laengst wirksam.
  vorher_boot_id="$(node -e '
    try {
      const status = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(status.changedAtBootId ?? ""));
    } catch { process.stdout.write(""); }
  ' "$STATUS_FILE" 2>/dev/null || printf '')"

  local changed_boot_id="$vorher_boot_id"
  if (( ${#CHANGED[@]} > 0 )); then
    changed_boot_id="$boot_id"
    ausstehend='true'
  elif [[ -n "$vorher_boot_id" && "$vorher_boot_id" == "$boot_id" ]]; then
    ausstehend='true'
  fi

  mkdir -p "$DATA_DIR"
  node -e '
    const { writeFileSync, renameSync } = require("node:fs");
    const [file, appliedAt, pending, bootId, changedAtBootId, plymouth, ...changed] = process.argv.slice(1);
    const status = {
      appliedAt,
      pendingReboot: pending === "true",
      bootId,
      changedAtBootId: changedAtBootId || null,
      plymouth,
      changed,
    };
    writeFileSync(file + ".tmp", JSON.stringify(status, null, 2) + "\n");
    renameSync(file + ".tmp", file);
  ' "$STATUS_FILE" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$ausstehend" "$boot_id" \
    "$changed_boot_id" "$PLYMOUTH_STATE" "${CHANGED[@]}" 2>/dev/null || {
      log "Statusdatei liess sich nicht schreiben."
      return 0
    }

  # Der Core liest sie; er laeuft als Dienstbenutzer.
  chown "$SERVICE_USER:$SERVICE_USER" "$STATUS_FILE" 2>/dev/null || true
  chmod 600 "$STATUS_FILE" 2>/dev/null || true
}

# ------------------------------------------------------------------------ Ablauf

# Geschrieben wird an /boot und an den systemd-Units – auf einem Pi braucht
# beides Root. Gefragt wird hier trotzdem nicht nach der Benutzerkennung,
# sondern nach der Sache: ob sich die Dateien anfassen lassen, um die es geht.
#
# Der Unterschied ist keiner der Eleganz. "$EUID -ne 0" sperrt auch einen Lauf
# aus, der gar nichts am System anfasst – etwa den der Tests, die das Skript
# gegen nachgebaute /boot-Dateien in einem Temporaerverzeichnis fahren. Eine
# Pruefung, die nur unter root durchlaeuft, kann von einer CI nicht ausgefuehrt
# werden, und damit pruefte niemand mehr das Skript, das an der Kernel-Zeile
# schreibt.
if [[ -d "$BOOT_DIR" && ! -w "$BOOT_DIR" ]]; then
  log "Keine Schreibrechte auf $BOOT_DIR – bitte als root ausfuehren."
  exit 1
fi

setze_config_txt
setze_cmdline_txt
setze_getty
hole_plymouth
setze_plymouth_thema
erneuere_initramfs
schreibe_status

if (( ${#CHANGED[@]} > 0 )); then
  log "Fertig. Ein Neustart macht es sichtbar."
else
  log "Nichts zu tun - der Start ist bereits eingerichtet."
fi
