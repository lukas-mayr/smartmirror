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
| **Updater** | `mirror-updater.service` + `.timer` + `.path` | Prüft GitHub Releases, verifiziert Signaturen, tauscht Symlinks, rollt bei fehlgeschlagenem Healthcheck zurück. Einziger Teil mit Root-Rechten. Der Timer prüft regelmäßig, die Path-Unit startet ihn sofort, wenn die App darum bittet. |

Der Updater ist ein eigener Dienst, weil er genau die Dateien ersetzt, aus
denen der Core läuft, und ihn danach neu startet — im selben Prozess würde er
sich selbst unter den Füßen wegziehen.

```
packages/
  sdk/       Modul-Verträge, WebSocket-Protokoll, Konfigurationstypen
  core/      Server
  shell/     Anzeige-Anwendung (Electron)
  remote/    Handy-App (PWA)
  updater/   OTA-Agent
  icons/     Flache Strichsymbole, aus Lucide generiert
modules/
  clock/     Uhrzeit und Datum (rein im Frontend)
  weather/   Open-Meteo, mit Cache und Offline-Zustand
deploy/      systemd-Units, Compositor-Start, Installer, Drehung
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
neues Modul braucht keinerlei eigene UI im Client. Wie groß der Block sein soll,
in dem das Modul erscheint, schlägt das Manifest mit `preferredSize` vor
(`"s"`, `"m"`, `"l"` oder `"xl"` — siehe [Screens, Raster und
Blöcke](#screens-raster-und-blöcke)).

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
erreichen das Frontend nie.

---

## Screens, Raster und Blöcke

Die Anzeige ist ein **Raster** (voreingestellt 6 × 4 Felder, quer; hochkant
4 × 6). Jedes Modul liegt darin als **Block** in einer von vier Größen — wie die
Widgets auf einem Telefon:

| Größe | Felder | gedacht für |
|---|---|---|
| **S** | 1 × 1 | eine Zahl, ein Symbol |
| **M** | 2 × 1 | Uhrzeit, ein Wert mit Beschriftung |
| **L** | 2 × 2 | Wetter mit Vorhersage, Terminliste |
| **XL** | 4 × 2 | eine Zeile, die über die halbe Wand geht |

Ein Block rastet ein: Abstände stimmen von selbst, und eine Anordnung lässt sich
in einem Satz beschreiben. Freie Pixelpositionen gäbe es nur um den Preis, dass
niemand sie mit dem Daumen auf einem Handybildschirm trifft.

**Mehrere Screens.** Ein Screen ist eine vollständige Anordnung. Der Spiegel
schaltet sie im Kreis weiter; die Standzeit steht am Screen und nicht global —
ein Blick auf die Uhr braucht keine zwei Minuten, eine Einkaufsliste schon.
Screens ohne Inhalt werden übersprungen, sonst stünde die Wand zwanzig Sekunden
schwarz und sähe kaputt aus. Alle Screens bleiben dabei im Dokument und werden
nur überblendet: die Module laufen weiter und holen ihre Daten nicht bei jedem
Wechsel neu.

**Angeordnet wird am Handy**, auf einem Brett, das den Spiegel im Kleinen zeigt
— gleiches Seitenverhältnis, gleiche Ränder, gleiches Raster. Ein Block wird mit
dem Finger gezogen und rastet ein; ein Umriss zeigt dabei, wo er landet, und
färbt sich rot, wenn dort schon etwas liegt. Solange die Modulseite offen ist,
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

Das Manifest schlägt mit `"preferredSize": "l"` nur die Größe beim Hinzufügen
vor. Wohin der Block gehört, weiß allein der Nutzer.

---

## Gestaltung hinter dem Spiegel

Die Regeln im Basis-Stylesheet sind keine Geschmacksfrage, sondern Physik:

- Hintergrund **exakt `#000000`**. Jeder Grauwert leuchtet durch die
  Spiegelfolie und verrät, dass dahinter ein Bildschirm hängt.
- Keine `box-shadow`, `text-shadow`, `filter: blur()` — daraus werden hinter
  halbdurchlässigem Glas Lichthöfe.
- Keine großen hellen Flächen: sie blenden und zeichnen den Displayrahmen nach.
- Schriftschnitt 300–400. Sehr dünne Schnitte wirken durch die Folie
  ausgewaschen.
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
`vc4-kms-v3d` in der `config.txt` und den Hostnamen auf `smartmirror`. Ein
zweiter Lauf aktualisiert nur, was sich geändert hat, und lässt Konfiguration
und Kopplungen unberührt.

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

Veröffentlichen heißt: Tag setzen.

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
