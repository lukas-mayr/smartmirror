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

# Vor dem Compositor: die Anzeige von der Karte in den Speicher holen.
#
# Was beim Start zu sehen ist, haengt an einer Reihenfolge. Plymouth zeichnet
# das Wortzeichen; `plymouth quit --retain-splash` laesst das letzte Bild
# stehen, und es bleibt stehen, bis `cage` die Grafikausgabe uebernimmt und
# seine schwarze Flaeche darueberlegt. Danach dauert es, bis Electron sein
# erstes Bild hat - das ist der Zeitraum, in dem hier frueher der Mauszeiger
# stand und der jetzt schwarz ist.
#
# Bemalen laesst er sich nicht: innerhalb von `cage` kann nur ein
# Wayland-Client zeichnen, und der einzige, den der Spiegel hat, ist die
# Anzeige selbst - also genau das, worauf gewartet wird. Was sich aendern
# laesst, ist seine Laenge.
#
# Der groesste Teil davon ist kein Rechnen, sondern Lesen. Die Anwendung ist
# ein knapp 200 MB grosses Programm, und Electron holt es sich beim Start
# seitenweise von der SD-Karte, in der Reihenfolge, in der die Seiten gebraucht
# werden - fuer eine Karte der unguenstigste Fall. Am Stueck gelesen geht
# dieselbe Datenmenge um ein Vielfaches schneller.
#
# Also wird sie hier am Stueck gelesen, bevor `cage` startet. Der Inhalt landet
# im Dateisystem-Cache des Kernels, und Electron findet ihn spaeter im Speicher
# statt auf der Karte. Die Wartezeit verschwindet dadurch nicht, sie wandert:
# aus dem schwarzen Fenster hinter `cage` in die Zeit davor, in der noch das
# Wortzeichen steht. Auf dem Bildschirm sieht das aus, als stuende das Logo
# laenger und das Schwarz kuerzer - und darum geht es.
#
# Ist der Cache schon warm - Neustart der Anzeige im laufenden Betrieb,
# Wiederanlauf nach einem Absturz -, liest der Kernel aus dem Speicher und ist
# in unter einer Sekunde durch. Wer es abschalten will: MIRROR_PREWARM=0.
# Die Reihenfolge kommt vom Geraet, nicht aus der Vermutung.
#
# Gemessen auf dem Spiegel (journalctl -u mirror-shell): die Karte liefert am
# Stueck knapp 5 MB/s. Das grosse Programm allein - 169 MB - dauert damit
# 35 Sekunden, und danach war die Frist um, bevor auch nur eine der kleinen
# Dateien an der Reihe war. Electron holte sie sich anschliessend selbst von der
# Karte: die zehn Sekunden Schwarz, die uebrig blieben, waren zum grossen Teil
# genau das.
#
# Deshalb jetzt umgekehrt: erst die kleinen Dateien, die Electron beim Start
# vollstaendig braucht (Bibliotheken, V8-Schnappschuss, Ressourcenpakete,
# Zeichensatztabellen, App-Archiv - zusammen ein paar Dutzend MB), und das grosse
# Programm ganz zuletzt. Von dem liest Electron beim Start ohnehin nur einen
# Bruchteil; es vollstaendig zu lesen kostete mehr Zeit, als es sparte.
#
# Nicht dabei: locales/ (Electron laedt daraus genau eine Datei) und alles
# Uebrige im Verzeichnis. Der Cache ist kein Selbstzweck - jede Seite, die hier
# hineingelesen wird, verdraengt auf einem Pi mit wenig Speicher eine andere.
BUDGET_MB="${MIRROR_PREWARM_BUDGET_MB:-320}"
FRIST_S="${MIRROR_PREWARM_SECONDS:-25}"

