#!/usr/bin/env bash
#
# Fuehrt einen Neustart aus, den die Handy-App angefordert hat.
#
# Gestartet von mirror-system.service, sobald mirror-system.path die
# Auftragsdatei sieht. Der Core schreibt sie – er laeuft unprivilegiert und
# kann weder Dienste neu starten noch das Geraet booten.
#
# Bewusst so klein: das hier ist der Teil mit Root-Rechten, der an einem ans
# Netz gebundenen Dienst haengt. Er kennt genau zwei Auftraege und lehnt alles
# andere ab.
set -euo pipefail

DATA_DIR="${MIRROR_DATA_DIR:-/opt/smartmirror/data}"
REQUEST="$DATA_DIR/system-request.json"

# Wie lange ein Auftrag gilt.
#
# Das ist kein Feinschliff, sondern verhindert eine Schleife: faellt zwischen
# dem Schreiben und dem Ausfuehren der Strom aus – beim Spiegel der uebliche
# Weg auszuschalten –, liegt die Datei beim naechsten Start noch da, und die
# Path-Unit loest sofort wieder aus. Ohne diese Grenze wuerde sich das Geraet
# beim Booten endlos selbst neu starten.
MAX_AGE_SECONDS=120

log() { printf 'mirror-system: %s\n' "$*"; }

[[ -f "$REQUEST" ]] || { log "Kein Auftrag vorhanden."; exit 0; }

# Erst lesen, dann sofort loeschen – vor dem Ausfuehren.
#
# Die Reihenfolge ist der ganze Punkt: `systemctl reboot` kommt nie zurueck.
# Bliebe die Datei liegen, faende die Path-Unit sie nach dem Booten wieder vor.
# Und weil PathExists auf die blosse Existenz schaut, schaerft das Loeschen
# zugleich den Ausloeser fuer das naechste Mal.
PAYLOAD="$(cat "$REQUEST")"
rm -f "$REQUEST"

# Mit node lesen und nicht mit grep: node liegt ohnehin auf dem Geraet, und
# eine kaputte Datei soll hier enden und nicht in einem falsch erratenen Wort.
#
# Zwei Zeilen und nicht zwei Felder einer Zeile: ein Auftrag koennte "rm -rf /"
# heissen. Bei einer Trennung am Leerzeichen landete davon "rm" im Auftrag und
# "-rf" im Zeitstempel – und das Skript stuerzte in der Rechnung darunter ab,
# statt sauber abzulehnen.
#
# node prueft dabei nur die *Form* des Auftragsworts, nicht seine Bedeutung:
# alles, was kein einfaches Kleinbuchstaben-Wort ist, wird zu "-". Welche
# Woerter tatsaechlich etwas ausloesen, entscheidet allein das case unten –
# eine Stelle, nicht zwei.
{ read -r REQUESTED_AT || true; read -r ACTION || true; } <<EOF
$(node -e '
  try {
    const request = JSON.parse(process.argv[1]);
    const millis = Date.parse(request.requestedAt);
    const action = typeof request.action === "string" && /^[a-z][a-z-]*$/.test(request.action)
      ? request.action
      : "-";
    process.stdout.write(`${Number.isFinite(millis) ? Math.round(millis / 1000) : "-"}\n${action}\n`);
  } catch {
    process.stdout.write("-\n-\n");
  }
' "$PAYLOAD" 2>/dev/null || printf -- '-\n-\n')
EOF

ACTION="${ACTION:--}"
REQUESTED_AT="${REQUESTED_AT:--}"

if [[ "$ACTION" == '-' || "$REQUESTED_AT" == '-' ]]; then
  log "Auftrag unlesbar oder ohne brauchbaren Zeitstempel – verworfen."
  exit 0
fi

AGE=$(( $(date +%s) - REQUESTED_AT ))

if (( AGE > MAX_AGE_SECONDS )); then
  log "Auftrag ist ${AGE}s alt – verworfen (Grenze: ${MAX_AGE_SECONDS}s)."
  exit 0
fi

# Auch nach vorn begrenzen. Ein Pi hat keine gepufferte Uhr: nach einem
# Stromausfall steht sie zunaechst falsch und springt erst, wenn das Netzwerk
# steht. Genau in diesem Fenster laeuft die Path-Unit — ein Auftrag, der von
# dort aus in der Zukunft liegt, ist keiner, dem zu folgen waere.
if (( AGE < -MAX_AGE_SECONDS )); then
  log "Auftrag liegt $(( -AGE ))s in der Zukunft – verworfen. Geht die Uhr des Spiegels falsch?"
  exit 0
fi

case "$ACTION" in
  restart-services)
    log "Core und Anzeige werden neu gestartet."
    # Ohne --no-block: der Aufruf soll erst zurueckkommen, wenn beide stehen.
    # mirror-core.service zuerst, damit die Anzeige nicht in einen Core startet,
    # der noch herunterfaehrt.
    systemctl restart mirror-core.service mirror-shell.service
    log "Dienste laufen wieder."
    ;;
  reboot)
    log "Geraet wird neu gestartet."
    # --no-block, weil systemd sonst darauf wartet, dass dieser Dienst endet –
    # und dieser Dienst darauf, dass der Neustart beginnt.
    systemctl --no-block reboot
    ;;
  *)
    log "Unbekannter Auftrag \"$ACTION\" – nichts getan."
    ;;
esac
