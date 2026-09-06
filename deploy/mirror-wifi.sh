#!/usr/bin/env bash
#
# Verwaltet das WLAN des Spiegels: suchen, verbinden, vergessen – und, wenn gar
# nichts mehr geht, ein eigenes WLAN aufmachen, ueber das die Handy-App noch
# erreichbar ist.
#
# Gestartet von mirror-wifi.service, sobald mirror-wifi.path die Auftragsdatei
# sieht, und ausserdem alle 30 Sekunden vom Timer. Der Core schreibt den
# Auftrag – er laeuft unprivilegiert und kann kein Netz schalten.
#
# Der Timer ist hier nicht nur Rueckfallebene wie bei mirror-system.sh: dieses
# Skript hat eine zweite Aufgabe, die niemand anstoesst. Es sieht bei jedem
# Lauf nach, ob der Spiegel ueberhaupt noch irgendwo hinkommt, und macht sonst
# nach ein paar Minuten das Einrichtungs-WLAN auf. Genau dafuer gibt es das
# Ganze: ein Spiegel ohne Netz kann seine eigene App nicht mehr ausliefern, und
# an der Wand haengt weder Tastatur noch Kabel.
#
# Was hier passiert, passiert als root. Deshalb dieselbe Strenge wie beim
# Neustart-Dienst: der Auftrag gilt zwei Minuten, wird vor dem Ausfuehren
# geloescht, und was kein bekanntes Auftragswort ist, wird abgelehnt.
set -euo pipefail

INSTALL_ROOT="${MIRROR_INSTALL_ROOT:-/opt/smartmirror}"
DATA_DIR="${MIRROR_DATA_DIR:-$INSTALL_ROOT/data}"
SERVICE_USER="${MIRROR_SERVICE_USER:-mirror}"
PROFILE_DIR="${MIRROR_NM_PROFILE_DIR:-/etc/NetworkManager/system-connections}"

REQUEST="$DATA_DIR/wifi-request.json"
STATUS="$DATA_DIR/wifi-status.json"
CONFIG="$DATA_DIR/config.json"
# Wie viele Laeufe in Folge der Spiegel schon nirgends hinkommt. Liegt neben den
# Daten und nicht im Speicher: zwischen zwei Laeufen gibt es kein Skript.
COUNTER="$DATA_DIR/.wifi-offline"

# Wie lange ein Auftrag gilt. Wie bei mirror-system.sh und aus demselben Grund:
# ein Auftrag, der einen Stromausfall ueberlebt hat, ist keiner mehr.
MAX_AGE_SECONDS=120

# Wie lange ohne jede Verbindung, bevor der Spiegel selbst ein WLAN aufmacht.
#
# Vier Laeufe zu 30 Sekunden. Kurz genug, dass niemand ratlos vor der Wand
# steht, und lang genug, dass ein Router, der nach einem Stromausfall selbst
# gerade erst hochfaehrt, nicht als "kein Netz" zaehlt.
OFFLINE_RUNS_BEFORE_HOTSPOT="${MIRROR_WIFI_OFFLINE_RUNS:-4}"

# Adresse des Spiegels im eigenen WLAN. NetworkManager vergibt sie im Modus
# "shared" fest; sie steht so auch in packages/sdk/src/wifi.ts.
HOTSPOT_ADDRESS='10.42.0.1'
HOTSPOT_ID='smartmirror-einrichtung'

log() { printf 'mirror-wifi: %s\n' "$*"; }

# Was zuletzt schiefging. Landet in der Statusdatei und damit in der App.
LAST_ERROR=''
# Zeitstempel des Auftrags, den dieser Lauf beantwortet.
ANSWERED_AT=''
# Rohausgabe des letzten Suchlaufs, oder leer, wenn diesmal nicht gesucht wurde.
SCAN_RAW=''
SCANNED='no'
STATE='unavailable'
ETHERNET='false'
WIFI_DEV=''
HOTSPOT_SSID=''
HOTSPOT_PASS=''

# ------------------------------------------------------------------- nmcli

# Ausgabe des letzten nmcli-Aufrufs, Fehlerkanal eingeschlossen.
NM_OUT=''

nm() {
  # nmcli aufrufen, ohne dass ein Fehlschlag das Skript beendet: fast jeder
  # Aufruf hier darf scheitern, und was dann zu tun ist, entscheidet der
  # Aufrufer und nicht "set -e".
  if NM_OUT="$(nmcli "$@" 2>&1)"; then return 0; fi
  return 1
}

# Terse-Ausgabe ohne Maskierung. Nur fuer Felder, in denen kein Doppelpunkt
# vorkommen kann – Geraetenamen, Zustaende, UUIDs. Fuer Netznamen waere es
# falsch: die duerfen einen enthalten, und dann faellt die Spalte auseinander.
nm_plain() {
  nmcli --terse --escape no "$@" 2>/dev/null || true
}

