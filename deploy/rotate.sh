#!/usr/bin/env bash
#
# Dreht die Anzeige, ohne den Spiegel zu koppeln.
#
#   sudo /opt/smartmirror/current/deploy/rotate.sh 90
#
# Gedacht fuer genau einen Fall: Der Spiegel haengt hochkant an der Wand, der
# Kopplungscode steht quer darauf und ist kaum zu lesen. Ueber die Handy-App
# waere die Drehung erreichbar – aber nur nach der Kopplung, fuer die man
# diesen Code braucht. Deshalb muss sie auch von aussen zu setzen sein.
#
# Gedreht wird der Inhalt im Uhrzeigersinn: ein nach links gekippt
# aufgehaengter Bildschirm braucht 90, ein nach rechts gekippter 270.
set -euo pipefail

INSTALL_ROOT="/opt/smartmirror"
SERVICE_USER="mirror"
CONFIG="$INSTALL_ROOT/data/config.json"

ROTATION="${1:-}"
case "$ROTATION" in
  0|90|180|270) ;;
  *) echo "Aufruf: $0 <0|90|180|270>" >&2; exit 1 ;;
esac

[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }
[[ -f "$CONFIG" ]] || { echo "Keine Konfiguration gefunden: $CONFIG" >&2; exit 1; }

# Nur dieses eine Feld anfassen: in derselben Datei stehen Module, Zeitplan und
# Update-Einstellungen, die hier niemanden etwas angehen.
node -e '
  const { readFileSync, writeFileSync, renameSync } = require("node:fs");
  const [file, rotation] = process.argv.slice(1);
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.display = { ...(config.display ?? {}), rotation: Number(rotation) };
  // Erst daneben schreiben, dann umbenennen: ein abgebrochener Lauf darf keine
  // halbe Konfigurationsdatei hinterlassen – der Core kaeme damit nicht hoch.
  writeFileSync(file + ".tmp", JSON.stringify(config, null, 2) + "\n");
  renameSync(file + ".tmp", file);
' "$CONFIG" "$ROTATION" || { echo "Konfiguration liess sich nicht aendern: $CONFIG" >&2; exit 1; }

chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG"
chmod 600 "$CONFIG"

# Der Core haelt die Konfiguration im Speicher und schreibt sie bei der
# naechsten Aenderung zurueck. Ohne Neustart waere die Drehung also nicht nur
# unwirksam, sondern demnaechst auch wieder aus der Datei verschwunden.
if systemctl is-active --quiet mirror-core.service; then
  systemctl restart mirror-core.service
  echo "Anzeige auf ${ROTATION}° gedreht."
else
  echo "Drehung auf ${ROTATION}° eingetragen – sie greift, sobald der Core startet."
fi
