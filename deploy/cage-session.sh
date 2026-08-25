#!/usr/bin/env bash
#
# Startet die Anzeige-Anwendung unter dem Compositor `cage`.
#
# cage stellt genau ein Fenster im Vollbild dar und beendet sich, wenn die
# Anwendung endet – dann startet systemd beide zusammen neu. Ein Desktop wird
# nirgends gestartet.
set -euo pipefail

APP="/opt/smartmirror/current/shell/smartmirror-shell"

if [[ ! -x "$APP" ]]; then
  echo "Anzeige-Anwendung nicht gefunden: $APP" >&2
  exit 1
fi

# Nicht auf den Core warten.
#
# Hier stand eine Schleife, die bis zu 30 Sekunden auf /healthz wartete, damit
# der Spiegel beim Booten nicht kurz "keine Verbindung" zeigt. Genau diese halbe
# Minute war aber das Fenster, in dem stattdessen die Textkonsole zu sehen war:
# Kernel-Meldungen und die Anmeldeaufforderung, hinter halbdurchlaessigem Glas
# das Auffaelligste am ganzen Geraet.
#
# Jetzt geht die Anzeige sofort auf und deckt den Bildschirm mit ihrem eigenen
# Startbildschirm ab, bis der erste Schnappschuss des Cores da ist. Den Hinweis
# blendet sie so lange aus – dass die Verbindung beim Start noch nicht steht,
# ist kein Fehler, sondern die Reihenfolge.

# Kein Mauszeiger, auch nicht in den Sekunden vor dem ersten Bild.
#
# Zwischen dem Ende von Plymouth und dem ersten Bild von Electron ist cage
# allein auf dem Bildschirm: es hat noch keine Fensterflaeche zu zeichnen, aber
# einen Zeiger, den es aus dem Cursor-Thema des Systems laedt und mitten auf das
# Schwarz setzt. Hinter halbdurchlaessigem Glas ist ein weisser Pfeil das
# Auffaelligste, was dort passieren kann.
#
# `cursor: none` im Stylesheet greift dort noch nicht – es gibt die Anzeige ja
# noch nicht –, und einen Schalter zum Ausblenden hat cage nicht. Also bekommt
# es ein Thema untergeschoben, in dem jeder Zeiger aus lauter durchsichtigen
# Bildpunkten besteht (erzeugt von scripts/generate-cursor.mjs).
#
# XCURSOR_PATH ersetzt den Suchpfad vollstaendig, damit nicht doch eines der
# Themen des Systems gefunden wird. "default" ist der Name, unter dem wlroots
# sucht, wenn ihm keiner genannt wurde.
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$HIER/cursor/default/cursors" ]]; then
  export XCURSOR_PATH="$HIER/cursor"
  export XCURSOR_THEME=default
  export XCURSOR_SIZE=24
else
  echo "Kein Zeiger-Thema unter $HIER/cursor – vor dem ersten Bild kann kurz ein Pfeil stehen." >&2
fi

# Das Vorwaermen ist wieder draussen. Gemessen, nicht vermutet.
#
# Hier stand ein Versuch, das schwarze Fenster zwischen Plymouth und dem ersten
# Bild von Electron zu verkuerzen: die Anwendung am Stueck von der Karte lesen,
# solange das Wortzeichen noch steht, damit Electron sie danach im Speicher
# findet. Die Annahme dahinter - am Stueck gelesen gehe dieselbe Datenmenge um
# ein Vielfaches schneller - stimmt auf der Karte dieses Geraets nicht: sie
# liefert knapp 5 MB/s, ob am Stueck oder nicht.
#
# Drei Starts, aus dem Journal:
#
#   nichts vorgewaermt          ~15 s schwarz
#   Programm (169 MB, 35 s)     10,0 s schwarz
#   dazu die kleinen Dateien
#   (218 MB, 40 s)              10,5 s schwarz
#
# Der zweite Schritt kostete fuenf Sekunden mehr und brachte nichts, und von
# den 10,5 Sekunden gehen nur 2,0 auf Electron: so lange braucht es vom Start
# des Prozesses bis zum ersten Bild. Die uebrigen achteinhalb liegen davor -
# zwischen dem Start von `cage` und dem Moment, in dem Electron ueberhaupt
# laeuft. Das ist kein Lesen mehr, das sind der Compositor und Chromiums
# eigener Start, und daran aendert ein voller Dateisystem-Cache nichts.
#
# Also weg damit: vierzig Sekunden laengerer Start fuer nichts. Was das Fenster
# wirklich zudeckt, muss darin zeichnen - dafuer gibt es nur einen Weg, und der
# heisst Wayland-Client unter cage.

# Bewusst ohne zusaetzliche cage-Optionen.
#
# Die Optionsnamen haben sich zwischen cage-Versionen geaendert, und eine
# unbekannte Option laesst cage sofort beenden – auf einem Spiegel ohne
# Tastatur heisst das: schwarzer Bildschirm ohne Hinweis. Gebraucht wird hier
# ohnehin keine: VT-Umschaltung braucht ein Geraet ohne Tastatur nicht, und den
# Mauszeiger nimmt das Thema oben weg.
# Die eine Zeile, an der sich das schwarze Fenster messen laesst.
#
# Ab hier hat der Compositor den Bildschirm und die Anzeige noch kein Fenster.
# Zusammen mit "[shell] erstes Bild nach ... s" aus dem Hauptprozess steht damit
# in `journalctl -u mirror-shell`, wie lange es auf diesem Geraet wirklich
# dauert - und nicht, wie lange es dauern sollte.
echo "cage startet die Anzeige."

exec cage -- "$APP" \
  --ozone-platform=wayland \
  --enable-features=UseOzonePlatform \
  --disable-features=Translate,MediaRouter \
  --disable-pinch \
  --overscroll-history-navigation=0