# Ein einzelnes Feld, unmaskiert. Bei genau einem Feld ist die Ausgabe
# eindeutig, auch wenn ein Doppelpunkt darin steht.
nm_feld() {
  nmcli --get-values "$1" --escape no "${@:2}" 2>/dev/null || true
}

# ----------------------------------------------------------------- Geraete

# Erstes WLAN-Geraet, das NetworkManager verwaltet.
finde_wlan_geraet() {
  nm_plain --fields DEVICE,TYPE,STATE device status \
    | awk -F: '$2=="wifi" && $3!="unmanaged" { print $1; exit }'
}

# Haengt ein Netzwerkkabel, das traegt?
#
# Der Zustand "connected" und nicht der blosse Traeger: ein Kabel in einem
# Switch ohne DHCP traegt zwar, bringt den Spiegel aber nirgendwohin.
kabel_haengt() {
  nm_plain --fields TYPE,STATE device status \
    | awk -F: '$1=="ethernet" && $2=="connected" { found=1 } END { exit found ? 0 : 1 }'
}

# Leere Felder meldet nmcli je nach Fassung als "--". Das ist kein Wert,
# sondern ein Strich – und ein Spiegel, der an einem Netz namens "--" haengt,
# waere in jeder Anzeige darueber verbunden, ohne es zu sein.
ohne_strich() {
  local wert
  wert="$(cat)"
  [[ "$wert" == '--' ]] && return 0
  printf '%s' "$wert"
}

# Name des Profils, das auf dem WLAN-Geraet gerade aktiv ist.
aktives_profil() {
  [[ -n "$WIFI_DEV" ]] || return 0
  nm_feld GENERAL.CONNECTION device show "$WIFI_DEV" | ohne_strich
}

# Der Netzname hinter einem Profil.
#
# Nicht der Profilname: der ist frei waehlbar, und ein von raspi-config
# angelegtes Profil heisst oft anders als das Netz, das es meint.
ssid_von_profil() {
  [[ -n "$1" ]] || return 0
  nm_feld 802-11-wireless.ssid connection show "$1" | ohne_strich
}

# Empfangsstaerke des Netzes, an dem der Spiegel gerade haengt.
signal_jetzt() {
  nm_plain --fields IN-USE,SIGNAL device wifi list \
    | awk -F: '$1=="*" { print $2; exit }'
}

# Alle gespeicherten WLAN-Profile, als UUIDs.
#
# Ueber die UUID und nicht ueber den Namen: die enthaelt garantiert keinen
# Doppelpunkt, ein Netzname darf einen enthalten.
wlan_profile() {
  nm_plain --fields UUID,TYPE connection show \
    | awk -F: '$2=="802-11-wireless" { print $1 }'
}

# ----------------------------------------------------------------- Auftrag

ACTION='-'
REQUESTED_AT='-'
SSID=''
PASSPHRASE=''
HOTSPOT_WUNSCH='off'

