# Smartmirror

Anzeige-Software für einen Raspberry Pi hinter einem Zwei-Wege-Spiegel. Alles
Schwarze bleibt Spiegel, alles Weiße erscheint als schwebende Anzeige.

Kein Chromium im Kiosk-Modus: Der Pi bootet per systemd direkt in eine gepackte
Anwendung, aktualisiert sich selbst über GitHub Releases und rollt fehlerhafte
Updates automatisch zurück. Bedient wird alles vom Handy über eine
installierbare Web-App im eigenen WLAN.

---

## Aufbau

Drei Prozesse, bewusst getrennt:

| Prozess | Unit | Aufgabe |
|---|---|---|
| **Core** | `mirror-core.service` | Node/Fastify. Modul-Backends, Zustand, WebSocket-Bus, Konfiguration, liefert die Handy-App aus. Läuft unprivilegiert. |
| **Anzeige** | `mirror-shell.service` | Electron unter [`cage`](https://github.com/cage-kiosk/cage), einem Wayland-Compositor für genau ein Fenster. Kein Desktop, keine Browser-Bedienelemente. |
| **Updater** | `mirror-updater.service` + `.timer` + `.path` | Prüft GitHub Releases, verifiziert Signaturen, tauscht Symlinks, rollt bei fehlgeschlagenem Healthcheck zurück. Der Timer prüft regelmäßig, die Path-Unit startet ihn sofort, wenn die App darum bittet. |
| **Neustart** | `mirror-system.service` + `.path` + `.timer` | Führt aus, worum die App bittet: Dienste neu starten, Gerät booten, Updater anstoßen. Kennt genau diese drei Aufträge. |
| **Startbild** | `mirror-bootlook.service` | Sorgt bei jedem Start dafür, dass beim Booten der Spiegel zu sehen ist und nicht der Pi: Firmware-Splash aus, kein Moduswechsel, Textkonsole auf ein unsichtbares Terminal, Plymouth mit dem Wortzeichen — bis ins Startabbild hinein. Ändert nur, was fehlt. |

Der Updater ist ein eigener Dienst, weil er genau die Dateien ersetzt, aus
denen der Core läuft, und ihn danach neu startet — im selben Prozess würde er
sich selbst unter den Füßen wegziehen.

Die drei letzten sind die einzigen Teile mit Root-Rechten. Der Core läuft
unprivilegiert und soll das bleiben: was er anstoßen können muss, stößt er über
eine Datei an und nicht über einen Aufruf (siehe
[Neustart aus der Handy-App](#neustart-aus-der-handy-app)). `mirror-bootlook`
fragt niemand — es läuft beim Start und richtet ein, was außerhalb des Releases
liegt (siehe [Der Startbildschirm](#der-startbildschirm)).

```
packages/
  sdk/       Modul-Verträge, WebSocket-Protokoll, Konfigurationstypen,
             Design-System als Zahlen (design.ts)
  core/      Server
  shell/     Anzeige-Anwendung (Electron)
  remote/    Handy-App (PWA)
  updater/   OTA-Agent
  icons/     Flache Strichsymbole, aus Lucide generiert
modules/
  clock/         Uhrzeit und Datum (rein im Frontend)
  weather/       Open-Meteo, mit Cache, Tagesverlauf und Warnungen von MeteoAlarm
  spotify/       Was gerade läuft, mit eigener Spotify-App
  calendar/      ICS-Kalender (iCloud, Gemeinde, Schule), Zeitraum einstellbar
  sbb/           Abfahrten einer Haltestelle, von der Fahrplanauskunft search.ch
  notifications/ Die Fläche für Mitteilungen; den Inhalt melden die Module
  timer/         Ein Bagger trägt einen Berg ab; ist er weg, ist die Zeit um
deploy/      systemd-Units, Compositor-Start, Installer, Drehung, Neustart,
             Plymouth-Thema fuer den Start, unsichtbarer Mauszeiger
scripts/     Build-, Bundle- und Generator-Skripte
```

---

## Entwicklung

```bash
npm install
npm run dev
```

Startet Core (Port 8080), die Anzeige in einem Fenster und die Handy-App mit
Hot-Reload auf Port 5173. Weitere Befehle:

```bash
npm run build      # alle Pakete und Module
npm test           # Tests
npm run bundle     # Release-Paket nach dist/bundle/
```

Läuft auf Port 8080 schon etwas anderes: `MIRROR_PORT=8422 npm run dev`.

---

## Ein Modul schreiben

Ein Modul ist ein Ordner. Mehr nicht.

```
modules/mein-modul/
├─ module.json      Manifest: Rechte, Einstellungen als JSON Schema
├─ src/backend.ts   läuft im Core – holt Daten, hält Zustand
└─ src/frontend.ts  läuft in der Anzeige – rendert
```

Ein Modul ohne `backend.ts` ist erlaubt und sinnvoll, wenn nichts geholt werden
muss — die Uhr ist so eines.

**Backend:**

```ts
import { defineBackend } from '@mirror/sdk';

export default defineBackend<Config, State>({
  async setup(ctx) {
    ctx.every('10m', async () => {
      const response = await ctx.fetch('https://api.example.com/daten');
      ctx.setState({ wert: await response.json() });
    });
  },
});
```

`ctx.config` ist bereits gegen das Schema validiert und mit Defaults gefüllt —
im Modul muss nie auf fehlende Felder geprüft werden. Wirft eine Aufgabe, hält
der Modul-Host den letzten Zustand und markiert die Instanz als fehlerhaft: ein
veralteter Wert mit Hinweis ist besser als ein leerer Spiegel.

**Frontend:**

```ts
import { defineFrontend } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import { html, render } from 'lit';

export default defineFrontend<State, Config>({
  create(host, ctx) {
    return {
      update(state, config) {
        render(html`${icon('sun')} ${state.wert}`, host);
      },
    };
  },
});
```

**Die Einstellungsoberfläche entsteht von selbst.** Das `configSchema` im
Manifest wird an die Handy-App geschickt, die daraus das Formular baut. Ein
neues Modul braucht keinerlei eigene UI im Client. In welchen Blockgrößen es das
Modul gibt, sagt das Manifest mit `sizes` und `preferredSize` (`"s"`, `"m"`,
`"l"`, `"xl"` — siehe [Screens, Raster und Blöcke](#screens-raster-und-blöcke)).

**Rechte werden im Manifest angefordert**, sonst existieren sie nicht:

```jsonc
{
  "permissions": ["network", "secrets", "commands"],
  // Ohne Allowlist ist "network" wirkungslos – ein Modul kann sich nicht
  // selbst freischalten, indem es nur die Permission setzt.
  "network": { "allow": ["api.example.com"] }
}
```

Geheimnisse (API-Schlüssel) liegen verschlüsselt in `data/secrets.json` und
erreichen das Frontend nie. Das Backend darf sie mit `ctx.setSecret(key, wert)`
auch selbst schreiben — für Zugänge, die kein Mensch abtippt, sondern die eine
Anmeldung einbringt. Ein Geheimnis mit `"managed": true` im Manifest gehört dem
Modul: die Handy-App zeigt dafür kein Eingabefeld.

**Fehlt ein Schritt, den nur der Nutzer tun kann**, sagt das Modul das mit
`ctx.setAction({ label, url })`. Die Bitte erscheint oben im Einstellungsblatt
des Blocks — und nur dort. Auf dem Spiegel wäre sie sinnlos: davor steht
niemand, der tippen könnte.

---

## Spotify anschließen

Das Modul zeigt, was gerade läuft — mit Cover, für **bis zu fünf Konten**.
Hören mehrere gleichzeitig, teilen sie sich den Block abwechselnd: der Spiegel
zeigt jeden für ein einstellbares Intervall (Voreinstellung zehn Sekunden) und
blendet dazu den Namen aus dem Spotify-Profil ein. Es steuert nichts: vor einem
Spiegel gibt es nichts zu drücken.

**Was zu sehen ist, entscheidet die Blockgröße** — nicht eine Einstellung:

| Größe | Inhalt |
|---|---|
| S | nur das Cover |
| M | Cover, Titel, Interpret |
| L | dazu der Fortschrittsbalken mit Zeiten |
| XL | alles in voller Breite, mit Album und Jahr |

Interpret und Fortschrittsbalken tragen die **Akzentfarbe des Covers** — die
Anzeige zieht sie beim Laden aus dem Bild. Das Cover selbst holt das Backend
und liefert es als data-URI mit: die Anzeige darf hinter ihrer strikten CSP
nichts aus dem Netz laden. Eine Ausnahme von der Regel „keine Farbflächen"
aus [Gestaltung hinter dem Spiegel](#gestaltung-hinter-dem-spiegel), und eine
bewusste: das Cover ist hier der Inhalt, nicht Dekoration — und es bleibt die
einzige Fläche, die leuchtet.

**Jeder legt seine eigene Spotify-App an.** Das ist keine Bequemlichkeit,
sondern die einzige Bauform, die trägt: Spotify erlaubt einer App im
Development Mode seit Februar 2026 nur noch fünf Nutzer, die der App-Besitzer
einzeln freischaltet, und die unbegrenzte Stufe verlangt ein eingetragenes
Unternehmen mit 250.000 monatlich aktiven Nutzern. Eine mitgelieferte App wäre
nach fünf Spiegeln voll. Home Assistant löst es aus demselben Grund genauso.

1. Auf [developer.spotify.com](https://developer.spotify.com/dashboard) eine App
   anlegen. Name und Beschreibung sind frei, als API **Web API** wählen.
2. Als **Redirect URI** genau `http://127.0.0.1:8888/mirror` eintragen.
3. Die **Client ID** kopieren und in der Handy-App beim Spotify-Block einfügen.
4. Der Block bietet daraufhin **„Bei Spotify anmelden"** an. Antippen, zustimmen.
5. Der Browser landet auf einer Fehlerseite. **Das ist richtig so.** Die Adresse
   aus der Adresszeile kopieren und unter **Anmelde-Antwort** einfügen.

**Weitere Konten** gehen denselben Weg: solange ein Platz frei ist, bietet der
Block „Weiteres Konto verbinden" an, und jede eingefügte Antwort belegt den
nächsten Platz. Zwei Dinge dazu: jedes Konto muss vorher im Spotify-Dashboard
der App als Nutzer eingetragen werden (die fünf Plätze des Moduls sind genau
Spotifys Grenze je App), und **getrennt** wird ein Konto nicht am Spiegel,
sondern bei Spotify — unter [Konto → Apps](https://www.spotify.com/account/apps/)
den Zugriff entziehen. Der Spiegel merkt das bei der nächsten Abfrage und gibt
den Platz von selbst frei.

Der Umweg über die Fehlerseite ist Spotifys Regelwerk geschuldet: seit April
2025 sind nur noch HTTPS-Adressen und die Loopback-Adresse als Ziel erlaubt.
Ein Spiegel im WLAN ist beides nicht — er hat kein Zertifikat, und 127.0.0.1
zeigt auf dem Handy auf das Handy. Also schicken wir die Antwort bewusst
irgendwohin, wo nichts lauscht, und lassen sie den Nutzer zurückreichen. Der
Zugang wird danach verschlüsselt abgelegt und läuft von selbst weiter; die
Client ID bleibt sichtbar, weil sie kein Geheimnis ist.

Der App-Besitzer braucht ein **Spotify-Premium-Konto** — ohne das lässt Spotify
seit Februar 2026 keine App mehr laufen. Angefordert wird nur
`user-read-currently-playing`, also Lesen und sonst nichts.

---

## Screens, Raster und Blöcke

Jeder Screen wird auf eine von zwei Arten angeordnet: als **Raster** oder als
**Szene**. Das Raster kann alles — und lässt deshalb auch zu, dass jemand zehn
Zeilen füllt. Die Szene macht die Obergrenze zur Form. Umgeschaltet wird je
Screen am Handy; bestehende Screens bleiben beim Raster, weil ein Update eine
Wand nicht ungefragt neu anordnen soll.

### Raster

Voreingestellt 6 × 4 Felder quer, hochkant 4 × 10 — das Raster des
Design-Systems, mit bewusst querformatigen Zellen (224 × 148 px auf 1080 × 1920).
Eine Box trägt eine Beschriftung und darunter einen großen Wert, und dafür ist
Breite mehr wert als Höhe. Jedes Modul liegt darin als **Block** in einer von
vier Größen — wie die Widgets auf einem Telefon:

| Größe | Felder | gedacht für |
|---|---|---|
| **S** | 1 × 1 | eine Zahl, ein Symbol |
| **M** | 2 × 1 | Uhrzeit, ein Wert mit Beschriftung |
| **L** | 2 × 2 | Wetter, das die Tage durchschaltet, Terminliste |
| **XL** | 4 × 2 | eine Zeile, die über die halbe Wand geht |

Ein Block rastet ein: Abstände stimmen von selbst, und eine Anordnung lässt sich
in einem Satz beschreiben. Freie Pixelpositionen gäbe es nur um den Preis, dass
niemand sie mit dem Daumen auf einem Handybildschirm trifft.

**Nicht jedes Modul gibt es in jeder Größe.** Eine Größe ist keine Einstellung,
sondern eine Aussage über den Inhalt: eine Uhrzeit passt in ein einzelnes Feld,
eine Wochenvorhersage braucht eine Reihe. Ein Modul zählt im Manifest auf, was
es kann — `"sizes": ["m", "l", "xl"]` —, und am Handy sind die übrigen Größen gar
nicht erst antippbar. Ohne Angabe kann ein Modul alle vier; die Mitteilungen
lassen S und M aus, weil schon ihre oberste Zeile darin unter 32 px fiele.

**Ein Modul muss keinen Block belegen.** Beim Hinzufügen gibt es zwei Wege:
„Als Block" legt es ins Raster, „Nur melden" lässt es laufen, ohne dass es auf
dem Spiegel erscheint. Ein Kalender, der bloß die nächsten Termine in den
Mitteilungsblock schieben soll, braucht keine Fläche — und weil er keine
belegt, lässt er sich auch auf einem vollen Screen hinzufügen. Umstellen geht
jederzeit im Einstellungsblatt; Platz, Größe und Band bleiben dabei stehen, so
dass ein wieder eingeblendeter Block dorthin zurückkehrt, wo er lag. Was so
läuft, steht am Handy unter dem Brett als „Nur als Mitteilung".

Als Faustregel gilt: **höchstens zwei Boxen nebeneinander** und **höchstens
sechs der zehn Zeilen belegt**. 994 px auf vier Boxen erzwingen Schrift unter
32 px, und die liest man auf 3 m nicht mehr; ein randvolles Raster summiert
seine Tönungen zu einer leuchtenden Fläche, auf der nichts mehr Vorrang hat.
Leere Zeilen gruppieren die Blöcke und lassen den Spiegel Spiegel bleiben.

### Szene

Drei Bänder statt eines freien Rasters: **Kopf 20 %, Hauptzone 60 %,
Fußband 20 %**. Die Uhr sitzt fix links oben, rechts daneben genau ein Slot. Die
Hauptzone trägt die Aussage der Szene, das Fußband nur breite, flache Elemente
wie „Läuft gerade" oder eine Terminzeile — und darf leer bleiben.

Höchstens drei Elemente: Uhr, ein Kopf-Slot, ein Hauptwidget. Das Fußband zählt
als viertes nur, wenn es etwas Laufendes zeigt. Wo kein vierter Platz ist,
landet auch kein vierter Block — das ist der Unterschied zu einer Regel, an die
man sich halten muss.

**Das Fußband stellt nicht nebeneinander, sondern schaltet durch.** Zwei Blöcke
nebeneinander sind dort zwei halbe Bänder, und ein halbes Band ist zu schmal für
die Zeile, für die das Fußband da ist („Läuft gerade", die nächste Verbindung).
Nacheinander bekommt jedes das ganze Band — bezahlt wird mit Zeit statt mit
Breite. Und die Zeit dafür ist keine zweite Zahl, sondern **die Standzeit des
Screens, geteilt durch die Anzahl**: ein Durchlauf ist genau so lang wie der
Screen, den er begleitet. Wer hinsieht, bis weitergeschaltet wird, hat jedes
Element genau einmal gesehen; ein eigener Takt daneben ließe mal das letzte
Element ungesehen und zeigte mal das erste zweimal. Am Handy steht die Zahl am
Band („Fußband · je 7 s"), damit man sieht, was ein dritter Block die beiden
anderen kostet.

**Mitgezählt wird nur, was gerade etwas zeigt.** Ein Spotify-Block ohne laufende
Musik ist ein leerer Platz, und ein leerer Platz im Durchlauf sieht nicht aus wie
Ruhe, sondern wie ein Aussetzer. Er fällt deshalb aus der Rechnung — und kommt
von selbst wieder hinein, sobald etwas läuft. Gefragt wird dafür die Anzeige
selbst und nicht das Modul: wer nichts anzeigen will, zeichnet nichts, und ein
zusätzliches „ich bin gerade leer" im Protokoll wäre ein zweiter Zustand neben
dem ersten — einer, der falsch stehen kann.

Angekündigt wird der Wechsel wie beim Wetter: eine **senkrechte Punktreihe an
der rechten Kante** des Bandes, der lange Punkt ist das laufende Element. Bringt
ein Block eine eigene Punktreihe mit, tritt sie für diese Zeit zurück — zwei
Reihen an derselben Kante zählen zwei verschiedene Dinge und sind aus 3 m eine
Reihe mit zufälligen Lücken.

**Ein Modul sieht in beiden Anordnungen gleich aus.** Welche Form ein Block
zeigt, hängt an seiner Größe und an sonst nichts — nicht daran, ob er im freien
Raster liegt oder in einem Band. Ein Modul, das je nach Aufhängung etwas anderes
zeigt, ist für den, der davorsteht, zwei Module: derselbe Name, dieselbe Größe,
zwei Anzeigen.

Damit das aufgeht, muss der Platz zur Größe passen. Uhr und Slot bekommen im
Kopfband deshalb je **die halbe Bandbreite** — auf 994 px Inhaltsbreite sind das
481, und genau so breit ist ein L-Block im Raster (zwei von vier Spalten samt
Abstand). Der Slot ist damit kein Sonderformat mehr, sondern ein L-Block. Das
kostet die Uhrzeit ein paar Pixel: sie fällt von 162 auf 144 px, weil ihr Block
nun ebenfalls die Hälfte ist. Weil die linke Kante des Slots jetzt in der Mitte
des Bandes liegt, also auf einer Rasterlinie, ist er außerdem linksbündig wie
jeder andere Block — die alte Ausnahme („was im rechten Slot steht, endet an der
rechten Kante") fällt weg, und mit ihr der spiegelverkehrte Aufbau.

**Die Wertzeile: 49 % der Blockhöhe.** Jeder Block, der einen großen Wert und
eine Zeile darunter zeigt, gibt diesem Wert eine Zeile fester Höhe — die Uhr für
ihre Uhrzeit, das Wetter für seine Karte. Weil beide Blöcke im Kopfband gleich
hoch sind, bedeutet die Zahl in beiden dasselbe: die großen Zahlen liegen auf
einer Achse und die beiden kleinen Zeilen darunter auf einer Grundlinie. Ohne
das säße die Zahl rechts irgendwo neben der Uhrzeit — man sieht sofort, dass
etwas fehlt, auch wenn man nicht benennen kann, was.

Aus demselben Grund rechnen die zweiten Zeilen gegen die Blockhöhe und nicht
gegen die Breite. Vorher waren sie 0,62 em einer Größe, die selbst an der Breite
hängt; in einem 481 px breiten Block landete das Datum unter der Uhr damit bei
15 px — weit unter den 32 px, ab denen aus 3 m überhaupt noch etwas lesbar ist.

Ein Block behält seinen Rasterplatz, auch während sein Screen eine Szene ist.
Beim Zurückschalten liegt er wieder dort, wo er lag. Aber **entscheiden darf
dieser Platz in einer Szene nichts**: dort liegt ein Block in einem Band, und
ein Raster, in dem gerade kein Loch der passenden Größe frei ist, ist deshalb
kein Grund, eine Größe abzulehnen. Sonst scheitert XL an einer Enge, die auf
dem Spiegel niemand sieht — und der einzige Rat, den man dazu geben kann
(„verschiebe zuerst einen anderen Block"), geht ins Leere, denn in einer Szene
wird nichts verschoben. Ein neuer Platz wird trotzdem gesucht und
mitgeschrieben, wenn sich einer findet; findet sich keiner, bleibt der alte
stehen.

**Mehrere Screens.** Ein Screen ist eine vollständige Anordnung. Der Spiegel
schaltet sie im Kreis weiter; die Standzeit steht am Screen und nicht global —
ein Blick auf die Uhr braucht keine zwei Minuten, eine Einkaufsliste schon.
Screens ohne Inhalt werden übersprungen, sonst stünde die Wand zwanzig Sekunden
schwarz und sähe kaputt aus. Alle Screens bleiben dabei im Dokument und werden
nur überblendet: die Module laufen weiter und holen ihre Daten nicht bei jedem
Wechsel neu.

**Vorrang: ein Block darf den Spiegel anhalten.** Weiterschalten ist richtig,
solange nichts läuft — und falsch in dem einen Moment, in dem doch etwas läuft.
Ein Timer, der bei 3:41 weggeschaltet wird, ist kein Timer mehr, sondern eine
Zahl, die man verpasst hat. Ein Block mit *Vorrang* hält den Spiegel deshalb an,
solange bei ihm etwas läuft: kein Screenwechsel, im Fußband kein
Weiterschalten — und gezeigt wird sein Screen, nicht der gerade laufende. „Bleibt
sichtbar" heißt, dass man ihn sieht. Ist es vorbei, läuft alles weiter wie zuvor.

Der Vorgang hat zwei Hälften, und die gehören verschiedenen Parteien. **Der
Block bittet:** er schreibt `data-hold` an sein Host-Element, solange bei ihm
etwas läuft. Nur das Modul weiß, wann das ist — beim Timer ist es nicht „der
Block zeigt etwas" (nach Ablauf steht dort weiter „Fertig"), sondern „die Zeit
läuft noch". **Der Nutzer erlaubt:** ohne den Schalter *Vorrang* am Block bleibt
die Bitte folgenlos. Ein Modul, das den Spiegel von sich aus anhalten könnte,
wäre ein Modul, das die Anzeige übernimmt — und die gehört dem, der davorsteht.
Voreingestellt ist der Schalter aus, und die Handy-App zeigt ihn nur bei
Modulen, die im Manifest `"holds": true` stehen haben; sonst stünde an jedem
Block eine Einstellung, die bei den meisten folgenlos bleibt.

Über dem Vorrang steht nur eines: die Vorschau. Wer am Handy gerade an einem
Screen arbeitet, ist ein Mensch im Raum, und ein Mensch schlägt eine Regel.

**Angeordnet wird am Handy**, auf einem Brett, das den Spiegel im Kleinen zeigt
— gleiches Seitenverhältnis, gleiche Ränder, gleiches Raster. Ein Block wird mit
dem Finger gezogen und rastet ein; ein Umriss zeigt dabei, wo er landet, und
färbt sich rot, wenn dort schon etwas liegt. Bei einer Szene zeigt dasselbe
Brett die drei Bänder in denselben Anteilen; gezogen wird dort nichts, weil es
je Band nur „drin" oder „nicht drin" gibt — das Band wählt man am Block aus.
Jede Änderung wird unten bestätigt und lässt sich zurücknehmen, solange die
Bestätigung steht. Solange die Modulseite offen ist,
kann der Spiegel den bearbeiteten Screen mitzeigen und hält dafür das
Weiterschalten an — der Schalter dafür steht unter dem Brett. Er löst sich nach
fünf Minuten von selbst, damit ein Handy in der Hosentasche den Spiegel nicht
dauerhaft anhält.

**Für Modul-Autoren:** Ein Modul erfährt seine Blockgröße nicht als Zahl,
sondern über CSS. Der Block ist ein `container-type: size`, Schriftgrößen
beziehen sich mit `cqh`/`cqw` darauf, und was in einen flachen Block nicht mehr
passt, blendet eine Container-Query aus:

```css
.mein-modul__wert {
  /* Immer min(...) aus Höhe und Breite – sonst läuft es in flachen Blöcken
     unten heraus und in schmalen seitlich. */
  font-size: min(30cqh, 18cqw);
}

@container (max-height: 260px) {
  .mein-modul__details {
    display: none;
  }
}
```

Das Manifest zählt mit `sizes` auf, welche Größen inhaltlich aufgehen, und
schlägt mit `"preferredSize": "l"` die beim Hinzufügen vor — sie muss in `sizes`
stehen, sonst lädt das Modul nicht. Wohin der Block gehört, weiß allein der
Nutzer. Verliert ein Modul im Update eine Größe, zieht der Core bestehende
Blöcke auf die nächstliegende, die es noch gibt; bei gleichem Abstand auf die
kleinere, denn ein zu großer Block schöbe seine Nachbarn beiseite.

---

## Gestaltung hinter dem Spiegel

Die Regeln im Basis-Stylesheet sind keine Geschmacksfrage, sondern Physik:

- Hintergrund **exakt `#000000`**. Jeder Grauwert leuchtet durch die
  Spiegelfolie und verrät, dass dahinter ein Bildschirm hängt.
- Keine `box-shadow`, `text-shadow`, `filter: blur()` — daraus werden hinter
  halbdurchlässigem Glas Lichthöfe.
- Keine großen hellen Flächen: sie blenden und zeichnen den Displayrahmen nach.
- Schriftschnitt nicht unter 300. Sehr dünne Schnitte wirken durch die Folie
  ausgewaschen. Nach oben ist die Regel offen — genutzt wird sie aber kaum:
  **Werte stehen im Schnitt 300, Beschriftungen in 600–700.** Ein fetter Wert in
  240 px ist genau die große helle Fläche, vor der die Regel darüber warnt.
- Getönte Flächen höchstens bei **12 % Deckkraft**, und **höchstens eine deckende
  Farbfläche pro Anordnung**, mit dunklem Text darauf. Zwei summieren sich zum
  Leuchtfeld und lassen die Displaykante sichtbar werden. Welcher Block sie
  trägt, ist eine Einstellung am Modul (`highlight`) und keine Automatik: das
  kann nur entscheiden, wer die Anordnung kennt.
- **Zwei Akzente, kein dritter Ton.** Salbei `#93b1a6` trägt Normalwerte —
  Beschriftungen, Balken, Ringe, Konturen —, Sand `#d4b483` die Spitzen und
  alles, was Aufmerksamkeit verlangt. Sobald Farbe nur noch hübsch ist und nichts
  mehr bedeutet, liest man sie nicht mehr mit.
- Gedämpfte Grautöne nicht unter `#707070` — darunter verschwindet alles.
- Alle Symbole flach, einfarbig, in `currentColor` ([Lucide](https://lucide.dev),
  ISC). Keine Emoji: die sehen je nach System anders aus und sind teils farbig.
- Vier runde Schriften unter SIL Open Font License werden **mitgeliefert**,
  Voreinstellung ist Nunito. Nie ein CDN — der Spiegel muss ohne Internet in
  der richtigen Schrift starten.
- Einbrennschutz verschiebt das Layout alle 15 Minuten um wenige Pixel.
- Hochkant gedreht wird in der Anzeige selbst, nicht im Compositor und nicht im
  Kernel. Bei Vielfachen von 90° ist das pixelgenau — es wird nichts skaliert
  und nichts interpoliert, und hinter halbdurchlässigem Glas fällt jede weiche
  Kante als Schleier auf.

### Eine Handschrift für alle Blöcke

Die Physik sagt, was nicht geht. Wie ein Block aussieht, sagt sie nicht — und
weil jedes Modul das für sich beantwortet hat, standen zuletzt zwei Sprachen
nebeneinander auf einer Wand. Inzwischen gilt für alle dasselbe Gerüst, und die
Regeln stehen im Stylesheet als gemeinsame Selektorlisten: wer ein Modul
dazunimmt, hängt seine Klassen ein, statt die Werte abzuschreiben.

1. **Linke Kante, kein Innenabstand.** Der Inhalt beginnt an der Blockkante,
   also an einer Rasterlinie — nur so stehen zwei Blöcke untereinander
   tatsächlich an derselben Linie. Der Abstand zum Nachbarn kommt aus dem
   Raster und muss nicht doppelt vorkommen.
2. **Eyebrow**: woher der Wert kommt — Wochentag, Ort, Kontoname. Klein,
   gesperrt, in Versalien, und **die Zeile, die den Akzent trägt**.
3. **Titel**: der eine Wert, für den der Block da ist. Uhrzeit, Temperatur,
   Songtitel. Schnitt 300.
4. **Zweitzeile**: gedimmt, ohne Sperrung.
5. **Balken**: 4 px, Spur 14 % Weiß, abgerundet. Eine Linie, keine Fläche.
6. **Ziffern** in `tabular-nums`, damit beim Weiterzählen nichts zappelt.

Punkt 2 und 3 haben mit dem Design-System die Rollen getauscht: bis 0.8 war der
Wert fett und die Beschriftung grau. Jetzt ist der Wert dünn und die
Beschriftung farbig — **240 gegen 26** liest man aus 3 m in einer Sekunde, ganz
ohne Fettung, und die helle Fläche bleibt klein.

Die Uhr weicht in einem Punkt ab: bei ihr steht die Herkunftszeile *unter* der
Uhrzeit statt darüber. Das folgt daraus, was die Zeile beantwortet — „wo" und
„welches Konto" gehen dem Wert voraus, „welcher Tag" folgt der Uhrzeit. Gesetzt
ist sie in beiden Fällen gleich.

**Farbe braucht eine Quelle.** Spotify zieht seinen Ton aus dem Cover, das
Wetter aus der Temperatur (kühles Blau nach warmem Bernstein) — dadurch ist die
Farbe eine Eigenschaft des Inhalts und keine Dekoration. Die Uhr bleibt weiß:
sie hat keine Eigenschaft, aus der sich ehrlich ein Ton ableiten ließe, und ein
Block ohne Farbe hält den Spiegel ruhig.

Das ist die eine **bewusste Abweichung vom Design-System**, das genau zwei
Akzente und keinen dritten Ton vorsieht. Die beiden Rollen gelten hier trotzdem:
Salbei für Beschriftungen und Normalwerte, Sand für Spitzen. Nur dort, wo ein
Modul eine echte Quelle für seinen Ton hat, darf er von dort kommen. Auf einer
deckenden Fläche entfällt er ganz — dort *ist* die Fläche der Akzent, und ein
zweiter Ton darauf wäre Farbe auf Farbe.

**Der Inhalt füllt den Block.** Feste Größentabellen je Blockgröße führen dazu,
dass ein Modul im großen Block als kleiner Klumpen in der Mitte steht. Deshalb
leiten sich Maße aus dem Block ab: das Cover ist so hoch wie der Platz, den es
hat, und quadratisch; die Uhrzeit rechnet ihre Größe aus der Zeichenzahl, damit
`21:04` und `9:04:33 PM` beide die Breite ausfüllen.

**Was nicht hineinpasst, fällt weg — es staucht sich nicht.** Die Vorschau des
Wetters verschwindet im M-Block, die Zeitzeile von Spotify in S und M. Gehängt
ist das an die Blockgröße und nicht an eine Pixelhöhe: eine Rasterzeile ist auf
1080p gut 200 px hoch und auf einem 4K-Spiegel knapp 500 — eine Schwelle in
Pixeln bedeutete auf jedem Bildschirm etwas anderes.

**Nacheinander statt nebeneinander.** Vier Tage in einer Reihe sind eine
Tabelle: jeder Tag bekommt ein Viertel der Breite, also ein Symbol in
Fußnotengröße und zwei Zahlen, die man aus zwei Metern nicht mehr liest. Ein
Spiegel wird aber im Vorbeigehen gelesen. Deshalb zeigt das Wetter im L-Block
immer nur einen Tag und schaltet zum nächsten: *Heute*, *Morgen*, danach der
Wochentag — im Raster wie im Kopfband einer Szene, denn die Form hängt an der
Größe und nicht an der Aufhängung.

Zwei Tage haben Namen, die näher sind als ihr Wochentag; „Übermorgen" gehört
nicht mehr dazu. Es ist zwar ein Wort, aber keine Auskunft — man muss erst zwei
Tage weiterzählen, um zu wissen, welcher gemeint ist, während man „Freitag"
sofort weiß. Nebenbei war es das längste Wort des Stapels und das einzige, das
an der Blockkante endete.

Der Takt dafür ist **einstellbar** (*Standzeit einer Karte*, 2 bis 60 s). Ohne
eigene Angabe gilt der Takt des Design-Systems (`--motion-dwell`, 2,6 s). Dass
das Wetter davon abweichen darf, ist eine bewusste Ausnahme: es ist der einzige
Block, bei dem man den Takt tatsächlich spürt, weil man auf eine bestimmte
Karte wartet.

**Das Symbol trägt die Karte.** Es nimmt die ganze Wertzeile ein und steht neben
Tag und Zahl wie ein Bild neben seiner Bildunterschrift. Das ist keine Vorliebe,
sondern die Leseentfernung: aus fünf Metern erkennt man eine Wolke, lange bevor
man eine Zahl liest. Darunter steht eine einzige Textzeile, groß genug, um zu
zählen — der Ort fällt weg, weil er sich nie ändert und nichts beantwortet, was
man im Vorbeigehen wissen will.

Der Aufbau der Karte bleibt bei jedem Tag derselbe; nur der Inhalt wechselt,
damit aus dem Weiterschalten eine ruhige Bewegung wird und kein Umbau. Sind die
Werte veraltet, hört das Weiterschalten auf: eine Durchschaltung, die alte Tage
durchblättert, sieht lebendiger aus, als die Daten sind. Eine Punktreihe an der
rechten Kante kündigt den Wechsel an — ohne sie liest man im Vorbeigehen
„Heute 18°" und weiß nicht, dass gleich „Morgen 19°" dasteht. Sie steht
senkrecht: waagerecht unter der Karte bräuchte sie eine eigene Zeile, und die
schöbe die Karte aus der Linie mit dem Block daneben. Im XL-Block bleibt der
Tagesverlauf stehen, weil dort alles gleichzeitig lesbar groß ist.

**Die Wettersymbole zeichnet das Modul selbst** statt sie aus der Bibliothek zu
nehmen, und sie bewegen sich. In 155 px fällt auf, dass Bibliotheksformen für
24 px gedacht sind: „bedeckt" ist dort dieselbe einzelne Wolke wie „bewölkt",
und der Blitz ein Haken, den man neben der Wolke kaum findet. Der eigene Satz
gibt „bedeckt" eine zweite Wolke — die in eigenem Takt zieht, damit aus zwei
Linien ein Himmel mit Tiefe wird — und dem Gewitter drei kleine Blitze, die
unabhängig voneinander einschlagen.

Bewegt wird immer nur ein Teil und nie das ganze Symbol: Strahlen drehen, Wolken
driften, Tropfen und Flocken fallen versetzt, Flocken taumeln dabei. Was zu
einer Wolke gehört, liegt in *einer* Gruppe und zieht mit ihr — sonst wanderte
die Wolke davon und der Regen bliebe in der Luft hängen.

**Ein Blitz ist nur da, wenn er schlägt**, und ein Einschlag ist kein einzelnes
Aufblitzen, sondern ein kurzes Flackern: hell, aus, hell, halten, Nachzucker.
Die drei haben verschiedene Dauern (2,3 / 2,9 / 3,7 s) und starten mitten im
Takt, also schlagen sie nie zusammen ein und das Muster wiederholt sich erst
nach Minuten. Dicht genug, dass fast immer irgendwo einer zuckt — sonst läse man
„bewölkt" statt „Gewitter".

Nachts steht alles still, und `prefers-reduced-motion` schaltet es ebenfalls ab:
wer um drei Uhr aufsteht, will eine Uhrzeit lesen und nicht von einer tropfenden
Wolke geweckt werden. In der Vorschaureihe stehen dieselben Symbole still — eine
Reihe driftender Wolken in Fußnotengröße ist Flimmern und keine Auskunft. Dass
Tropfen und Blitze dort trotzdem sichtbar sind, liegt daran, dass ihre
Deckkraft ausschließlich in den Animationsbildern steht und nicht am Element.

**Zwei Dinge sind an diesem Satz ungewöhnlich, und beide stehen dort, weil sie
beim ersten Anlauf schiefgingen.** Erstens werden die Wolken aus Kreisen
*gerechnet* (`src/glyphs.ts`) und nicht aus Bögen geraten: SVG vergrößert einen
zu kleinen Bogenradius stillschweigend, und die rechte Kuppe blähte sich dadurch
weiter auf als beabsichtigt — die Wolken standen über der Kante ihres Feldes und
waren abgeschnitten, schon im Stillstand. Zweitens kennt jede Form ihren
**Bewegungsraum**: Zeichnung plus halbe Strichstärke plus größter Ausschlag
ihrer Animation. Ein Test hält diesen Raum gegen das Feld, damit nie wieder
etwas an den Rand stößt, das sich bewegt.

Deshalb liegt die Geometrie in `src/glyphs.ts` und das Zeichnen in
`src/icons.ts`: der Schnitt läuft entlang der Frage, wer einen Browser braucht.
Die Rechnung nicht, das Zeichnen schon — und nur so lässt sich die Rechnung
prüfen.

### Bewegung

Bewegt wird nur, was sich inhaltlich ändert: ein Wechsel steigt kurz auf und
blendet über (`--motion-swap`, 500 ms), Fortschritt wächst als Breite
(`--motion-tick`, 900 ms), Laden atmet (`--motion-breathe`, 1,4 s). Nie
gleichzeitig zwei Elemente, nie Position und Größe zusammen. Im dunklen Raum
zieht jede Animation den Blick auf sich, und ein Spiegel, der den Blick zieht,
ist kaputt. `prefers-reduced-motion` schaltet alles ab.

Zwei Blöcke weichen bewusst ab, und beide aus demselben Grund: bei ihnen *ist*
die Bewegung die Auskunft. Die Wettersymbole ziehen, tropfen und blitzen, weil
eine stehende Wolke nur eine Form ist und eine ziehende ein Wetter. Der Timer
gräbt, weil ein Bagger, der stillsteht, keine Zeit vergehen lässt. Beide halten
sich dafür an die andere Hälfte der Regel: nachts steht alles still, und wer
Bewegung abbestellt hat, bekommt keine — beim Timer, indem sein Takt auf null
geht (`--dig-bucket`), also an der einen Stelle, an der alle Teile hängen.

### Ein Timer als Baustelle

Ein Timer auf einem Spiegel hat ein Problem, das eine Sanduhr nicht hat: man
geht an ihm vorbei. Eine Zahl, die herunterzählt, beantwortet „wie viel noch?"
erst, wenn man sie liest — ein Berg, der kleiner geworden ist, beantwortet es im
Vorbeigehen. Deshalb steht die Restzeit im Timer-Block zweimal: als Ziffern für
den, der hinsieht, und als Berg für den, der nur vorbeigeht. Ein Bagger trägt
ihn ab und lädt ihn auf Lastwagen; ist der Berg weg, ist die Zeit um, und die
Mitteilung dazu steht im Feed.

**Der Bagger arbeitet immer gleich schnell.** Ein Eimer dauert 5 s, vier Eimer
füllen einen Lastwagen, dann fährt er und der nächste kommt — unabhängig davon,
ob der Timer auf drei Minuten oder auf zwei Stunden steht. Was sich mit der
Dauer ändert, ist der *Berg*: er ist bei einem langen Timer größer und braucht
deshalb mehr Eimer. Andersherum wäre es falsch — ein Bagger, der bei einer
Stunde in Zeitlupe schwenkt, sieht nicht nach viel Arbeit aus, sondern nach
einem hängenden Bildschirm.

**Jeder Berg überragt die Maschine**, auch der von drei Minuten: ein Haufen, der
niedriger ist als der Bagger davor, sieht nach Aufräumen aus und nicht nach
Arbeit, und aus drei Metern beantwortet er die Frage „wie viel noch?" gar nicht.
Das Maß dafür ist das Kabinendach, und ein Test hält den kleinsten Berg dagegen.
Nach oben ist bei einer halben Stunde Schluss (`DIG.fullLoads`): der Unterschied
zwischen kurz und lang fällt damit genau in den Bereich, in dem ein Timer
meistens steht, und ob eine Stunde oder zwei — „ein voller Berg" ist die
ehrlichere Auskunft als zwei Berge, die sich um eine Handbreit unterscheiden.

**Abgebaut wird von der Seite, nicht kleiner gezoomt.** Der Berg bekommt eine
Abbaukante — eine gerade Böschung, die sich in den Haufen frisst — und darüber
eine Sohle, die tiefer wird. Was übrig bleibt, ist das Kleinste dreier Geraden:
das ursprüngliche Profil, die Sohle und die Böschung. Genau daraus entsteht die
Form, die eine angegrabene Halde hat, und genau so verschwindet sie: erst eine
Wand, dann eine Bank, dann nichts.

Jeder Eimer nimmt dabei gleich viel **Fläche** weg — nicht gleich viel Höhe und
nicht gleich viel Breite. Wie viel davon Kante und wie viel Sohle ist, fällt aus
der Rechnung (`tauForShare`) und nicht aus einer Schätzung. Daraus folgt auch,
dass die Kante am Ende schneller wandert als am Anfang: aus einer hohen Wand
holt ein Eimer viel Menge auf kurzem Weg, aus einer flachen Lage dieselbe Menge
erst auf langer Strecke. Wer schon einmal eine Grube hat fertig machen sehen,
kennt genau dieses Tempo.

**Deshalb fährt der Bagger.** Die Wand wandert nach rechts, also folgt er ihr —
einmal je Lastwagen, mit einem kurzen Ruck, und der Wagen fährt mit, weil er
dort steht, wo geladen wird. Über einen langen Timer arbeitet sich die Maschine
so sichtbar in den Berg hinein. Die Schaufel greift dabei immer zwei Einheiten
hinter der Zehe der Kante; dass das in jeder Größe und bei jedem Stand stimmt,
prüft ein Test.

Zwischen zwei Eimern steht der Berg still: er wird kleiner, *weil* gegraben
wurde, und nicht, weil Zeit vergeht. Damit Bissen und Schwenk zusammenfallen,
bekommt die Bewegung einen Versatz mit (`--dig-phase`, eine negative
`animation-delay`) — sie beginnt dort, wo sie nach der verstrichenen Zeit stehen
müsste, und nicht dort, wo die Anzeige gerade das Bild aufgebaut hat.

**Der Wagen fährt erst, wenn die Schaufel leer ist.** Das letzte Kippen einer
Ladung endet bei 89 % ihrer Dauer, er zieht bei 92 % an, und der nächste steht
bei 8 % — lange vor dem ersten Kippen bei 10 %. Andersherum fällt eine Ladung
neben die Mulde, und das sieht man sofort. Die vier Zahlen stehen als
`DIG.dump` und `DIG.swap` im Design-System, und ein Test rechnet ihre
Reihenfolge nach.

**Man sieht nicht in eine Mulde hinein.** Von der Seite ist eine Ladung erst
sichtbar, wenn sie über die Bordwand steht: die ersten beiden Eimer
verschwinden im Wagen, der dritte lugt hervor, der vierte häuft sich. Und der
Haufen liegt **hinten**, nicht in der Mitte — geschüttet wird am Heck, weil dort
der Bagger steht, und Kies bleibt liegen, wo er hinfällt. Aus demselben Grund
ist in der Schaufel nichts zu sehen: sie ist von der Seite zu, und was man
sieht, ist der Stoff, der beim Kippen fällt.

Weggeräumt wird die Ladung erst am Ende der Runde — genau dann, wenn der Wagen
ganz aus dem Bild ist. Verschwände sie früher, führe ein voller Wagen plötzlich
leer davon, und die Fuhre wäre nirgends hingekommen.

Und der Wagen ist bewusst klein: niedriger als das Haus des Baggers und kurz
genug, dass er nicht die halbe Baustelle einnimmt. Zwei gleich große Maschinen
nebeneinander haben keine Hauptrolle mehr — gegraben wird hier, abgeholt wird
nur.

**Kies steht nicht wie Beton.** Wo der Zahn eindringt, sackt der Haufen ein
wenig nach (anderthalb Prozent seiner Höhe, vom Boden aus gerechnet) und über
der Zehe rieselt etwas die Böschung hinab. Man sieht es nicht als Bewegung, man
sieht nur, dass der Berg lebt — und beides fällt genau in die Zeit, in der
gegraben wird.

Was beim Kippen fällt, fällt **hinter** die nahe Bordwand: in der
Zeichenreihenfolge steht es vor dem Wagen, im Bild also dahinter, und
verschwindet auf halbem Weg in der Mulde. Andersherum rieselt der Sand sichtbar
vor dem Wagen zu Boden — und landet damit neben ihm.

**Der Berg ist weiß, nicht farbig.** Farbe braucht eine Quelle, und ein Haufen
Kies hat keine: er wäre salbeifarben, weil Salbei gerade die Normalfarbe ist,
und genau davor warnt das Design-System. Er ist der Wert, für den der Block da
ist, und damit das hellste Teil der Szene — weißer Umriss auf der schwächsten
Fläche des Systems (`--mirror-box-soft`).

**Im Block steht nur die Zeit.** Keine Beschriftung darüber: wofür der Timer
läuft, weiß der, der ihn gestellt hat, und wenn nicht, sagt es die Mitteilung,
sobald er abgelaufen ist. Die Zeile kostete Höhe, die den Ziffern fehlt, und
beantwortete eine Frage, die vor dem Spiegel niemand stellt. Damit trägt der
ganze Block keinen Akzent mehr — Weiß auf Schwarz, solange er läuft. Genau
deshalb fällt „Fertig" in Sand auf: es ist der einzige Ton, der überhaupt
vorkommt.

**Bewegt wird im Stylesheet, gerechnet wird im Modul.** Der Takt ist fest, und
ein fester Takt ist genau das, was CSS-Keyframes gut können: sie laufen im
Compositor und kosten kein JavaScript. Das Modul rechnet nur aus, wie groß der
Berg noch ist. Beide Seiten teilen sich dieselben Zahlen (`DIG` in `design.ts`,
`--dig-bucket` im Stylesheet), und ein Test hält sie gegeneinander.

Dass sich der Oberwagen im Seitenriss *spiegelt*, statt zu drehen, ist kein
Trick, sondern die richtige Ansicht: ein Bagger lädt, indem sich Kabine,
Ausleger und Kontergewicht zusammen um die Hochachse drehen, und von der Seite
gesehen wird er dabei erst schmal und steht dann andersherum. Die Raupe bleibt
stehen — daran erkennt man, dass sich der Oberwagen dreht und nicht die
Maschine kippt.

**Gezeichnet wird in Körpern und nicht in Strichen.** Ein Ausleger ist ein
Kastenträger: am Fuß dick, am Knick schlank, mit einem Bauch im Rücken. Ein
Zylinder ist ein dicker Strich mit einer dünnen Stange darin. Ein Rad hat eine
Nabe, eine Kette einen Gurt mit Leitrad, Turas und Laufrollen, ein Kipper eine
Stirnwand, ein Bordwandprofil und ein Fahrerhaus, das höher steht als beide. Aus
drei Metern sieht man von alldem nur die Silhouette — und genau deshalb muss sie
stimmen: eine Reihe gleich dicker Striche liest sich als Diagramm, ein Umriss
als Maschine. Im flachen M-Block fällt das Beiwerk weg und die Silhouette bleibt;
dort würde es zu einem Grieseln, das die Form verdeckt.

**Und gefüllt — deckend, nicht durchscheinend.** Ein Bagger ist kein
Drahtgitter: steht er vor dem Berg, muss der Berg *hinter* ihm sein, und durch
eine Schaufel sieht man keinen Sand. Dasselbe gilt für den Berg selbst und für
die Ladung: eine durchscheinende Fläche zeigt, was hinter ihr liegt — beim Berg
den Boden, den er verdeckt, bei der Ladung die Bordwand, hinter der sie liegt.
Auf Schwarz sieht eine deckende Fläche aus wie 8 % Weiß; der Unterschied fällt
erst auf, wenn etwas dahinterliegt, und dann sofort. Damit übernimmt die
Reihenfolge im SVG die Arbeit der Tiefe: Kette, dann Oberwagen, dann Arm. Nur
die Schaufel steht eine Stufe heller: sie ist das Werkzeug, dem der Blick folgt.

Der Hubzylinder des Auslegers fehlt als einziges Teil mit Absicht: er sitzt mit
einem Ende am Oberwagen und mit dem anderen am Ausleger und *fährt aus*, während
gehoben wird. Mit einer Drehung allein ist das nicht nachzubauen, und ein
Zylinder, der beim Heben mitwandert statt auszufahren, fällt mehr auf als einer,
den es nicht gibt.

Was zusammenpassen muss, prüfen Tests ohne Browser (`src/scene.ts`): dass jeder
Eimer gleich viel Fläche wegnimmt, dass der Zahn der Schaufel bei jedem Stand
und in jeder Berggröße in der Wand steht, dass die Ladung nach der Drehung über
der Mulde und nicht daneben landet, dass der Wagen erst nach dem letzten Kippen
anfährt und dass auch ganz vorgerückt nichts aus dem Feld stößt. Dieselbe
Trennung wie bei den Wettersymbolen: die Rechnung braucht keinen Browser, das
Zeichnen schon.

**Gesetzt wird der Timer in der Handy-App** — Dauer und ein Schalter, mehr
nicht. Ein Modul hat dort keine eigene Oberfläche, und jede
Konfigurationsänderung startet die Instanz neu: dieser Neustart *ist* der
Startknopf. Daraus folgt eine Eigenschaft, die man kennen muss: startet der
Spiegel neu, während der Schalter noch an steht, beginnt der Timer von vorn. Der
Core merkt sich den Zustand eines Moduls nicht über einen Neustart hinweg, und
in die Konfiguration darf ein Modul nicht schreiben — sie gehört dem Nutzer.

**Die Baustelle nimmt in jeder Blockgröße die volle Breite ein.** Im
quadratischen L-Block steht die Zeit darüber, in den flachen Blöcken *darauf* —
oben links, im leeren Himmel über dem Wagen, wo die Szene ohnehin nichts zeigt.
Der Grund ist der abfahrende Wagen: stünde die Zeit in einer eigenen Spalte,
endete die Zeichenfläche an deren Kante und der Wagen verschwände mitten im
Block wie vor einer unsichtbaren Wand. Dafür sind die Ziffern dort kleiner als
im L-Block, obwohl er kleiner ist — in einem breiten Band ist die Baustelle der
Inhalt und die Zahl die Beschriftung dazu.

Läuft kein Timer, bleibt der Block leer. Kein „kein Timer": eine leere Fläche
auf einem Spiegel ist ein Spiegel.

**Der Timer kann den Spiegel anhalten** — der Schalter *Vorrang* am Block, siehe
oben. Solange die Zeit läuft, schaltet der Spiegel nicht weiter und zeigt den
Screen, auf dem der Timer steht; ist sie um, läuft alles weiter wie zuvor. Die
Bitte endet mit der Zeit und nicht mit dem Block: danach steht dort weiter
„Fertig", und das ist eine Meldung und kein Vorgang. Ein Spiegel, der auf einem
abgelaufenen Timer stehen bliebe, wäre von einem hängenden nicht zu
unterscheiden.

### Nachts eine Stufe dunkler

Nicht dasselbe wie der Zeitplan, der den Bildschirm abschaltet: der Spiegel
bleibt an und nimmt zurück. Keine deckende Fläche, kein Akzent, kein
Weiterschalten, alle Werte auf Grau. Wer um drei Uhr aufsteht, soll eine Uhrzeit
lesen können und nicht geblendet werden — und eine Animation, die im dunklen
Zimmer im Augenwinkel läuft, weckt zuverlässig auf.

Technisch ist es ein Attribut am Wurzelelement (`data-night`), und das
Stylesheet setzt dieselben Tokens eine Stufe dunkler. So muss kein Modul von der
Nacht wissen, und keines kann sie vergessen. Eingestellt wird das Fenster unter
*Anzeige*; voreingestellt ist 22:30 bis 06:00.

### Wo die Werte stehen

Das Design-System steht doppelt: als Konstanten in `packages/sdk/src/design.ts`
und als Custom Properties in den beiden Stylesheets. Das ist Absicht — ein Modul
kann kein CSS lesen, und das Wetter muss wissen, wie lange eine Karte steht.
Doppelt heißt aber, dass beide auseinanderlaufen können; `packages/sdk/test/design.test.mjs`
liest die Stylesheets als Text und vergleicht sie mit den Konstanten.

---

## Installation auf dem Pi

Voraussetzung: **Raspberry Pi OS 64-bit (Bookworm oder neuer)** auf einem
Pi 4B oder Pi 5. Ein Pi 4 mit dem 32-Bit-Image funktioniert nicht — der
Installer bricht mit einem entsprechenden Hinweis ab.

### Installieren

Auf dem Pi, ein Befehl:

```bash
curl -fsSL https://raw.githubusercontent.com/lukas-mayr/smartmirror/main/deploy/install.sh -o /tmp/install.sh && sudo bash /tmp/install.sh
```

Erst vollständig herunterladen, dann ausführen — nicht `curl | bash`. Bei einer
abgebrochenen Verbindung würde die Pipe-Variante ein halbes Skript ausführen,
und das mitten in der Partitions- und Systemkonfiguration.

Der Installer legt den Dienstbenutzer an, installiert `cage`, Node und die
systemd-Units, holt den Signierschlüssel und das neueste Release, setzt
`vc4-kms-v3d` in der `config.txt` und den Hostnamen auf `smartmirror`, und er
richtet ein, wie der Start aussieht (siehe
[Der Startbildschirm](#der-startbildschirm)). Ein zweiter Lauf aktualisiert nur,
was sich geändert hat, und lässt Konfiguration und Kopplungen unberührt.

Danach: **`http://smartmirror.local:8080`** auf dem Handy öffnen und zum
Startbildschirm hinzufügen.

Hängt der Spiegel hochkant, gehört die Drehung gleich in den ersten Aufruf:

```bash
sudo bash /tmp/install.sh --rotate 90
```

Gedreht wird der Bildschirminhalt im Uhrzeigersinn — ein nach links gekippt
aufgehängter Bildschirm braucht `90`, ein nach rechts gekippter `270`.

Ohne Internet geht es auch aus einem lokal gebauten Paket:

```bash
sudo bash install.sh --bundle smartmirror-0.1.0-arm64.tar.gz --pubkey ./minisign.pub
```

### Einrichten

Die Einrichtung läuft in zwei Schritten, geführt von der Handy-App. Beide
Geräte zeigen dabei denselben Schritt an — der Stand steht deshalb in der
Konfiguration und nicht in einer der beiden Oberflächen.

**1. Koppeln.** Beim ersten Verbinden zeigt der Spiegel einen sechsstelligen
Code. Wer koppeln will, braucht also Sichtkontakt — für ein Gerät im eigenen
WLAN die passende Hürde, und es erspart ein Passwort, das ohnehin niemand
ändert.

**2. Ausrichten.** Danach zeigt der Spiegel einen Rahmen: genau die Fläche, die
später bespielt wird. In der App lassen sich dessen vier Kanten einzeln mit `−`
und `+` nach außen und innen schieben.

Vier Werte und nicht einer, weil der Bildschirm hinter dem Zwei-Wege-Spiegel
fast nie mittig im Rahmen sitzt: ein paar Millimeter Versatz beim Aufhängen
genügen, und der Rahmen verdeckt links mehr Pixel als rechts. Ein einziger
Randabstand kann das nicht ausgleichen — er macht den Inhalt nur kleiner, aber
nicht mittig.

Die Werte stehen in Prozent der jeweiligen Kantenlänge, damit dieselbe
Einstellung nach einem Bildschirmtausch mit anderer Auflösung noch passt. Wo es
hilft, zeigt die App daneben den ungefähren Pixelwert.

Später ändern: **Anzeige → Bildschirmfläche**. Dort lässt sich der Rahmen
jederzeit wieder einblenden — der Bildschirm rutscht beim Putzen, der Rahmen
wird getauscht. Die Kopplung bleibt dabei bestehen.

### Weitere Geräte koppeln

Ein Spiegel gehört selten einem allein: im Haushalt hat jeder ein Handy, und
auf dem iPhone sind Safari und die zum Startbildschirm hinzugefügte App zwei
getrennte Speicher — also auch zwei Geräte. Es können deshalb beliebig viele
Geräte gekoppelt sein, jedes mit eigenem Token.

Ein neues Gerät fragt in **System → Gekoppelte Geräte** nach einem Code
(**Weiteres Gerät koppeln**), oder — wenn es selbst noch nicht gekoppelt ist —
gleich auf seinem ersten Bildschirm. Der Code erscheint dann als kleine Karte
am unteren Rand des Spiegels und läuft nach fünf Minuten ab; die Anzeige läuft
daneben weiter.

Der Code kommt nur auf Anfrage. Nur beim allerersten Gerät zeigt ihn der
Spiegel von selbst — sonst legte jeder Browser, der die Adresse zufällig
öffnet, dem Spiegel einen Kopplungscode über den Inhalt, und die Wand sähe aus
wie frisch zurückgesetzt.

Dieselbe Liste zeigt zu jedem Gerät den Namen, wann es zuletzt am Spiegel war
und ob es gerade hängt. **Entkoppeln** trifft genau eines: sein Token gilt
sofort nicht mehr, die Verbindung wird getrennt, alle anderen bleiben.

### Drehen

Genau deshalb ist die Drehung keine reine App-Einstellung: Sie steht in der
Konfiguration und gilt ab dem ersten Bild, also auch für den Kopplungscode.
Stünde der quer auf einem hochkanten Bildschirm, wäre er kaum zu lesen — und
ohne ihn käme man nicht in die App, in der die Drehung sonst liegt.

Steht schon alles an der Wand und die Richtung stimmt nicht, geht es ohne
Neuinstallation und ohne Kopplung:

```bash
sudo /opt/smartmirror/current/deploy/rotate.sh 270
```

Das ändert nur dieses eine Feld und startet den Core neu. Nach der Kopplung ist
dieselbe Einstellung in der Handy-App unter **Anzeige → Ausrichtung** zu finden.
Die Drehung wirkt auch auf die Ränder aus Schritt 2: „oben“ ist immer oben aus
Sicht des Betrachters, auf einem hochkant aufgehängten Bildschirm also die
kurze Kante.

### Der Startbildschirm

Zwischen Einschalten und dem ersten Bild vergehen auf einem Pi gut vierzig
Sekunden. Ohne Zutun zeigt Linux darin, was jeder Linux zeigt: das
Regenbogenquadrat der Firmware, danach Kernel- und systemd-Zeilen und zuletzt
eine Anmeldeaufforderung, die stehen bleibt, bis die Anzeige startet.

Hinter halbdurchlässigem Glas ist das das Auffälligste am ganzen Gerät. Der
Spiegel soll aussehen wie ein Spiegel — und ausgerechnet beim Einschalten, dem
einzigen Moment, in dem jemand hinsieht, buchstabiert er, dass dahinter ein
Rechner hängt.

Stattdessen zeigt er von Anfang an sich selbst: schwarze Fläche, das Wort
**Smartmirror** in Grau, drei Punkte. Kein Fortschritt in Prozent und kein
Kreisel — beides behauptet, jemand stünde davor und warte.

**In zwei Etappen, die ineinander übergehen.** Bis die Anzeige läuft, zeichnet
Plymouth das Bild; danach zeichnet die Anzeige es selbst weiter. Dass gewechselt
wurde, soll man gar nicht merken: die drei Punkte atmen auf beiden Seiten im
selben Takt. Damit zwischen beiden kein Schwarz aufblitzt, endet Plymouth erst
nach dem Start der Anzeige und mit `--retain-splash`: das letzte Bild bleibt
stehen, bis `cage` darüber zeichnet.

Ganz ohne Naht geht es trotzdem nicht: `cage` braucht die Grafikausgabe für
sich, Plymouth muss sie also freigeben, bevor Electron sein erstes Bild hat.
Diese Sekunden bleiben schwarz — aber wenigstens nur schwarz, ohne Zeiger und
ohne Textzeilen.

**Bemalen lässt sich dieses Fenster nicht.** Sobald `cage` läuft, kann dort nur
noch ein Wayland-Client zeichnen — und der einzige, den der Spiegel hat, ist die
Anzeige selbst, also genau das, worauf gewartet wird. Plymouth kommt nicht mehr
dran: es muss die Grafikausgabe freigeben, damit `cage` sie bekommt.

**Kürzen ließ es sich auch nicht — gemessen, nicht vermutet.** Hier stand ein
Versuch, die Electron-Anwendung (knapp 200 MB) am Stück von der Karte zu lesen,
solange das Wortzeichen noch steht, damit der Start sie danach im Speicher findet
statt seitenweise auf der Karte. Drei Starts aus dem Journal:

| vorgewärmt | Kosten | schwarzes Fenster |
| --- | --- | --- |
| nichts | – | ~15 s |
| das Programm (169 MB) | 35 s | 10,0 s |
| dazu die kleinen Dateien (218 MB) | 40 s | 10,5 s |

Die Annahme dahinter — am Stück gelesen gehe dieselbe Datenmenge um ein
Vielfaches schneller — stimmt auf der Karte dieses Geräts nicht: sie liefert
knapp 5 MB/s, ob am Stück oder nicht. Und von den 10,5 Sekunden gehen nur **2,0**
auf Electron; so lange braucht es vom Start des Prozesses bis zum ersten Bild.
Die übrigen achteinhalb liegen davor, zwischen dem Start von `cage` und dem
Moment, in dem Electron überhaupt läuft: der Compositor und Chromiums eigener
Start. Daran ändert ein voller Dateisystem-Cache nichts, also ist das Vorwärmen
wieder draußen — vierzig Sekunden längerer Start für nichts.

Was bleibt, ist die Messung selbst: `cage-session.sh` schreibt „cage startet die
Anzeige", der Hauptprozess der Anzeige schreibt beim ersten Bild „[shell] erstes
Bild nach … s". Der Abstand dazwischen in `journalctl -u mirror-shell` ist genau
die Zeit, in der der Bildschirm schwarz war — auf diesem Gerät, nicht in einer
Schätzung.

Nötig sind dafür sieben Dinge, und vier davon liegen außerhalb des Releases:

- **`disable_splash=1`** in der `config.txt`. Das Regenbogenquadrat ist die
  einzige große helle Fläche im ganzen Startvorgang.
- **`disable_fw_kms_setup=0`** in derselben Datei. Raspberry Pi OS liefert die
  Zeile mit `1` aus: die Firmware richtet die Anzeige dann nicht ein, der Kernel
  tut es Sekunden später selbst — und dazwischen liegt ein Moduswechsel. Für den
  Bildschirm heißt das: Signal weg, eigenes Menü an („kein Signal", blau),
  Signal wieder da, mitten im Startbildschirm. Mit `0` stellt die Firmware den
  Modus ein und der Kernel übernimmt ihn unverändert; es gibt keinen Wechsel
  mehr, über den der Bildschirm stolpern könnte.
- **Das Thema muss ins Startabbild.** Plymouth startet aus dem `initramfs`, das
  Raspberry Pi OS seit Bookworm baut (`auto_initramfs=1`) — lange bevor das
  Wurzeldateisystem eingehängt ist. Es behält für den ganzen Start das Thema,
  das beim Bauen des Abbilds hineinkopiert wurde. Ein Thema, das nur unter
  `/usr/share/plymouth/themes` liegt, kommt deshalb nie auf den Bildschirm: zu
  sehen bliebe bis zum Schluss das, was die Distribution mitbringt. Der Dienst
  ruft dafür `update-initramfs -u` auf — aber nur, wenn sich am Thema wirklich
  etwas geändert hat, gemessen an einer Prüfsumme über seine Dateien. Sonst
  baute jedes Update ein Abbild neu, das es nicht braucht.
- **`console=tty3`** in der `cmdline.txt`. Die Konsole wandert als Ganzes auf
  ein Terminal, das nie angezeigt wird. Das ist gründlicher als `quiet`: es
  trifft auch die Meldungen, die `quiet` durchlässt — Warnungen, Fehler,
  Dateisystemprüfungen.
- **Die Anmeldeaufforderung zieht mit** auf `tty3`. Sie ganz abzuschalten wäre
  kürzer, nähme aber den letzten Weg auf ein Gerät, dessen Netzwerk nicht mehr
  geht. Mit Bildschirm und Tastatur führt **Alt+F3** weiterhin zur Anmeldung.
- **Ein unsichtbarer Mauszeiger** für `cage`. Zwischen dem Ende von Plymouth und
  dem ersten Bild von Electron ist der Compositor ein paar Sekunden allein auf
  dem Bildschirm: keine Fensterfläche, aber ein Zeiger, den er aus dem
  Cursor-Thema des Systems lädt und mitten auf das Schwarz setzt. `cursor: none`
  im Stylesheet greift dort noch nicht — es gibt die Anzeige ja noch nicht —,
  und einen Schalter zum Ausblenden hat `cage` nicht. Also bekommt es unter
  `XCURSOR_PATH` ein eigenes Thema untergeschoben, in dem jeder Zeiger aus
  lauter durchsichtigen Bildpunkten besteht (`deploy/cursor/`, erzeugt von
  `scripts/generate-cursor.mjs`).
- **Die Anzeige startet sofort**, ohne auf den Core zu warten. Vorher wartete sie
  bis zu 30 Sekunden auf dessen `/healthz`, damit der Spiegel nicht kurz „keine
  Verbindung" zeigt — und genau diese halbe Minute war das Fenster, in dem
  stattdessen die Konsole zu sehen war. Den Hinweis blendet sie jetzt aus,
  solange der Startbildschirm liegt: dass die Verbindung beim Start noch nicht
  steht, ist kein Fehler, sondern die Reihenfolge.

#### Warum das ein Dienst ist und nicht nur ein Teil des Installers

Ein Spiegel hängt an der Wand, oft im Bad, und wer ihn bedient, hat ein Handy in
der Hand und kein Terminal. Änderungen an `/boot` kämen über ein Update nie an —
der Updater tauscht ein Release aus und nicht die Einrichtung des Geräts. Wer
nicht per SSH drankommt, bliebe also dauerhaft bei der Textkonsole.

Deshalb erledigt das **`mirror-bootlook.service`**, ein Dienst, der bei jedem
Start nachsieht und nur ändert, was fehlt. Er kommt als Teil des Releases mit,
und der Updater aktiviert neue Units von selbst — ein Update und ein Neustart
genügen. Der Installer ruft dasselbe Skript auf; es gibt nur eine Fassung davon,
und damit keine zweite, die irgendwann die falsche wäre.

Fehlt Plymouth auf dem Gerät, installiert der Dienst es nach — höchstens dreimal,
danach nicht mehr, damit ein Pi ohne Netz nicht bei jedem Start apt bemüht. Klappt
es nicht, bleibt der Bildschirm bis zur Anzeige schwarz. Das ist kein Fehler, nur
weniger: schwarz sieht hinter einem Spiegel immer noch richtig aus.

#### Was dabei schiefgehen könnte

Der Dienst schreibt an der Datei, mit der der Pi bootet. Eine kaputte
`cmdline.txt` heißt: das Gerät startet nicht mehr — und genau der Fall, kein
Terminal in Reichweite, ist der Grund, warum es ihn gibt. Vier Vorkehrungen:

- Es wird nur ergänzt, nie entfernt. `console=tty1` wird ersetzt; steht dort
  schon ein anderes Terminal, wurde die Zeile von Hand angepasst und bleibt
  unberührt.
- Vor dem Schreiben wird gegengelesen: fehlt danach `root=` oder `console=`,
  passiert nichts.
- Die erste Fassung wird einmalig als `cmdline.txt.smartmirror-orig` gesichert.
- Geschrieben wird daneben und dann umbenannt — ein Stromausfall mitten im
  Schreiben hinterlässt keine halbe Kernel-Zeile.

An der `config.txt` wird nur angehängt, und zwar in einem eigenen
`[all]`-Abschnitt am Ende: die Firmware liest die Datei von oben nach unten, die
spätere Zeile gewinnt. Vorgefundene Zeilen bleiben deshalb stehen, auch
`disable_fw_kms_setup=1`. Wer die alte Einrichtung zurück will — etwa weil der
Bildschirm mit dem von der Firmware gewählten Modus schlechter zurechtkommt —,
löscht den angehängten Block wieder heraus.

#### Der Neustart, der noch fehlt

`config.txt` und `cmdline.txt` wirken erst beim nächsten Start. Wer nicht ans
Terminal kann, sähe nirgends, dass etwas geändert wurde und nur noch der Neustart
fehlt — deshalb steht es in der App: unter **System → Neustart** erscheint der
Hinweis direkt über dem Knopf, der ihn erledigt.

Ob ein Neustart aussteht, lässt sich nicht am Dateiinhalt ablesen. Der Dienst
merkt sich stattdessen, in welcher Sitzung er zuletzt etwas geändert hat
(`/proc/sys/kernel/random/boot_id`). Ist das die laufende, steht der Neustart
noch aus; ist es eine frühere, ist alles längst wirksam und der Hinweis
verschwindet von selbst.

#### Drehung und Nachtabsenkung

Beide stehen in der Konfiguration des Cores, und die ist beim allerersten Bild
noch nicht da. Die Anzeige schreibt sie deshalb mit und holt sie beim nächsten
Start hervor — sonst läge das Wortzeichen auf einem hochkant aufgehängten
Spiegel quer, und ein Update um drei Uhr nachts ließe ihn in voller Helligkeit
aufleuchten.

Plymouth kann die Konfiguration gar nicht lesen. Sein Bild liegt deshalb fertig
gedreht in vier Fassungen bei (`deploy/plymouth/<ebene>-<grad>.png`); welche
gilt, legt `mirror-bootlook.sh` an die Stelle, die das Thema lädt — und
`rotate.sh` zieht sie mit, wenn sich die Drehung ändert. Fertig gedreht und nicht
zur Laufzeit, weil eine Drehung um ein Vielfaches von 90 Grad dann pixelgenau
bleibt.

Vier Ebenen je Drehung — `mark`, `dot1`, `dot2`, `dot3` —, weil die Punkte atmen
und das Wortzeichen nicht: in einem einzigen Bild ließe sich das nicht trennen.
Jede Ebene ist so groß wie das ganze Wortzeichen und sonst leer. Damit liegen sie
übereinander, sobald jede für sich mittig sitzt, und das Thema muss keine
Koordinaten kennen, die je nach Drehung anders lauteten.

Die Bilder entstehen mit `scripts/generate-splash.mjs` aus derselben Schrift und
denselben Werten wie der Startbildschirm der Anzeige — sonst spränge das Bild
beim Übergang. Das Skript läuft von Hand und nicht in der CI: es braucht einen
Browser, und die Dateien ändern sich nur, wenn sich das Wortzeichen ändert.

#### Abschalten

Wer den Start gar nicht angefasst haben will — etwa weil der Pi noch für etwas
anderes benutzt wird:

```bash
sudo systemctl disable --now mirror-bootlook.service
```

Beim Installieren tut `--skip-boot-config` dasselbe. Die gesicherte
`cmdline.txt.smartmirror-orig` liegt daneben, falls die alte Zeile zurück soll.

### Was der Installer mit dem Signierschlüssel macht

Der öffentliche Schlüssel liegt als `minisign.pub` im Repository und wird beim
Installieren geholt und fest auf dem Gerät verankert. Er ist kein Geheimnis —
prüfen kann damit jeder, unterschreiben niemand.

Damit ist die Erstinstallation ein Vertrauensvorschuss auf das, was GitHub in
diesem Moment ausliefert. Das ist ohnehin so, denn dieses Installationsskript
kommt aus derselben Quelle; den Schlüssel zusätzlich von Hand herüberzutragen
würde daran nichts ändern, solange er vom selben Rechner stammt.

Entscheidend ist, was **danach** gilt: Der Schlüssel liegt unter
`/opt/smartmirror/minisign.pub`, und der Updater installiert nichts, was nicht
dazu passt. Ein übernommener GitHub-Zugang reicht ab diesem Punkt nicht mehr,
um Code auf den Spiegel zu bringen — dafür bräuchte es den geheimen Schlüssel,
und der liegt nicht auf GitHub, sondern nur in den Actions-Secrets und in
deinem Backup.

Wer den Schlüssel über einen wirklich getrennten Kanal beziehen will, umgeht
den Abruf mit `--pubkey ./minisign.pub`.

### Eigenes Repository verwenden

Nur nötig, wenn du einen eigenen Fork betreibst:

```bash
minisign -G -W -p minisign.pub -s minisign.key
```

`-W` erzeugt den Schlüssel ohne Passwort, weil die CI ihn nicht interaktiv
eingeben kann. Dann `minisign.pub` ins Repository-Wurzelverzeichnis committen
und beide Dateien als Actions-Secrets hinterlegen:

| Secret | Inhalt |
|---|---|
| `MINISIGN_SECRET_KEY` | vollständiger Inhalt von `minisign.key` |
| `MINISIGN_PUBLIC_KEY` | vollständiger Inhalt von `minisign.pub` |

`minisign.key` gehört **nicht** ins Repository — `.gitignore` blockt `*.key`.
Sichere ihn im Passwortmanager: ohne ihn lässt sich für bereits aufgehängte
Spiegel kein Update mehr signieren.

Installation dann mit `--repo deinname/smartmirror`.

---

## Updates

```
/opt/smartmirror/
├─ releases/1.3.0/     entpackte Releases
├─ current  -> releases/1.3.0
├─ previous -> releases/1.2.0
└─ data/               Konfiguration und Zustand – von Updates NIE berührt
```

Veröffentlichen heißt: mergen. Sonst nichts. Jeder Merge auf `main`
durchläuft `Release nach Merge`:

1. **Prüfen** – derselbe Job, der schon am Pull Request lief (Bauen,
   Typen, Tests, erzeugte Dateien).
2. **Versionieren** – die nächste Nummer wird aus dem letzten `v*`-Tag
   berechnet, mit `scripts/set-version.mjs` in die Wurzel, in jedes Paket und
   in alle internen `@mirror/*`-Abhängigkeiten geschrieben, als Commit
   `Version X.Y.Z` auf `main` abgelegt und als `vX.Y.Z` getaggt.
3. **Veröffentlichen** – die Release-Pipeline baut, signiert und lädt hoch.

Wie weit die Nummer springt, liest der Ablauf aus dem, was sich seit dem
letzten Tag geändert hat. Keine Labels, keine Vorschriften für
Commit-Nachrichten:

| Was sich geändert hat | Sprung |
| --- | --- |
| nur `README.md`, `LICENSES.md`, `docs/`, `.github/` | kein Release |
| ein Vertrag in `packages/sdk/src/` (außer der erzeugten `fonts.ts`) | Minor |
| `CONFIG_SCHEMA_VERSION` gestiegen – auf dem Spiegel läuft eine Migration | Minor |
| neue Datei unter `packages/*/src/`, `modules/` oder `deploy/` (ohne Tests) | Minor |
| alles andere | Patch |

Gegen die bisherige Historie geprüft trifft das jede Entscheidung, die früher
von Hand gefallen ist. Die Grenze ist ehrlich benannt: Der Ablauf sieht
Dateien, keine Absichten. Eine neue Funktion, die nur bestehende Dateien in
`core` oder `remote` anfasst, wird als Patch veröffentlicht – zu wenig, nie zu
viel. **Major springt nie von allein**: dass eine Änderung bricht, steht in
keinem Dateinamen. Dafür gibt es den Knopf.

Die Tags sind die Quelle der Wahrheit, nicht `package.json` – die
Versionsfelder werden aus dem Tag nachgezogen, können also nicht auseinander
laufen.

**Die Versionsnummer wird deshalb nie von Hand gesetzt.** `set-version.mjs` ist
das Werkzeug des Ablaufs und nicht eins für den Arbeitsplatz: Ein Zweig, der
seine Nummer schon selbst hochzählt, nimmt dem Ablauf genau die Änderung weg,
die er als Versions-Commit ablegen will. Bis 0.9.0 brach der Lauf daran ab —
die Prüfungen waren durch, der Stand lag auf `main`, nur getaggt und
veröffentlicht wurde er nie. Der Ablauf verträgt diesen Fall inzwischen und
setzt dann nur den Tag; von Hand hochzuzählen bleibt trotzdem überflüssig. Der Versions-Commit wird mit dem `GITHUB_TOKEN` gepusht und löst
deshalb keinen weiteren Lauf aus; auf `main` darf der Push allerdings nicht
durch einen Branch-Schutz verboten sein.

Von Hand geht weiterhin beides: der Knopf *Release nach Merge → Run workflow*
mit der Wahl `patch`/`minor`/`major` – der einzige Weg zu einem Major – und
ein selbst gesetzter Tag als Notausgang.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Die CI baut, signiert und veröffentlicht. Der Pi prüft alle 15 Minuten und
installiert dann in dieser Reihenfolge:

1. Herunterladen von GitHub Releases
2. **SHA256 prüfen**, dann **minisign-Signatur prüfen** — ohne hinterlegten
   öffentlichen Schlüssel wird gar nicht erst installiert
3. Entpacken in ein Verzeichnis, das erst danach seinen endgültigen Namen bekommt
4. `current`-Symlink atomar umsetzen, `previous` mitziehen
5. Beide Dienste neu starten
6. **Healthcheck (90 s):** Der Core muss antworten, die erwartete Version melden
   **und** die Anzeige muss sich als bereit gemeldet haben
7. Bei Fehlschlag: Symlink zurück auf `previous`, Neustart, Version auf die
   Sperrliste — sonst liefe der Spiegel in eine Update-Schleife

Von Hand: `sudo systemctl start mirror-updater.service`, oder der Knopf in der
Handy-App.

Der Knopf nimmt einen Umweg: Der Core schreibt eine Anfragedatei ins
Datenverzeichnis, und `mirror-updater.path` startet daraufhin den Updater. Den
Dienst direkt zu starten kann der Core nicht — er läuft unprivilegiert, und
polkit beantwortet den Versuch mit „Interactive authentication required". Ihm
das Recht zu geben hieße, dem einzigen ans Netz gebundenen Dienst den Start des
einzigen Dienstes mit Root-Rechten zu erlauben. Eine Datei zu schreiben, die er
ohnehin schreibt, genügt.

### Warum eine Signatur zwingend ist

Ohne sie genügt es, den GitHub-Zugang zu übernehmen oder DNS zu manipulieren,
um beliebigen Code auf einem Gerät auszuführen, das im Bad oder Flur hängt.
Eine Prüfsumme allein hilft nicht — sie kommt aus derselben Quelle wie die
Datei. Die Prüfung ist in reinem Node umgesetzt (`packages/updater/src/minisign.ts`),
damit kein zusätzliches Paket auf dem Pi nötig ist; die CI prüft mit dem echten
`minisign`-Werkzeug gegen, damit beide Implementierungen nicht auseinanderlaufen.

### Bekannter Kompromiss: Release-Größe

Ein Release ist rund **113 MB gepackt**, praktisch vollständig Electron. Weil
immer das ganze Bundle getauscht wird, ist ein Update atomar und der Rückfall
verlässlich. Getrennte Artefakte für „nur App-Code" wären kleiner, würden aber
zwei Update-Pfade einführen, die zueinander passen müssen — für ein Gerät ohne
Tastatur ein schlechter Tausch.

---

## Betrieb

```bash
journalctl -u mirror-core -u mirror-shell -u mirror-updater -f
curl -s localhost:8080/healthz
systemctl restart mirror-shell        # nur die Anzeige neu starten
```

Der Spiegel bleibt bei Verbindungsverlust bewusst ruhig: kleiner Hinweis unten
rechts statt Fehlerseite. Während eines Updates ist der Core einige Sekunden
weg — das ist kein Zustand, der Aufmerksamkeit verdient.

### Neustart aus der Handy-App

Ein Spiegel hängt an der Wand, oft im Bad, und hat weder Tastatur noch Knopf.
Wenn etwas klemmt, ist die Frage nicht, *ob* man neu startet, sondern womit man
das ohne Leiter und Laptop tut. Unter **System → Neustart** stehen dafür zwei
Stufen:

- **Anzeige neu starten** — Core und Anzeige. Nach ein paar Sekunden ist der
  Spiegel wieder da, Einstellungen und Kopplungen bleiben. Das ist der Griff für
  eine Anzeige, die hängt oder ein Modul, das nicht mehr zeichnet.
- **Spiegel neu starten** — das ganze Gerät, etwa eine Minute. Der Griff, wenn
  auch die kleinere Stufe nichts geändert hat: Netzwerk, Grafiktreiber, alles
  unterhalb der Software des Spiegels.

Die kleinere Stufe steht oben, weil sie die größere fast immer erspart. Beide
fragen einmal nach — nicht weil ein Neustart Schaden anrichtet, sondern weil er
dauert: wer im Bad steht und die Uhrzeit lesen will, hat keine Minute Zeit für
einen Fehlgriff.

**Warum das nicht einfach `systemctl` aufruft.** Der Core läuft unprivilegiert.
Ein `systemctl restart` von dort beantwortet polkit mit „Interactive
authentication required", und ihm das Recht zu geben hieße, dem einzigen ans
Netz gebundenen Dienst Kontrolle über das Gerät zu geben. Stattdessen schreibt
er eine Auftragsdatei, die `mirror-system.service` als root ausführt. Das Skript
dahinter (`deploy/mirror-system.sh`) kennt genau drei Aufträge — Dienste neu
starten, Gerät booten, Updater anstoßen — und lehnt alles andere ab.

**Abgeholt wird der Auftrag von zwei Seiten.** `mirror-system.path` bemerkt ihn
sofort, `mirror-system.timer` sieht alle zehn Sekunden nach. Das zweite gibt es
nicht aus Vorsicht, sondern aus Erfahrung: auf einem Gerät im Feld feuerten die
Path-Units nicht — weder „Jetzt prüfen" noch „Neustart" bewirkten etwas, während
der 15-Minuten-Timer des Updaters ungerührt weiterlief und Updates brachte.
Woran es lag, ließ sich aus der Ferne nicht klären; dass Timer auf demselben
Gerät zuverlässig feuern, dagegen schon. Also beides: die Path-Unit ist der
schnelle Weg, der Timer der, auf den Verlass ist.

Aus demselben Vorfall stammt die dritte Aktion. Der Knopf **Jetzt prüfen** hing
allein an `mirror-updater.path`; blieb die aus, passierte nichts — und weil der
Core seinen optimistischen Zustand nie zurücknahm, stand in der App für immer
„suche nach Updates …". Beides ist repariert: der Knopf geht jetzt über
denselben Weg wie der Neustart, und **eine Anfrage, auf die niemand reagiert,
wird nach einer Minute als Fehler gemeldet.** Ein Knopf, der nichts tut und
nichts sagt, ist schlimmer als eine Fehlermeldung.

Woran der Core merkt, ob der Updater gelaufen ist: dessen Statusdatei trägt ein
`lastCheck` und ist damit bei jedem Lauf eine andere. Bleibt sie Byte für Byte
dieselbe, war er nicht da.

Ein Detail, das nicht wie eines aussieht: der Auftrag trägt einen Zeitstempel
und gilt nur zwei Minuten. Ohne diese Grenze würde ein Stromausfall zwischen
Schreiben und Ausführen zur Endlosschleife — die Datei läge beim nächsten Start
noch da, die Path-Unit löste sofort wieder aus, und der Spiegel startete sich
beim Booten immer wieder selbst neu.

Über SSH geht beides weiterhin von Hand:

```bash
sudo systemctl restart mirror-core mirror-shell
sudo reboot
```

### Stecker ziehen

Ein Spiegel wird nicht heruntergefahren, er wird ausgeschaltet. Das ist die
normale Bedienung und keine Störung, also muss der Start damit umgehen können.

Drei Vorkehrungen, jede gegen einen beobachteten Ausfall:

- **`mirror-guard.service`** prüft vor Core und Anzeige, ob das installierte
  Release überhaupt startfähig ist, und legt `current` sonst auf das vorige
  zurück. Der Auslöser war ein Stromausfall kurz nach einem Update: `tar` hatte
  die Dateien angelegt, der Symlink zeigte darauf, der Inhalt stand aber noch im
  Schreibpuffer. Zurück blieben Dateien mit 0 Bytes — `node` auf einer leeren
  Datei endet wortlos, `cage-session.sh` scheitert mit „Exec format error", und
  systemd startete beide 167-mal im Kreis. Das Skript liegt unter
  `/opt/smartmirror/guard.sh` und damit außerhalb von `current/`: es muss genau
  dann funktionieren, wenn das Release es nicht mehr tut.
- **Der Updater synchronisiert** das entpackte Release auf die Karte, bevor er
  `current` umlegt, und die Symlinks danach. Damit ist das Zeitfenster von oben
  geschlossen statt nur abgefangen.
- **Beschädigte Zustandsdateien** halten den Spiegel nicht mehr auf. Unlesbares
  JSON wandert als `<datei>.defekt` beiseite, und der Core startet mit
  Standardwerten weiter. Vorher endete der Prozess mit Code 1, systemd startete
  ihn alle drei Sekunden neu, und eine einzige halb geschriebene Datei hielt den
  Spiegel dauerhaft schwarz. Ein Spiegel mit Werkseinstellungen ist besser als
  keiner — und das Original bleibt liegen, es ist die einzige Kopie der
  Einstellungen.

Was der Wächter beim letzten Start getan hat:

```bash
journalctl -u mirror-guard -b
```

---

## Lizenzen

Diese Software steht unter MIT. Mitgelieferte Bestandteile und ihre Lizenzen
sind in [LICENSES.md](LICENSES.md) aufgeführt — alle unter SIL OFL 1.1, ISC
oder MIT, also frei weiterverteilbar.
