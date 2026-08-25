#!/usr/bin/env bash
#
# Prueft beim Booten, ob das installierte Release startfaehig ist, und faellt
# sonst auf das vorige zurueck.
#
# Ein Spiegel wird nicht heruntergefahren, sondern ausgesteckt. Trifft das den
# Moment kurz nach einem Update, stehen im neuen Release Dateien mit Groesse 0:
# angelegt, aber nie auf die Karte geschrieben. Der Core endet dann wortlos
# (node auf einer leeren Datei ist ein Programm ohne Inhalt), die Anzeige
# scheitert mit "Exec format error", und systemd startet beide im Sekundentakt
# neu - beobachtet: 167 Versuche, ohne dass irgendetwas den Zustand aufloest.
#
# Genau dafuer liegt das vorige Release noch da. Der Rueckfall passiert hier
# und nicht im Updater, weil der Updater aus demselben kaputten Verzeichnis
# gestartet wuerde.
#
# Absichtlich Bash und absichtlich ausserhalb von current/: Dieses Skript muss
# genau dann funktionieren, wenn das Release es nicht mehr tut.
set -uo pipefail

ROOT="${MIRROR_INSTALL_ROOT:-/opt/smartmirror}"
CURRENT="$ROOT/current"
PREVIOUS="$ROOT/previous"

# Die Einstiegspunkte, ohne die nichts laeuft. Keiner davon ist jemals leer
# gueltig - das macht "leer" zu einem verlaesslichen Zeichen fuer Schaden.
PFLICHT=(VERSION core/index.mjs updater/index.mjs deploy/cage-session.sh)

version_von() {
  local dir="$1"
  [[ -s "$dir/VERSION" ]] && tr -d '\n' < "$dir/VERSION" || echo "unbekannt"
}

brauchbar() {
  local dir="$1" datei
  [[ -n "$dir" && -d "$dir" ]] || return 1
  for datei in "${PFLICHT[@]}"; do
    if [[ ! -s "$dir/$datei" ]]; then
      echo "  $datei fehlt oder ist leer"
      return 1
    fi
  done
  # Ein Bundle ohne Anzeige ist erlaubt (Server-only-Build). Eine Anzeige der
  # Groesse 0 ist es nicht.
  local anzeige="$dir/shell/smartmirror-shell"
  if [[ -e "$anzeige" && ! -s "$anzeige" ]]; then
    echo "  shell/smartmirror-shell ist leer"
    return 1
  fi
  # Dasselbe fuer das Skript, das unter cage die Anzeige startet: gibt es das
  # als leere Datei, startet cage ein Programm ohne Inhalt und der Bildschirm
  # bleibt schwarz. Geprueft wird es nur, wenn es da ist - aeltere Releases
  # kannten es nicht, und auf die faellt dieses Skript im Zweifel zurueck.
  local starter="$dir/deploy/cage-app.sh"
  if [[ -e "$starter" && ! -s "$starter" ]]; then
    echo "  deploy/cage-app.sh ist leer"
    return 1
  fi
  return 0
}

ziel="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if brauchbar "$ziel"; then
  echo "Release $(version_von "$ziel") ist vollstaendig."
  exit 0
fi

echo "Installiertes Release ist unbrauchbar: ${ziel:-kein current-Symlink}"

rueckfall="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
if [[ -z "$rueckfall" || "$rueckfall" == "$ziel" ]] || ! brauchbar "$rueckfall"; then
  # Nicht mit Fehler enden: die Dienste sollen es trotzdem versuchen. Vielleicht
  # fehlt nur der Updater, und der Spiegel zeigt wenigstens die Uhrzeit.
  echo "Kein brauchbares voriges Release - hier hilft nur eine Neuinstallation." >&2
  exit 0
fi

echo "Falle zurueck auf Release $(version_von "$rueckfall")."

# Erst danebenlegen, dann drueberschieben - dazwischen gibt es keinen Moment
# ohne current. "mv -T" ersetzt den Symlink selbst; ohne -T wuerde mv den neuen
# Link in das Verzeichnis hineinschieben, auf das current zeigt. Das -T kennt
# nur GNU coreutils, also mit Rueckfallebene: ein kurzer Moment ohne current
# ist immer noch besser als ein Spiegel, der nicht startet.
if ! ln -sfn "$rueckfall" "$ROOT/current.new" 2>/dev/null \
  || ! mv -T "$ROOT/current.new" "$CURRENT" 2>/dev/null; then
  rm -f "$ROOT/current.new"
  ln -sfn "$rueckfall" "$CURRENT"
fi

# Nachsehen statt hoffen. Ein Rueckfall, der stillschweigend nicht stattgefunden
# hat, waere schlimmer als gar keiner: im Journal staende Entwarnung, waehrend
# der Spiegel weiter im Kreis startet.
if [[ "$(readlink -f "$CURRENT" 2>/dev/null || true)" != "$rueckfall" ]]; then
  echo "Rueckfall fehlgeschlagen - current zeigt weiter auf ${ziel:-nichts}." >&2
  exit 0
fi

# Der Rueckfall muss den naechsten Stromausfall ueberleben - sonst steht beim
# uebernaechsten Start wieder derselbe kaputte Symlink da.
sync
echo "Der Spiegel startet jetzt mit $(version_von "$rueckfall")."