# Liest den Auftrag und loescht ihn sofort – vor dem Ausfuehren.
#
# Zweierlei haengt daran. Erstens dasselbe wie beim Neustart: bliebe die Datei
# liegen, faende die Path-Unit sie nach einem Stromausfall wieder vor. Zweitens
# steht in dieser Datei ein WLAN-Passwort. Es soll so kurz wie moeglich auf der
# Karte liegen – und wenn etwas dazwischenkommt, gerade nicht.
lies_auftrag() {
  [[ -f "$REQUEST" ]] || return 0

  local payload
  payload="$(cat "$REQUEST")"
  rm -f "$REQUEST"

  # Gelesen wird mit node und ueber die Standardeingabe.
  #
  # Mit node, weil eine kaputte Datei hier enden soll und nicht in einem falsch
  # erratenen Wort. Ueber die Standardeingabe, weil im Auftrag ein Passwort
  # steht: als Argument stuende es in /proc/<pid>/cmdline und waere fuer jeden
  # lesbar, der auf dem Geraet einen Prozess starten kann.
  #
  # Zurueck kommen sechs Zeilen, Netzname und Passwort davon in base64 – so
  # sprengt kein Zeichen daraus die Aufteilung.
  local parsed
  parsed="$(printf '%s' "$payload" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const b64 = (value) => Buffer.from(String(value ?? ""), "utf8").toString("base64");
      try {
        const request = JSON.parse(raw);
        const millis = Date.parse(request.requestedAt);
        // Geprueft wird hier nur die *Form*: ein einfaches Kleinbuchstaben-Wort.
        // Welches Wort etwas ausloest, entscheidet allein das case weiter unten
        // – eine Stelle und nicht zwei.
        const action = typeof request.action === "string" && /^[a-z][a-z-]*$/.test(request.action)
          ? request.action
          : "-";
        // Steuerzeichen haben in einer Profildatei nichts zu suchen: ein
        // Zeilenumbruch waere dort eine neue Zeile und damit eine neue
        // Einstellung.
        const sauber = (value) =>
          typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
        process.stdout.write([
          Number.isFinite(millis) ? String(Math.round(millis / 1000)) : "-",
          action,
          b64(sauber(request.ssid)),
          b64(sauber(request.passphrase)),
          request.on === true ? "on" : "off",
          // Derselbe Zeitstempel noch einmal, unveraendert.
          //
          // Der Bericht gibt ihn zurueck, und daran erkennt der Core seinen
          // eigenen Auftrag wieder. Ihn aus den Sekunden oben neu zu bauen
          // ginge fast: die Millisekunden fehlten, der Vergleich schluege bei
          // jedem Auftrag fehl, und die App meldete nach anderthalb Minuten
          // "der WLAN-Dienst hat nicht reagiert" – waehrend er laengst
          // verbunden hat.
          Number.isFinite(millis) ? new Date(millis).toISOString() : "",
        ].join("\n") + "\n");
      } catch {
        process.stdout.write("-\n-\n\n\noff\n\n");
      }
    });
  ' 2>/dev/null || printf -- '-\n-\n\n\noff\n')"

  local b64_ssid='' b64_pass='' stempel=''
  {
    read -r REQUESTED_AT || true
    read -r ACTION || true
    read -r b64_ssid || true
    read -r b64_pass || true
    read -r HOTSPOT_WUNSCH || true
    read -r stempel || true
  } <<< "$parsed"

  ACTION="${ACTION:--}"
  REQUESTED_AT="${REQUESTED_AT:--}"
  HOTSPOT_WUNSCH="${HOTSPOT_WUNSCH:-off}"
  SSID="$(printf '%s' "${b64_ssid:-}" | base64 -d 2>/dev/null || true)"
  PASSPHRASE="$(printf '%s' "${b64_pass:-}" | base64 -d 2>/dev/null || true)"

  if [[ "$ACTION" == '-' || "$REQUESTED_AT" == '-' ]]; then
    log 'Auftrag unlesbar oder ohne brauchbaren Zeitstempel – verworfen.'
    ACTION='-'
    return 0
  fi

  local alter
  alter=$(( $(date +%s) - REQUESTED_AT ))
  if (( alter > MAX_AGE_SECONDS )); then
    log "Auftrag ist ${alter}s alt – verworfen (Grenze: ${MAX_AGE_SECONDS}s)."
    ACTION='-'
    return 0
  fi
  # Auch nach vorn begrenzen: ein Pi hat keine gepufferte Uhr, und nach einem
  # Stromausfall steht sie falsch, bis das Netz sie richtet – ausgerechnet das
  # Netz, um das es hier geht.
  if (( alter < -MAX_AGE_SECONDS )); then
    log "Auftrag liegt $(( -alter ))s in der Zukunft – verworfen. Geht die Uhr des Spiegels falsch?"
    ACTION='-'
    return 0
  fi

  ANSWERED_AT="$stempel"
  return 0
}

# ----------------------------------------------------------------- Profile

# Maskiert einen Wert fuer eine NetworkManager-Profildatei.
#
# Das Format ist eine GKeyFile: der Backslash leitet dort eine Escape-Sequenz
# ein, und Leerzeichen am Rand fallen beim Lesen weg. Beides wuerde ein
# Passwort still veraendern – und der Spiegel haenge dann vor einem Netz, das
# ihn nicht hereinlaesst, ohne dass irgendwo stuende warum.
maskiere() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value// /\\s}"
  printf '%s' "$value"
}

# Die Gegenrichtung – zum Lesen des eigenen Hotspot-Profils.
entmaskiere() {
  local value="$1"
  value="${value//\\s/ }"
  value="${value//\\\\/\\}"
  printf '%s' "$value"
}

# Dateiname fuer ein Netz: lesbar, aber eindeutig.
#
# Der Namensteil ist nur fuer den, der spaeter in das Verzeichnis sieht; die
# Eindeutigkeit macht der Hash. Zwei Netze, deren Namen sich nur in Zeichen
# unterscheiden, die ein Dateiname nicht traegt, bekommen so trotzdem zwei
# Profile.
profil_datei() {
  local ssid="$1" slug hash
  slug="$(printf '%s' "$ssid" | tr -c '[:alnum:]._-' '_' | cut -c1-24)"
  hash="$(printf '%s' "$ssid" | sha256sum | cut -c1-8)"
  printf '%s/smartmirror-%s-%s.nmconnection' "$PROFILE_DIR" "$slug" "$hash"
}

neue_uuid() {
  cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%s-%s' "$(date +%s)" "$RANDOM"
}

# UUID des ersten gespeicherten Profils fuer ein Netz, sonst leer.
profil_fuer_netz() {
  local ziel="$1" uuid ssid
  [[ -n "$ziel" ]] || return 0
  while read -r uuid; do
    [[ -n "$uuid" ]] || continue
    ssid="$(nm_feld 802-11-wireless.ssid connection show uuid "$uuid")"
    if [[ "$ssid" == "$ziel" ]]; then
      printf '%s' "$uuid"
      return 0
    fi
  done < <(wlan_profile)
  return 0
}