vorwaermen() {
  if [[ "${MIRROR_PREWARM:-1}" != '1' ]]; then
    echo "Vorwaermen abgeschaltet (MIRROR_PREWARM=$MIRROR_PREWARM)."
    return 0
  fi

  local verzeichnis
  verzeichnis="$(dirname "$APP")"

  local -a kandidaten=()
  local muster
  for muster in "$verzeichnis"/*.so "$verzeichnis"/*.so.* "$verzeichnis"/*.bin \
    "$verzeichnis"/*.pak "$verzeichnis"/*.dat "$verzeichnis"/resources/*.asar; do
    # Ein Glob ohne Treffer bleibt als Text stehen - deshalb jede Datei pruefen.
    [[ -f "$muster" ]] && kandidaten+=("$muster")
  done
  # Zuletzt das Programm selbst: das groesste Stueck und das einzige, von dem
  # sich auch ein Teil lohnt.
  kandidaten+=("$APP")

  local budget=$(( BUDGET_MB * 1024 * 1024 ))
  local gelesen=0 dateien=0 groesse datei verstrichen rate
  local beginn=$SECONDS

  for datei in "${kandidaten[@]}"; do
    verstrichen=$(( SECONDS - beginn ))
    (( gelesen < budget )) || { echo "Vorwaermen: ${BUDGET_MB} MB gelesen, das reicht."; break; }
    (( verstrichen < FRIST_S )) || { echo "Vorwaermen: Zeit ist um."; break; }
    groesse="$(stat -c %s "$datei" 2>/dev/null || echo 0)"
    (( groesse > 0 )) || continue

    # Vorher rechnen, statt hinterher abzubrechen.
    #
    # Wie schnell die Karte liest, weiss vorher niemand: zwischen einer alten
    # SD-Karte und einer SSD am USB-Anschluss liegt der Faktor zwanzig. Also
    # wird an den schon gelesenen Dateien gemessen, was diese Karte kann, und
    # daran entschieden, ob die naechste in die verbleibende Frist passt. Was
    # nicht passt, holt sich Electron eben selbst - das kostet dann genau die
    # Zeit, die es hier auch gekostet haette, nur ohne den Umweg.
    if (( gelesen > 0 && verstrichen > 0 )); then
      rate=$(( gelesen / verstrichen ))
      if (( rate > 0 && groesse / rate > FRIST_S - verstrichen )); then
        echo "Vorwaermen: $(basename "$datei") uebersprungen - $(( groesse / rate )) s bei $(( rate / 1024 / 1024 )) MB/s."
        continue
      fi
    fi

    # Lesen und wegwerfen: es geht nur darum, dass der Kernel die Seiten haelt.
    # Die Frist ist ein Notnagel und keine Zusicherung - ein Lesevorgang, der in
    # der Karte steckt, laesst sich nicht abbrechen (der Prozess haengt im
    # Kernel und nimmt kein Signal an). Die eigentliche Bremse ist die Rechnung
    # oben.
    if command -v timeout >/dev/null 2>&1; then
      timeout "$(( FRIST_S > verstrichen ? FRIST_S - verstrichen : 5 ))" cat "$datei" > /dev/null 2>&1 || true
    else
      cat "$datei" > /dev/null 2>&1 || true
    fi
    gelesen=$(( gelesen + groesse ))
    dateien=$(( dateien + 1 ))
  done

  verstrichen=$(( SECONDS - beginn ))
  echo "Vorgewaermt: $dateien Dateien, $(( gelesen / 1024 / 1024 )) MB in ${verstrichen} s."
}

vorwaermen

# Bewusst ohne zusaetzliche cage-Optionen.
#
# Die Optionsnamen haben sich zwischen cage-Versionen geaendert, und eine
# unbekannte Option laesst cage sofort beenden – auf einem Spiegel ohne
# Tastatur heisst das: schwarzer Bildschirm ohne Hinweis. Gebraucht wird hier
# ohnehin keine: VT-Umschaltung braucht ein Geraet ohne Tastatur nicht, und den
# Mauszeiger nimmt das Thema oben weg.
exec cage -- "$APP" \
  --ozone-platform=wayland \
  --enable-features=UseOzonePlatform \
  --disable-features=Translate,MediaRouter \
  --disable-pinch \
  --overscroll-history-navigation=0
