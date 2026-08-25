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
# Der Startbildschirm fuer die Sekunden, die cage allein auf dem Bildschirm ist.
#
# Bemalen kann dieses Fenster nur ein Wayland-Client - Plymouth hat die
# Grafikausgabe da schon abgegeben, und die Anzeige ist das, worauf gewartet
# wird. Also laeuft unter cage zuerst ein kleines Programm, das dasselbe Bild
# zeichnet wie Plymouth davor und die Anzeige danach (deploy/cage-splash.py).
#
# Gestartet wird es nicht hier, sondern in cage-app.sh: ein Client kann sich
# erst anmelden, wenn der Compositor steht, und das ist genau der Augenblick,
# in dem cage dieses Skript aufruft.
#
# Welche Drehung, entscheidet dieselbe Einstellung wie beim Rest der Anzeige.
# Faellt das Lesen aus - keine Datei, kein node, kaputtes JSON -, ist 0 die
# richtige Annahme: ein quer haengender Spiegel ist der Normalfall.
lies_drehung() {
  local config="${MIRROR_DATA_DIR:-/opt/smartmirror/data}/config.json"
  [[ -f "$config" ]] || { printf '0'; return; }
  node -e '
    try {
      const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const rotation = Number(config.display?.rotation ?? 0);
      process.stdout.write([0, 90, 180, 270].includes(rotation) ? String(rotation) : "0");
    } catch { process.stdout.write("0"); }
  ' "$config" 2>/dev/null || printf '0'
}

DREHUNG="$(lies_drehung)"
if [[ -f "$HIER/cage-splash.py" && -f "$HIER/plymouth/mark-$DREHUNG.png" ]]; then
  export MIRROR_SPLASH_SKRIPT="$HIER/cage-splash.py"
  export MIRROR_SPLASH_DIR="$HIER/plymouth"
  export MIRROR_SPLASH_ROTATION="$DREHUNG"
else
  echo "Kein Startbild fuer Drehung $DREHUNG - die Sekunden vor dem ersten Bild bleiben schwarz." >&2
fi

# Und was cage beim letzten Mal gelesen hat, jetzt schon einmal holen.
#
# Vom Aufruf von cage bis zu seinem ersten Client vergehen auf dem Geraet 5,4
# Sekunden. Das sind die einzigen, die noch schwarz sind: davor haelt Plymouth
# das Bild, danach der Startbildschirm. Headless und mit warmem Cache braucht
# cage 0,02 Sekunden - der Unterschied ist die Grafik-Hardware und eine Karte,
# die knapp 5 MB/s liefert.
#
# Fuer die Anzeige war Vorwaermen ein Irrweg: 40 Sekunden Lesen fuer 5 Sekunden
# weniger Schwarz, und seit es den Startbildschirm gibt, liegt ihre Wartezeit
# ohnehin unter dem Wortzeichen. Hier ist es umgekehrt. Es geht um die einzige
# Luecke, die noch schwarz ist, und gelesen wird nicht auf Verdacht, sondern
# genau das, was cage beim letzten Start selbst angefasst hat (aufgeschrieben
# von cage-app.sh). Waehrenddessen steht noch das Bild von Plymouth.
#
# Ob es hilft, sagt das Journal: die Zeile hier, die Zeile "cage startet die
# Anzeige" und "Startbild steht nach ... ms" stehen unmittelbar hintereinander.
# Bringt es nichts, war die Zeit nicht das Lesen - dann gehoert das hier wieder
# heraus, wie beim ersten Mal.
LISTE="${MIRROR_DATA_DIR:-/opt/smartmirror/data}/cage-vorwaermliste"
CAGE_MB="${MIRROR_CAGE_PREWARM_MB:-160}"
CAGE_S="${MIRROR_CAGE_PREWARM_S:-15}"

waerme_cage_vor() {
  [[ "${MIRROR_CAGE_PREWARM:-1}" == '1' ]] || return 0
  [[ -s "$LISTE" ]] || return 0

  local budget=$(( CAGE_MB * 1024 * 1024 ))
  local gelesen=0 dateien=0 groesse datei
  local beginn=$SECONDS

  while IFS= read -r datei; do
    (( gelesen < budget )) || break
    (( SECONDS - beginn < CAGE_S )) || break
    [[ -f "$datei" ]] || continue
    groesse="$(stat -c %s "$datei" 2>/dev/null || echo 0)"
    (( groesse > 0 )) || continue
    cat "$datei" > /dev/null 2>&1 || true
    gelesen=$(( gelesen + groesse ))
    dateien=$(( dateien + 1 ))
  done < "$LISTE"

  echo "cage vorgewaermt: $dateien Dateien, $(( gelesen / 1024 / 1024 )) MB in $(( SECONDS - beginn )) s."
}

waerme_cage_vor

# Die eine Zeile, an der sich das schwarze Fenster messen laesst.
#
# Ab hier hat der Compositor den Bildschirm und die Anzeige noch kein Fenster.
# Zusammen mit "[shell] erstes Bild nach ... s" aus dem Hauptprozess steht damit
# in `journalctl -u mirror-shell`, wie lange es auf diesem Geraet wirklich
# dauert - und nicht, wie lange es dauern sollte.
echo "cage startet die Anzeige."

# Ueber cage-app.sh und nicht direkt: dort wird der Startbildschirm gestartet,
# bevor die Anzeige uebernimmt. Ueber /bin/bash aufgerufen und nicht direkt, weil
# das Ausfuehrungsrecht am Skript daran haengt, wie das Archiv entpackt wurde -
# dieselbe Ueberlegung wie bei mirror-guard.service.
exec cage -- /bin/bash "$HIER/cage-app.sh" "$APP" \
  --ozone-platform=wayland \
  --enable-features=UseOzonePlatform \
  --disable-features=Translate,MediaRouter \
  --disable-pinch \
  --overscroll-history-navigation=0