# Wirft alle gespeicherten Profile fuer ein Netz weg.
vergiss_netz() {
  local ziel="$1" uuid ssid entfernt=0
  [[ -n "$ziel" ]] || return 1
  while read -r uuid; do
    [[ -n "$uuid" ]] || continue
    ssid="$(nm_feld 802-11-wireless.ssid connection show uuid "$uuid")"
    [[ "$ssid" == "$ziel" ]] || continue
    if nm connection delete uuid "$uuid"; then
      entfernt=$(( entfernt + 1 ))
    else
      log "Profil $uuid liess sich nicht loeschen: $NM_OUT"
    fi
  done < <(wlan_profile)
  (( entfernt > 0 ))
}

# Legt das Profil fuer ein Netz an und schaltet es ein.
#
# Geschrieben wird die Profildatei selbst, statt "nmcli device wifi connect …
# password …" aufzurufen. Der Grund ist derselbe wie oben beim Lesen des
# Auftrags: ein Passwort als Kommandozeilenargument steht in /proc und ist
# damit fuer jeden Prozess auf dem Geraet lesbar, und sei es nur fuer die eine
# Sekunde, die der Aufruf dauert. In die Datei kommt es ueber das eingebaute
# printf – das verlaesst den Prozess nicht.
verbinde() {
  local ssid="$1" psk="$2" datei vorhanden

  if [[ -z "$ssid" ]]; then
    LAST_ERROR='Ohne Netznamen laesst sich nichts verbinden.'
    return 1
  fi

  # Ohne Passwort und mit vorhandenem Profil: nur einschalten, nichts anfassen.
  #
  # Das ist der Knopf "Verbinden" an einem gespeicherten Netz. Wuerde auch
  # dieser Fall ein Profil neu schreiben, entstuende daraus ein offenes Netz
  # ohne Schluessel – und ein Spiegel, der sein eigenes WLAN nicht mehr
  # betreten kann, weil jemand auf "Verbinden" getippt hat.
  vorhanden="$(profil_fuer_netz "$ssid")"
  if [[ -z "$psk" && -n "$vorhanden" ]]; then
    hotspot_aus
    log "Verbinde mit \"$ssid\" (gespeichertes Profil) ..."
    if nm --wait 45 connection up uuid "$vorhanden"; then
      log "Verbunden mit \"$ssid\"."
      return 0
    fi
    LAST_ERROR="$(uebersetze_fehler "$NM_OUT")"
    log "Verbindung mit \"$ssid\" fehlgeschlagen: $NM_OUT"
    return 1
  fi

  # Erst wegraeumen, was fuer dasselbe Netz schon da ist. Sonst stuenden nach
  # dem zweiten Anlauf mit neuem Passwort zwei Profile fuer ein Netz, und
  # welches NetworkManager nimmt, entschiede der Zufall.
  vergiss_netz "$ssid" >/dev/null 2>&1 || true

  datei="$(profil_datei "$ssid")"
  mkdir -p "$PROFILE_DIR"

  # Mit umask 077 angelegt: NetworkManager lehnt eine Profildatei ab, die mehr
  # als root lesen darf – und tut das still, mit einer Zeile im Journal.
  (
    umask 077
    {
      printf '[connection]\n'
      printf 'id=%s\n' "$(maskiere "$ssid")"
      printf 'uuid=%s\n' "$(neue_uuid)"
      printf 'type=wifi\n'
      printf 'autoconnect=true\n'
      # Vorrang vor allem, was sonst noch herumliegt: das hier ist das Netz,
      # das gerade jemand von Hand ausgesucht hat.
      printf 'autoconnect-priority=10\n\n'
      printf '[wifi]\n'
      printf 'mode=infrastructure\n'
      printf 'ssid=%s\n\n' "$(maskiere "$ssid")"
      if [[ -n "$psk" ]]; then
        printf '[wifi-security]\n'
        printf 'key-mgmt=wpa-psk\n'
        printf 'psk=%s\n\n' "$(maskiere "$psk")"
      fi
      printf '[ipv4]\nmethod=auto\n\n'
      printf '[ipv6]\nmethod=auto\naddr-gen-mode=default\n'
    } > "$datei"
  )
  chown root:root "$datei" 2>/dev/null || true
  chmod 600 "$datei" 2>/dev/null || true

  nm connection reload || log "Profile liessen sich nicht neu laden: $NM_OUT"

  # Das Einrichtungs-WLAN muss weichen, bevor die Karte in ein anderes Netz
  # geht: sie kann nur eines. Das Handy verliert dabei die Verbindung – genau
  # deshalb kuendigt die App das vorher an.
  hotspot_aus

  log "Verbinde mit \"$ssid\" ..."
  # --wait: zurueckkommen, wenn es steht oder gescheitert ist. Ohne die
  # Wartezeit kaeme der Aufruf sofort zurueck und der Bericht meldete "nicht
  # verbunden", waehrend die Verbindung noch zustande kommt.
  if nm --wait 45 connection up id "$ssid"; then
    log "Verbunden mit \"$ssid\"."
    return 0
  fi

  LAST_ERROR="$(uebersetze_fehler "$NM_OUT")"
  log "Verbindung mit \"$ssid\" fehlgeschlagen: $NM_OUT"
  return 1
}

