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

merke_was_cage_gelesen_hat() {
  # Was `cage` beim Start von der Karte liest, weiss nur `cage` selbst.
  #
  # Auf dem Geraet vergehen zwischen dem Aufruf von cage und diesem Skript
  # 5,4 Sekunden - die einzigen, die noch schwarz sind, denn vorher kann sich
  # kein Client anmelden. Headless und mit warmem Cache sind es 0,02: der
  # Unterschied ist die Grafik-Hardware und eine Karte, die knapp 5 MB/s
  # liefert. Also wlroots, Mesa, libEGL, seitenweise von der Karte.
  #
  # Vorwaermen kann das nur, wer die Liste kennt - und die steht hier: dieses
  # Skript ist das erste, was cage aufruft, sein Elternprozess *ist* cage, und
  # dessen Speicherabbild nennt jede Datei, die er dafuer gebraucht hat.
  # Aufgeschrieben fuer den naechsten Start; cage-session.sh liest sie dann,
  # bevor es cage aufruft - und bis dahin steht noch das Wortzeichen von
  # Plymouth.
  #
  # Gelernt statt geraten: kein fest eingetragener Mesa-Pfad, der sich mit der
  # naechsten Version des Systems verschiebt, und nichts, was cage gar nicht
  # anfasst.
  local verzeichnis="${MIRROR_DATA_DIR:-/opt/smartmirror/data}"
  local liste="$verzeichnis/cage-vorwaermliste"
  [[ -d "$verzeichnis" && -w "$verzeichnis" ]] || return 0

  awk '$6 ~ /^\// && $6 !~ /^\/(dev|proc|sys|run)\// && $0 !~ /deleted/ { print $6 }' \
    "/proc/$PPID/maps" 2>/dev/null | sort -u > "$liste.neu" 2>/dev/null || return 0

  # Nur ersetzen, wenn wirklich etwas drinsteht: eine leere Liste waere
  # schlechter als die alte.
  if [[ -s "$liste.neu" ]]; then
    mv -f "$liste.neu" "$liste" 2>/dev/null || rm -f "$liste.neu"
  else
    rm -f "$liste.neu"
  fi
}

starte_startbild
merke_was_cage_gelesen_hat

exec "$@"
