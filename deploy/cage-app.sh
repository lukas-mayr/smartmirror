#!/usr/bin/env bash
#
# Laeuft innerhalb von cage und startet zwei Dinge: den Startbildschirm und
# danach die Anzeige.
#
# Warum ueberhaupt ein zweites Skript: der Startbildschirm ist ein
# Wayland-Client und kann sich erst anmelden, wenn der Compositor steht. cage
# startet genau ein Programm, sobald es soweit ist - das hier. Alles, was der
# Startbildschirm braucht, steht in der Umgebung; die Anzeige und ihre Schalter
# kommen als Argumente, damit sie dort stehen bleiben, wo sie hingehoeren
# (cage-session.sh).
#
# Kein `set -e`. Was hier auch schiefgeht: die Anzeige muss starten. Sie ist
# der Zweck des Geraets, der Startbildschirm ist die Verschoenerung von acht
# Sekunden. Deshalb ist jeder Schritt davor einzeln abgesichert und der letzte
# ein `exec`, das ohne Bedingung kommt.
set -uo pipefail

starte_startbild() {
  [[ -n "${MIRROR_SPLASH_SKRIPT:-}" && -f "${MIRROR_SPLASH_SKRIPT}" ]] || return 0
  command -v python3 >/dev/null 2>&1 || {
    echo "Kein python3 - der Startbildschirm bleibt aus." >&2
    return 0
  }

  python3 "$MIRROR_SPLASH_SKRIPT" "$MIRROR_SPLASH_DIR" "${MIRROR_SPLASH_ROTATION:-0}" &
  # Die Anzeige beendet ihn, sobald ihr erstes Bild steht - sie findet ihn
  # ueber diese Nummer. Kommt sie nicht dazu, beendet er sich selbst.
  export MIRROR_SPLASH_PID=$!
}

starte_startbild

exec "$@"