# Macht aus einer nmcli-Meldung einen Satz, der jemandem vor dem Spiegel hilft.
#
# Nicht aus Hoeflichkeit: die Meldungen sind englisch, und die haeufigste davon
# ("Secrets were required, but not provided") heisst in Wahrheit "das Passwort
# stimmt nicht". Wer das nicht weiss, sucht den Fehler beim Netz.
uebersetze_fehler() {
  local text="$1"
  case "$text" in
    *ecrets*)         printf 'Das Passwort wurde nicht akzeptiert.' ;;
    *imeout*|*imed?out*) printf 'Das Netz hat nicht geantwortet. Ist es in Reichweite?' ;;
    *'not found'*|*'No network with SSID'*) printf 'Dieses Netz ist gerade nicht in Reichweite.' ;;
    '')               printf 'Die Verbindung kam nicht zustande.' ;;
    # Und wenn nichts passt, lieber die Originalmeldung als gar keine: sie
    # steht dann wenigstens in der App und muss nicht im Journal gesucht werden.
    *)                printf '%s' "${text//$'\n'/ }" ;;
  esac
}

# ----------------------------------------------------------------- Hotspot

HOTSPOT_DATEI() { printf '%s/%s.nmconnection' "$PROFILE_DIR" "$HOTSPOT_ID"; }

