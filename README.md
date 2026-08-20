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
| **Updater** | `mirror-updater.service` + `.timer` | Prüft GitHub Releases, verifiziert Signaturen, tauscht Symlinks, rollt bei fehlgeschlagenem Healthcheck zurück. Einziger Teil mit Root-Rechten. |

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
deploy/      systemd-Units, Compositor-Start, Installer
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
neues Modul braucht keinerlei eigene UI im Client.

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

---

## Installation auf dem Pi

Voraussetzung: **Raspberry Pi OS 64-bit (Bookworm oder neuer)** auf einem
Pi 4B oder Pi 5. Ein Pi 4 mit dem 32-Bit-Image funktioniert nicht — der
Installer bricht mit einem entsprechenden Hinweis ab.

### 1. Signierschlüssel erzeugen (einmalig, auf dem eigenen Rechner)

```bash
minisign -G -W -p minisign.pub -s minisign.key
```

`-W` erzeugt den Schlüssel ohne Passwort, weil die CI ihn nicht interaktiv
eingeben kann. Beide Dateien als GitHub-Secrets hinterlegen:

| Secret | Inhalt |
|---|---|
| `MINISIGN_SECRET_KEY` | vollständiger Inhalt von `minisign.key` |
| `MINISIGN_PUBLIC_KEY` | vollständiger Inhalt von `minisign.pub` |

`minisign.key` gehört **nicht** ins Repository.

### 2. Installieren

```bash
curl -fsSL https://raw.githubusercontent.com/lukas-mayr/smartmirror/main/deploy/install.sh -o install.sh
sudo bash install.sh --repo lukas-mayr/smartmirror --pubkey ./minisign.pub
```

Ohne GitHub-Repository geht es auch aus einem lokal gebauten Paket:
`sudo bash install.sh --bundle smartmirror-0.1.0-arm64.tar.gz --pubkey ./minisign.pub`

Der Installer legt den Dienstbenutzer an, installiert `cage`, Node und die
systemd-Units, holt das neueste Release, setzt `vc4-kms-v3d` in der
`config.txt` und den Hostnamen auf `smartmirror`. Ein zweiter Lauf aktualisiert
nur, was sich geändert hat, und lässt Konfiguration und Kopplungen unberührt.

Danach: **`http://smartmirror.local:8080`** auf dem Handy öffnen und zum
Startbildschirm hinzufügen.

### 3. Koppeln

Beim ersten Verbinden zeigt der Spiegel einen sechsstelligen Code. Wer koppeln
will, braucht also Sichtkontakt — für ein Gerät im eigenen WLAN die passende
Hürde, und es erspart ein Passwort, das ohnehin niemand ändert.

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

---

## Lizenzen

Diese Software steht unter MIT. Mitgelieferte Bestandteile und ihre Lizenzen
sind in [LICENSES.md](LICENSES.md) aufgeführt — alle unter SIL OFL 1.1, ISC
oder MIT, also frei weiterverteilbar.