# Legt das Profil fuer das Einrichtungs-WLAN an, falls es fehlt, und liest
# Name und Passwort ein.
#
# Einmal angelegt und dann nie wieder: beides soll sich nicht bei jedem Lauf
# aendern. Wer es einmal am Handy gespeichert hat, kommt beim naechsten Mal
# ohne Abschreiben wieder herein.
#
# Gelesen wird aus der Datei und nicht ueber nmcli. Es ist unsere eigene Datei
# in einem Format, das wir selbst geschrieben haben – und wenn nmcli gerade
# klemmt, waere die Folge sonst ein neues Passwort fuer ein Netz, dessen altes
# jemand auf dem Handy stehen hat.
hotspot_profil() {
  local datei
  datei="$(HOTSPOT_DATEI)"

  if [[ -f "$datei" ]]; then
    HOTSPOT_SSID="$(entmaskiere "$(sed -n 's/^ssid=//p' "$datei" | head -1)")"
    HOTSPOT_PASS="$(entmaskiere "$(sed -n 's/^psk=//p' "$datei" | head -1)")"
    [[ -n "$HOTSPOT_SSID" ]] && return 0
  fi

  # Ein Namenszusatz aus der Maschinenkennung, damit zwei Spiegel im selben
  # Haus nicht dasselbe Netz aufmachen.
  local suffix
  suffix="$(sha256sum /etc/machine-id 2>/dev/null | cut -c1-4)"
  HOTSPOT_SSID="Smartmirror-${suffix:-setup}"
  # Acht Zeichen ohne l, I, O und 0: das hier wird von einem Bildschirm
  # abgeschrieben, an dem niemand nachfragen kann.
  HOTSPOT_PASS="$(LC_ALL=C tr -dc 'abcdefghijkmnpqrstuvwxyz23456789' < /dev/urandom 2>/dev/null | head -c 8 || true)"
  [[ ${#HOTSPOT_PASS} -eq 8 ]] || HOTSPOT_PASS="spiegel$(date +%S)"

  mkdir -p "$PROFILE_DIR"
  (
    umask 077
    {
      printf '[connection]\n'
      printf 'id=%s\n' "$HOTSPOT_ID"
      printf 'uuid=%s\n' "$(neue_uuid)"
      printf 'type=wifi\n'
      # Niemals von selbst: dieses Netz kommt nur hoch, wenn dieses Skript es
      # ausdruecklich hochbringt. Ein Spiegel, der beim Booten erst einmal ein
      # eigenes WLAN aufmacht, waere jedes Mal ein kleiner Schrecken.
      printf 'autoconnect=false\n\n'
      printf '[wifi]\n'
      printf 'mode=ap\n'
      # 2,4 GHz: weiter reichend und von jedem Handy zu sehen. Hier zaehlt
      # nicht Durchsatz, sondern dass die Einrichtungsseite aufgeht.
      printf 'band=bg\n'
      printf 'ssid=%s\n\n' "$(maskiere "$HOTSPOT_SSID")"
      printf '[wifi-security]\n'
      printf 'key-mgmt=wpa-psk\n'
      printf 'proto=rsn\n'
      printf 'pairwise=ccmp\n'
      printf 'group=ccmp\n'
      printf 'psk=%s\n\n' "$(maskiere "$HOTSPOT_PASS")"
      # "shared" heisst: eigene Adresse, eigener DHCP-Server, eigene
      # Namensaufloesung. Das Handy bekommt damit eine Adresse und findet den
      # Spiegel unter 10.42.0.1, ohne dass irgendein Router mitspielen muss.
      printf '[ipv4]\nmethod=shared\n\n'
      printf '[ipv6]\nmethod=ignore\n'
    } > "$datei"
  )
  chown root:root "$datei" 2>/dev/null || true
  chmod 600 "$datei" 2>/dev/null || true
  nm connection reload || true
  log "Einrichtungs-WLAN angelegt: $HOTSPOT_SSID"
  return 0
}

hotspot_laeuft() {
  [[ "$(aktives_profil)" == "$HOTSPOT_ID" ]]
}

hotspot_an() {
  hotspot_laeuft && return 0
  hotspot_profil

  # Ohne Landeskennung laesst der Funkchip keinen Zugangspunkt zu. Das ist der
  # haeufigste Grund, aus dem ein frisch aufgesetzter Pi kein WLAN aufmacht –
  # und man sieht ihm nichts an ausser einem Netz, das nicht erscheint.
  if command -v iw >/dev/null 2>&1 && iw reg get 2>/dev/null | grep -q 'country 00'; then
    log 'Keine WLAN-Landeskennung gesetzt (country 00) – der Zugangspunkt kann daran scheitern.'
    log 'Setzen mit: sudo raspi-config nonint do_wifi_country CH'
  fi

  log "Einrichtungs-WLAN \"$HOTSPOT_SSID\" wird geoeffnet."
  if nm --wait 30 connection up id "$HOTSPOT_ID"; then
    return 0
  fi
  LAST_ERROR="Das Einrichtungs-WLAN liess sich nicht oeffnen: $(uebersetze_fehler "$NM_OUT")"
  log "$LAST_ERROR"
  return 1
}

hotspot_aus() {
  hotspot_laeuft || return 0
  log 'Einrichtungs-WLAN wird geschlossen.'
  nm connection down id "$HOTSPOT_ID" || true
  return 0
}

# ------------------------------------------------------------------- Suche

# Sucht Netze und legt die Rohausgabe fuer den Bericht beiseite.
#
# Maskiert (also ohne --escape no), weil ein Netzname einen Doppelpunkt
# enthalten darf: aufgeteilt wird die Zeile erst in node, das die Maskierung
# versteht. In bash faellt sie sonst an der falschen Stelle auseinander.
suche_netze() {
  [[ -n "$WIFI_DEV" ]] || return 0

  # Waehrend das Einrichtungs-WLAN laeuft, sendet die Karte selbst – ein
  # Suchlauf wuerde es abschalten und das Handy hinauswerfen. Dann bleibt die
  # Liste aus dem letzten Lauf stehen; genau dafuer wird sie vorher angelegt.
  if hotspot_laeuft; then
    log 'Einrichtungs-WLAN laeuft – die Netzliste bleibt die des letzten Suchlaufs.'
    return 0
  fi

  SCAN_RAW="$(nmcli --terse --fields SSID,SIGNAL,SECURITY device wifi list --rescan yes 2>/dev/null || true)"
  SCANNED='yes'
  return 0
}

# ----------------------------------------------------------------- Zaehler

lies_zaehler() { cat "$COUNTER" 2>/dev/null || printf '0'; }
schreibe_zaehler() { printf '%s' "$1" > "$COUNTER" 2>/dev/null || true; }

# Darf der Spiegel ein Einrichtungs-WLAN aufmachen?
#
# Steht in der Konfiguration des Cores, gelesen wie die Drehung in
# mirror-bootlook.sh. Faellt das Lesen aus, gilt "ja": der Fall, in dem diese
# Frage zaehlt, ist der, in dem niemand mehr an die Einstellung herankommt.
hotspot_erlaubt() {
  [[ -f "$CONFIG" ]] || return 0
  local antwort
  antwort="$(node -e '
    try {
      const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(config.network?.setupHotspot === false ? "nein" : "ja");
    } catch { process.stdout.write("ja"); }
  ' "$CONFIG" 2>/dev/null || printf 'ja')"
  [[ "$antwort" != 'nein' ]]
}

# ------------------------------------------------------------------ Ablauf

if command -v nmcli >/dev/null 2>&1; then
  # Ein per rfkill abgeschaltetes Funkteil ist von aussen nicht von einem
  # kaputten zu unterscheiden: keine Netze, keine Meldung. Einschalten kostet
  # nichts und ist bei einem Spiegel immer richtig – er hat keinen Flugmodus.
  if [[ "$(nm_plain --fields WIFI general status | awk -F: '{ print $1 }')" == 'disabled' ]]; then
    log 'WLAN war abgeschaltet – wird eingeschaltet.'
    nm radio wifi on || true
  fi

  WIFI_DEV="$(finde_wlan_geraet)"
  lies_auftrag

  case "$ACTION" in
    '-')
      ;;
    scan)
      suche_netze
      ;;
    connect)
      # Lief das Einrichtungs-WLAN, muss es fuer den Versuch weichen. Klappt
      # der Versuch nicht, kommt es sofort zurueck: das Handy haengt gerade
      # daran und wartet auf die Antwort – die naechsten zwei Minuten zu
      # warten, bis der Zaehler unten so weit ist, waere ein Spiegel, der
      # einfach verschwindet.
      WAR_HOTSPOT='nein'
      hotspot_laeuft && WAR_HOTSPOT='ja'
      if ! verbinde "$SSID" "$PASSPHRASE"; then
        if [[ "$WAR_HOTSPOT" == 'ja' ]] && ! kabel_haengt; then
          FEHLER_VORHER="$LAST_ERROR"
          hotspot_an || true
          # Die Meldung des Versuchs zaehlt, nicht die des Wiederaufbaus:
          # gefragt hat jemand nach dem Heimnetz.
          LAST_ERROR="$FEHLER_VORHER"
        fi
      fi
      ;;
    forget)
      if vergiss_netz "$SSID"; then
        log "Netz \"$SSID\" vergessen."
      else
        LAST_ERROR="Fuer \"$SSID\" war kein Profil gespeichert."
      fi
      ;;
    hotspot)
      if [[ "$HOTSPOT_WUNSCH" == 'on' ]]; then
        # Vorher suchen: waehrend der Zugangspunkt laeuft, geht es nicht mehr –
        # und die App im Einrichtungs-WLAN braucht genau diese Liste.
        suche_netze
        hotspot_an || true
      else
        hotspot_aus
      fi
      ;;
    *)
      log "Unbekannter Auftrag \"$ACTION\" – nichts getan."
      ;;
  esac

  # -------------------------------------------------------- Lage beurteilen

  if kabel_haengt; then ETHERNET='true'; else ETHERNET='false'; fi
  AKTIV="$(aktives_profil)"

  if [[ -z "$WIFI_DEV" ]]; then
    STATE='unavailable'
  elif [[ "$AKTIV" == "$HOTSPOT_ID" ]]; then
    STATE='hotspot'
  elif [[ -n "$AKTIV" ]]; then
    STATE='online'
  else
    case "$(nm_plain --fields DEVICE,STATE device status | awk -F: -v d="$WIFI_DEV" '$1==d { print $2 }')" in
      connecting*|config*) STATE='connecting' ;;
      *)                   STATE='offline' ;;
    esac
  fi

  # -------------------------------------------- Einrichtungs-WLAN entscheiden

  # Der eigentliche Zweck des Timers: ein Spiegel, der nirgends mehr hinkommt,
  # kann seine eigene App nicht mehr ausliefern – und niemand koennte ihm
  # sagen, was zu tun ist. Also macht er selbst eines auf.
  if [[ -n "$WIFI_DEV" ]]; then
    if [[ "$STATE" == 'online' || "$ETHERNET" == 'true' ]]; then
      # Erreichbar. Ein offenes Einrichtungs-WLAN hat dann nichts mehr zu tun.
      schreibe_zaehler 0
      if [[ "$STATE" == 'hotspot' ]]; then hotspot_aus; STATE='offline'; fi
    elif [[ "$STATE" == 'hotspot' ]]; then
      # Laeuft schon. Der Zaehler bleibt oben stehen, damit nicht ein einzelner
      # Lauf ihn wieder zumacht.
      :
    elif [[ "$STATE" == 'connecting' ]]; then
      # Mitten im Verbindungsaufbau. Weder zaehlen noch zuruecksetzen: das
      # Einrichtungs-WLAN jetzt aufzumachen hiesse, den Versuch abzubrechen,
      # der gerade laeuft – und ihn zu belohnen waere ebenso falsch, denn ein
      # Geraet kann hier auch haengen bleiben.
      :
    elif ! hotspot_erlaubt; then
      schreibe_zaehler 0
    else
      ZAEHLER=$(( $(lies_zaehler) + 1 ))
      schreibe_zaehler "$ZAEHLER"
      if (( ZAEHLER >= OFFLINE_RUNS_BEFORE_HOTSPOT )); then
        log "Seit $ZAEHLER Laeufen keine Verbindung – der Spiegel macht sein eigenes WLAN auf."
        suche_netze
        if hotspot_an; then STATE='hotspot'; fi
      fi
    fi
  fi

  # Name und Passwort auch dann melden, wenn gerade keines laeuft: die App
  # zeigt beides vorsorglich an, damit man weiss, wonach zu suchen ist, wenn
  # der Spiegel das naechste Mal nicht mehr da ist.
  if [[ -f "$(HOTSPOT_DATEI)" ]]; then hotspot_profil; fi
fi

# ----------------------------------------------------------------- Bericht

HOTSPOT_ACTIVE='false'
[[ "$STATE" == 'hotspot' ]] && HOTSPOT_ACTIVE='true' || true

VERBUNDEN=''
SIGNAL=''
if [[ "$STATE" == 'online' ]]; then
  VERBUNDEN="$(ssid_von_profil "$(aktives_profil)")"
  [[ -n "$VERBUNDEN" ]] || VERBUNDEN="$(aktives_profil)"
  SIGNAL="$(signal_jetzt)"
fi

mkdir -p "$DATA_DIR"

# Zusammengesetzt wird der Bericht in node und nicht in bash.
#
# Zwei Gruende, und beide sind anderswo schon einmal schiefgegangen: JSON von
# Hand zu bauen hiesse, jedes Anfuehrungszeichen in einem Netznamen selbst zu
# maskieren. Und die Netzliste kommt maskiert aus nmcli – ein Doppelpunkt im
# Namen steht dort als "\:", und wer stumpf an Doppelpunkten aufteilt, zerlegt
# genau die Namen falsch, die man am dringendsten braucht.
{
  printf '%s\n' "$SCAN_RAW"
  printf '%%%%KNOWN%%%%\n'
  if command -v nmcli >/dev/null 2>&1; then
    while read -r uuid; do
      [[ -n "$uuid" ]] || continue
      nm_feld 802-11-wireless.ssid connection show uuid "$uuid"
    done < <(wlan_profile)
  fi
} | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const { writeFileSync, renameSync, readFileSync } = require("node:fs");
    const [file, updatedAt, state, ssid, signal, ethernet, scanned,
           hotspotActive, hotspotSsid, hotspotPass, hotspotAddress,
           lastError, answeredAt] = process.argv.slice(1);

    // Eine Zeile aus "nmcli --terse" an den unmaskierten Doppelpunkten trennen.
    const felder = (line) => {
      const out = [];
      let current = "";
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === "\\" && i + 1 < line.length) { current += line[i + 1]; i += 1; continue; }
        if (line[i] === ":") { out.push(current); current = ""; continue; }
        current += line[i];
      }
      out.push(current);
      return out;
    };

    const [scanBlock, knownBlock = ""] = raw.split("%%KNOWN%%");
    const known = knownBlock.split("\n").map((entry) => entry.trim()).filter(Boolean);
    const bekannt = new Set(known);

    const networks = [];
    const gesehen = new Set();
    for (const line of scanBlock.split("\n")) {
      if (!line.trim()) continue;
      const [name, staerke, sicherheit] = felder(line);
      const netzname = (name ?? "").trim();
      // Ein verstecktes Netz meldet sich ohne Namen; zwei Zugangspunkte
      // desselben Netzes melden sich zweimal.
      if (!netzname || gesehen.has(netzname)) continue;
      gesehen.add(netzname);
      networks.push({
        ssid: netzname,
        signal: Number(staerke) || 0,
        // Ein leeres Sicherheitsfeld heisst: offenes Netz, kein Passwortfeld.
        secured: Boolean((sicherheit ?? "").trim()),
        known: bekannt.has(netzname),
      });
    }

    let vorher = {};
    try { vorher = JSON.parse(readFileSync(file, "utf8")); } catch { vorher = {}; }

    // Was dieser Lauf nicht selbst erhoben hat, wird vom letzten uebernommen.
    //
    // Die Netzliste, weil sie leer werden zu lassen schlechter waere als eine,
    // die ein paar Minuten alt ist – im Einrichtungs-WLAN ist sie die einzige,
    // die es je geben wird. Und die Fehlermeldung, weil der Timer alle
    // dreissig Sekunden laeuft: ohne das waere ein "Passwort falsch" weg,
    // bevor es jemand gelesen hat. Weg ist es, sobald der Spiegel wieder an
    // einem Netz haengt – dann hat es sich erledigt.
    const uebernommen = (wert, alt) => (wert ? wert : (alt ?? null));

    const status = {
      updatedAt,
      state,
      ssid: ssid || null,
      signal: signal === "" ? null : Number(signal),
      ethernet: ethernet === "true",
      networks: scanned === "yes" ? networks : Array.isArray(vorher.networks) ? vorher.networks : [],
      scannedAt: scanned === "yes" ? updatedAt : (vorher.scannedAt ?? null),
      known,
      hotspot: hotspotSsid
        ? {
            active: hotspotActive === "true",
            ssid: hotspotSsid,
            passphrase: hotspotPass,
            address: hotspotAddress,
          }
        : null,
      lastError: state === "online" ? null : uebernommen(lastError, vorher.lastError),
      answeredAt: uebernommen(answeredAt, vorher.answeredAt),
    };

    writeFileSync(file + ".tmp", JSON.stringify(status, null, 2) + "\n");
    renameSync(file + ".tmp", file);
  });
' "$STATUS" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$STATE" "$VERBUNDEN" "$SIGNAL" "$ETHERNET" \
  "$SCANNED" "$HOTSPOT_ACTIVE" "$HOTSPOT_SSID" "$HOTSPOT_PASS" "$HOTSPOT_ADDRESS" \
  "$LAST_ERROR" "$ANSWERED_AT" 2>/dev/null || {
    log 'Statusdatei liess sich nicht schreiben.'
    exit 0
  }

# Der Core liest sie; er laeuft als Dienstbenutzer und darf sie nicht schreiben.
chown "$SERVICE_USER:$SERVICE_USER" "$STATUS" 2>/dev/null || true
chmod 600 "$STATUS" 2>/dev/null || true
