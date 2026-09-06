import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'deploy/mirror-wifi.sh');

/**
 * Das WLAN hat zwei Haelften: der Core schreibt eine Auftragsdatei, ein
 * Root-Dienst liest sie und schaltet das Netz. Sie liegen in verschiedenen
 * Sprachen und in verschiedenen Verzeichnissen, und zusammen haelt sie nichts
 * ausser dem Format dieser einen Datei – und dem der Statusdatei zurueck.
 * Geprueft werden deshalb beide Seiten gegen dieselben Dateien.
 *
 * nmcli ist dabei eine Attrappe. Der Test soll pruefen, was der Spiegel tun
 * *wuerde*, und nicht das Netzwerk der Maschine umbauen, auf der er laeuft.
 */

const dataDir = await mkdtemp(join(tmpdir(), 'mirror-wifi-'));
process.env.MIRROR_DATA_DIR = dataDir;
const { WifiBridge } = await import('../dist/wifi-bridge.js');

const anfrage = join(dataDir, 'wifi-request.json');
const status = join(dataDir, 'wifi-status.json');
const profileDir = join(dataDir, 'profile');
const nmDir = join(dataDir, 'nm');
const binDir = join(dataDir, 'bin');

await mkdir(profileDir, { recursive: true });
await mkdir(nmDir, { recursive: true });
await mkdir(binDir, { recursive: true });

/*
 * Die Attrappe.
 *
 * Sie liest dieselben Profildateien, die das Skript schreibt – nur so faellt
 * auf, wenn dort etwas anderes steht als gemeint. Ihren uebrigen Zustand
 * (welches Geraet, welches Profil aktiv, was in Reichweite) legt der Test in
 * Dateien daneben.
 */
const NMCLI = `#!/usr/bin/env bash
set -uo pipefail
NM="$FAKE_NM_DIR"
printf '%s\\n' "$*" >> "$NM/log"

# Aus den Profildateien lesen und nicht aus einer eigenen Liste: was das Skript
# geschrieben hat, ist die Wahrheit.
profile() {
  local datei id ssid
  for datei in "$MIRROR_NM_PROFILE_DIR"/*.nmconnection; do
    [[ -f "$datei" ]] || continue
    id="$(sed -n 's/^id=//p' "$datei" | head -1)"
    ssid="$(sed -n 's/^ssid=//p' "$datei" | head -1 | sed -e 's/\\\\s/ /g' -e 's/\\\\\\\\/\\\\/g')"
    printf '%s\\t%s\\t%s\\n' "$(basename "$datei" .nmconnection)" "$id" "$ssid"
  done
}

alles="$*"
case "$alles" in
  *"--fields WIFI general status"*)
    cat "$NM/radio" 2>/dev/null || printf 'enabled\\n' ;;
  *"radio wifi on"*)
    printf 'enabled\\n' > "$NM/radio" ;;
  *"--fields IN-USE,SIGNAL device wifi list"*)
    printf '*:66\\n' ;;
  *"device wifi list"*)
    cat "$NM/scan" 2>/dev/null || true ;;
  *"--fields DEVICE,TYPE,STATE device status"*)
    cat "$NM/devices" ;;
  *"--fields TYPE,STATE device status"*)
    cut -d: -f2,3 "$NM/devices" ;;
  *"--fields DEVICE,STATE device status"*)
    cut -d: -f1,3 "$NM/devices" ;;
  *"GENERAL.CONNECTION"*)
    cat "$NM/active" 2>/dev/null || true ;;
  *"--fields UUID,TYPE connection show"*)
    profile | awk -F'\\t' '{ print $1 ":802-11-wireless" }' ;;
  *"802-11-wireless-security.psk"*)
    profile | awk -F'\\t' -v n="\${*: -1}" '$1==n || $2==n { print }' ;;
  *"802-11-wireless.ssid"*)
    # Letztes Argument ist der Name oder die UUID.
    profile | awk -F'\\t' -v n="\${*: -1}" '$1==n || $2==n { print $3; exit }' ;;
  *"connection reload"*)
    : ;;
  *"connection delete uuid "*)
    rm -f "$MIRROR_NM_PROFILE_DIR/\${*: -1}.nmconnection" ;;
  *"connection down id "*)
    : > "$NM/active" ;;
  *"connection up "*)
    ziel="\${*: -1}"
    name="$(profile | awk -F'\\t' -v n="$ziel" '$1==n || $2==n { print $2; exit }')"
    if [[ -z "$name" ]]; then
      printf 'Error: unknown connection.\\n' >&2
      exit 10
    fi
    if grep -qxF "$name" "$NM/fail" 2>/dev/null; then
      printf 'Error: Connection activation failed: Secrets were required, but not provided.\\n' >&2
      exit 4
    fi
    printf '%s' "$name" > "$NM/active"
    printf '%s\\n' "$name" > "$NM/verbunden"
    ;;
  *)
    : ;;
esac
exit 0
`;

await writeFile(join(binDir, 'nmcli'), NMCLI);
await chmod(join(binDir, 'nmcli'), 0o755);

/** Setzt beide Seiten und die Attrappe zurueck. */
async function sauber({ devices = 'wlan0:wifi:disconnected\neth0:ethernet:unavailable\n', scan = '' } = {}) {
  await rm(anfrage, { force: true });
  await rm(status, { force: true });
  await rm(join(dataDir, '.wifi-offline'), { force: true });
  for (const datei of await readdir(profileDir)) await rm(join(profileDir, datei), { force: true });
  await writeFile(join(nmDir, 'devices'), devices);
  await writeFile(join(nmDir, 'scan'), scan);
  await writeFile(join(nmDir, 'active'), '');
  await writeFile(join(nmDir, 'fail'), '');
  await writeFile(join(nmDir, 'radio'), 'enabled\n');
  await rm(join(nmDir, 'log'), { force: true });
  await rm(join(nmDir, 'verbunden'), { force: true });
}

async function ausfuehren(env = {}) {
  const { stdout } = await run('bash', [script], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      MIRROR_DATA_DIR: dataDir,
      MIRROR_NM_PROFILE_DIR: profileDir,
      FAKE_NM_DIR: nmDir,
      ...env,
    },
  });
  return {
    ausgabe: stdout,
    bericht: existsSync(status) ? JSON.parse(await readFile(status, 'utf8')) : null,
    aufrufe: existsSync(join(nmDir, 'log'))
      ? (await readFile(join(nmDir, 'log'), 'utf8')).trim().split('\n').filter(Boolean)
      : [],
  };
}

async function profildateien() {
  return (await readdir(profileDir)).filter((name) => name.endsWith('.nmconnection'));
}

/* ------------------------------- Verbinden -------------------------------- */

test('legt aus einem Auftrag ein Profil an und schaltet es ein', async () => {
  await sauber();
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'geheim1234');

  const geschrieben = JSON.parse(await readFile(anfrage, 'utf8'));
  assert.equal(geschrieben.action, 'connect');
  assert.equal(geschrieben.ssid, 'Heimnetz');
  assert.ok(Number.isFinite(Date.parse(geschrieben.requestedAt)), 'braucht einen lesbaren Zeitstempel');

  const { bericht, aufrufe } = await ausfuehren();

  const dateien = await profildateien();
  assert.equal(dateien.length, 1);
  const profil = await readFile(join(profileDir, dateien[0]), 'utf8');
  assert.match(profil, /^ssid=Heimnetz$/m);
  assert.match(profil, /^psk=geheim1234$/m);
  assert.match(profil, /^key-mgmt=wpa-psk$/m);
  assert.match(profil, /^autoconnect=true$/m, 'sonst haengt der Spiegel nach dem naechsten Start wieder in der Luft');

  assert.ok(aufrufe.some((zeile) => zeile.includes('connection up id Heimnetz')));
  assert.equal(bericht.state, 'online');
  assert.equal(bericht.ssid, 'Heimnetz');
  assert.equal(bericht.answeredAt, geschrieben.requestedAt, 'sonst wartet die App fuer immer');
});

test('das Passwort steht in keinem Kommandozeilenargument', async () => {
  await sauber();
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'geheim1234');
  const { aufrufe } = await ausfuehren();

  // Argumente stehen in /proc/<pid>/cmdline und sind fuer jeden Prozess auf
  // dem Geraet lesbar. Deshalb schreibt das Skript die Profildatei selbst,
  // statt "nmcli device wifi connect ... password ..." aufzurufen.
  for (const zeile of aufrufe) {
    assert.ok(!zeile.includes('geheim1234'), `Passwort in einem nmcli-Aufruf: ${zeile}`);
  }
});

test('maskiert Leerzeichen und Backslash, damit das Passwort ankommt wie eingegeben', async () => {
  await sauber();
  const bridge = new WifiBridge();
  await bridge.requestConnect('Bei Muellers', 'mit backslash\\ und leer');
  await ausfuehren();

  const [datei] = await profildateien();
  const profil = await readFile(join(profileDir, datei), 'utf8');
  // Das Profil ist eine GKeyFile: dort leitet der Backslash eine
  // Escape-Sequenz ein, und Leerzeichen am Rand fallen weg. Unmaskiert
  // stuende hier ein anderes Passwort als eingegeben.
  assert.match(profil, /^ssid=Bei\\sMuellers$/m);
  assert.match(profil, /^psk=mit\\sbackslash\\\\\\sund\\sleer$/m);
});

test('ein falsches Passwort wird als solches gemeldet', async () => {
  await sauber();
  await writeFile(join(nmDir, 'fail'), 'Heimnetz\n');
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'falschfalsch');

  const { bericht } = await ausfuehren();
  assert.equal(bericht.state, 'offline');
  // "Secrets were required, but not provided" heisst genau das – nur versteht
  // es niemand, der vor dem Spiegel steht.
  assert.match(bericht.lastError, /Passwort/);
});

test('ohne Passwort bleibt ein gespeichertes Profil unangetastet', async () => {
  await sauber();
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'geheim1234');
  await ausfuehren();
  const [datei] = await profildateien();
  const vorher = await readFile(join(profileDir, datei), 'utf8');

  // Der Knopf "Verbinden" an einem gespeicherten Netz schickt kein Passwort.
  // Wuerde das Skript daraufhin ein neues Profil schreiben, entstuende ein
  // offenes Netz ohne Schluessel – und der Spiegel kaeme nie wieder hinein.
  await writeFile(join(nmDir, 'active'), '');
  await bridge.requestConnect('Heimnetz', '');
  const { bericht } = await ausfuehren();

  assert.deepEqual(await profildateien(), [datei]);
  assert.equal(await readFile(join(profileDir, datei), 'utf8'), vorher);
  assert.equal(bericht.state, 'online');
});

/* --------------------------------- Suchen --------------------------------- */

test('liest die Netzliste, auch wenn ein Name einen Doppelpunkt enthaelt', async () => {
  await sauber({ scan: 'Heimnetz:82:WPA2\nBei\\:Muellers:41:WPA2\nGast:60:\nHeimnetz:35:WPA2\n' });
  const bridge = new WifiBridge();
  await bridge.requestScan();

  const { bericht } = await ausfuehren();
  const namen = bericht.networks.map((netz) => netz.ssid);
  // Doppelpunkte im Namen sind in der terse-Ausgabe maskiert. Wer stumpf an
  // Doppelpunkten aufteilt, zerlegt genau diese Zeile falsch.
  // In der Reihenfolge des Suchlaufs; nach Signalstaerke sortiert wird erst
  // beim Lesen im SDK (siehe packages/sdk/test/wifi.test.mjs).
  assert.deepEqual(namen, ['Heimnetz', 'Bei:Muellers', 'Gast']);
  assert.equal(bericht.networks[0].signal, 82);
  assert.equal(bericht.networks[0].secured, true);
  // Ein leeres Sicherheitsfeld heisst: offenes Netz.
  assert.equal(bericht.networks.find((netz) => netz.ssid === 'Gast').secured, false);
  assert.ok(bericht.scannedAt, 'ohne Zeitpunkt liesse sich nicht sagen, wie alt die Liste ist');
});

test('behaelt die Netzliste, wenn ein Lauf nicht gesucht hat', async () => {
  await sauber({ scan: 'Heimnetz:82:WPA2\n' });
  const bridge = new WifiBridge();
  await bridge.requestScan();
  await ausfuehren();

  // Der Timer laeuft alle dreissig Sekunden. Wuerde jeder Lauf die Liste
  // leeren, waere sie im Einrichtungs-WLAN – wo sich nicht mehr suchen laesst –
  // nach einer halben Minute weg.
  const { bericht } = await ausfuehren();
  assert.deepEqual(bericht.networks.map((netz) => netz.ssid), ['Heimnetz']);
});

test('markiert gespeicherte Netze in der Liste', async () => {
  await sauber({ scan: 'Heimnetz:82:WPA2\nNachbar:40:WPA2\n' });
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'geheim1234');
  await ausfuehren();

  await bridge.requestScan();
  const { bericht } = await ausfuehren();
  assert.deepEqual(bericht.known, ['Heimnetz']);
  assert.equal(bericht.networks.find((netz) => netz.ssid === 'Heimnetz').known, true);
  assert.equal(bericht.networks.find((netz) => netz.ssid === 'Nachbar').known, false);
});

/* -------------------------------- Vergessen ------------------------------- */

test('vergisst ein Netz samt Profil', async () => {
  await sauber();
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'geheim1234');
  await ausfuehren();
  assert.equal((await profildateien()).length, 1);

  await bridge.requestForget('Heimnetz');
  await ausfuehren();
  assert.deepEqual(await profildateien(), []);
});

/* ---------------------------- Einrichtungs-WLAN --------------------------- */

test('macht nach mehreren Laeufen ohne Netz ein eigenes WLAN auf', async () => {
  await sauber();
  // Vier Laeufe ohne Verbindung: kein WLAN, kein Kabel. Genau der Fall, in dem
  // die Handy-App nicht mehr erreichbar waere.
  let bericht = null;
  for (let lauf = 0; lauf < 4; lauf += 1) ({ bericht } = await ausfuehren());

  assert.equal(bericht.state, 'hotspot');
  assert.equal(bericht.hotspot.active, true);
  assert.match(bericht.hotspot.ssid, /^Smartmirror-/);
  assert.equal(bericht.hotspot.passphrase.length, 8);
  assert.equal(bericht.hotspot.address, '10.42.0.1');

  const profil = await readFile(join(profileDir, 'smartmirror-einrichtung.nmconnection'), 'utf8');
  assert.match(profil, /^mode=ap$/m);
  assert.match(profil, /^method=shared$/m);
  // Von selbst darf es nie hochkommen – sonst begruesst der Spiegel nach jedem
  // Stromausfall erst einmal mit einem eigenen WLAN.
  assert.match(profil, /^autoconnect=false$/m);
});

test('macht kein eigenes WLAN auf, solange das Kabel haengt', async () => {
  await sauber({ devices: 'wlan0:wifi:disconnected\neth0:ethernet:connected\n' });
  let bericht = null;
  for (let lauf = 0; lauf < 5; lauf += 1) ({ bericht } = await ausfuehren());

  assert.equal(bericht.state, 'offline');
  assert.equal(bericht.ethernet, true);
  assert.equal(existsSync(join(profileDir, 'smartmirror-einrichtung.nmconnection')), false);
});

test('macht kein eigenes WLAN auf, wenn die Konfiguration es verbietet', async () => {
  await sauber();
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ network: { setupHotspot: false } }));
  let bericht = null;
  for (let lauf = 0; lauf < 5; lauf += 1) ({ bericht } = await ausfuehren());
  await rm(join(dataDir, 'config.json'), { force: true });

  assert.equal(bericht.state, 'offline');
  assert.equal(existsSync(join(profileDir, 'smartmirror-einrichtung.nmconnection')), false);
});

test('Name und Passwort des Einrichtungs-WLANs bleiben, was sie waren', async () => {
  await sauber();
  let bericht = null;
  for (let lauf = 0; lauf < 4; lauf += 1) ({ bericht } = await ausfuehren());
  const zuerst = { ...bericht.hotspot };

  // Wer es einmal am Handy gespeichert hat, soll beim naechsten Mal nicht
  // wieder vor dem Spiegel stehen und abschreiben muessen.
  for (let lauf = 0; lauf < 3; lauf += 1) ({ bericht } = await ausfuehren());
  assert.equal(bericht.hotspot.ssid, zuerst.ssid);
  assert.equal(bericht.hotspot.passphrase, zuerst.passphrase);
});

test('schliesst das Einrichtungs-WLAN, sobald der Spiegel wieder am Netz haengt', async () => {
  await sauber();
  for (let lauf = 0; lauf < 4; lauf += 1) await ausfuehren();

  // Das Kabel steckt wieder.
  await writeFile(join(nmDir, 'devices'), 'wlan0:wifi:disconnected\neth0:ethernet:connected\n');
  const { bericht, aufrufe } = await ausfuehren();
  assert.ok(aufrufe.some((zeile) => zeile.includes('connection down id smartmirror-einrichtung')));
  assert.notEqual(bericht.state, 'hotspot');
});

test('holt das Einrichtungs-WLAN zurueck, wenn der Versuch daneben ging', async () => {
  await sauber({ scan: 'Heimnetz:82:WPA2\n' });
  for (let lauf = 0; lauf < 4; lauf += 1) await ausfuehren();
  await writeFile(join(nmDir, 'fail'), 'Heimnetz\n');

  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'falschfalsch');
  const { bericht } = await ausfuehren();

  // Das Handy haengt gerade an diesem WLAN und wartet auf die Antwort. Zwei
  // Minuten auf den naechsten Zaehlerstand zu warten, waere ein Spiegel, der
  // einfach verschwindet.
  assert.equal(bericht.state, 'hotspot');
  assert.match(bericht.lastError, /Passwort/);
});

test('ein Strich ist kein Netz', async () => {
  await sauber();
  // nmcli meldet leere Felder je nach Fassung als "--". Wer das fuer einen
  // Namen haelt, zeigt einen Spiegel als verbunden, der an nichts haengt – und
  // macht deshalb auch nie sein Einrichtungs-WLAN auf.
  await writeFile(join(nmDir, 'active'), '--');
  const { bericht } = await ausfuehren();
  assert.equal(bericht.state, 'offline');
  assert.equal(bericht.ssid, null);
});

test('waehrend des Verbindens wird nichts aufgemacht', async () => {
  await sauber({ devices: 'wlan0:wifi:connecting (getting IP configuration)\neth0:ethernet:unavailable\n' });
  let bericht = null;
  for (let lauf = 0; lauf < 6; lauf += 1) ({ bericht } = await ausfuehren());

  // Das Einrichtungs-WLAN jetzt zu oeffnen hiesse, genau den Versuch
  // abzubrechen, der gerade laeuft.
  assert.equal(bericht.state, 'connecting');
  assert.equal(existsSync(join(profileDir, 'smartmirror-einrichtung.nmconnection')), false);
});

/* ------------------------------- Abweisungen ------------------------------ */

test('raeumt den Auftrag weg, bevor er ihn ausfuehrt', async () => {
  await sauber();
  const bridge = new WifiBridge();
  await bridge.requestConnect('Heimnetz', 'geheim1234');
  await ausfuehren();
  // In dieser Datei steht ein WLAN-Passwort. Dass sie sofort verschwindet, ist
  // nicht Aufraeumen, sondern der Punkt.
  assert.equal(existsSync(anfrage), false);
});

test('verwirft einen Auftrag, der den Stromausfall ueberlebt hat', async () => {
  await sauber();
  const alt = new Date(Date.now() - 60 * 60_000).toISOString();
  await writeFile(anfrage, JSON.stringify({ action: 'connect', ssid: 'Heimnetz', passphrase: 'x', requestedAt: alt }));

  const { ausgabe, bericht } = await ausfuehren();
  assert.match(ausgabe, /verworfen/);
  assert.deepEqual(await profildateien(), []);
  assert.equal(bericht.answeredAt, null);
});

test('verwirft einen Auftrag aus der Zukunft – die Uhr des Pi kann falsch stehen', async () => {
  await sauber();
  const spaeter = new Date(Date.now() + 60 * 60_000).toISOString();
  await writeFile(anfrage, JSON.stringify({ action: 'connect', ssid: 'Heimnetz', passphrase: 'x', requestedAt: spaeter }));

  const { ausgabe } = await ausfuehren();
  assert.match(ausgabe, /Zukunft/);
  assert.deepEqual(await profildateien(), []);
});

test('fuehrt nur die vier bekannten Auftraege aus', async () => {
  await sauber();
  await writeFile(anfrage, JSON.stringify({ action: 'halt', requestedAt: new Date().toISOString() }));

  const { ausgabe } = await ausfuehren();
  assert.match(ausgabe, /Unbekannter Auftrag/);
  assert.equal(existsSync(anfrage), false);
});

test('ein Netzname mit Zeilenumbruch kommt nicht in eine Profildatei', async () => {
  await sauber();
  await writeFile(
    anfrage,
    JSON.stringify({ action: 'connect', ssid: 'Heim\nautoconnect=false', passphrase: 'geheim1234', requestedAt: new Date().toISOString() }),
  );

  // Eine neue Zeile in einer Profildatei ist dort eine neue Einstellung.
  const { bericht } = await ausfuehren();
  assert.deepEqual(await profildateien(), []);
  assert.match(bericht.lastError, /Netznamen/);
});

test('eine unlesbare Datei ist kein Grund, irgendetwas zu tun', async () => {
  await sauber();
  await writeFile(anfrage, 'kein json');

  const { aufrufe } = await ausfuehren();
  assert.ok(!aufrufe.some((zeile) => zeile.includes('connection up')));
  assert.equal(existsSync(anfrage), false);
});

test('schaltet ein abgeschaltetes Funkteil wieder ein', async () => {
  await sauber();
  await writeFile(join(nmDir, 'radio'), 'disabled\n');
  // Ein per rfkill abgeschaltetes WLAN ist von aussen nicht von einem kaputten
  // zu unterscheiden: keine Netze, keine Meldung.
  const { aufrufe } = await ausfuehren();
  assert.ok(aufrufe.some((zeile) => zeile.includes('radio wifi on')));
});

/* --------------------------------- Bruecke -------------------------------- */

test('meldet einen Auftrag als unbeantwortet, wenn niemand reagiert', async () => {
  await sauber();
  const bridge = new WifiBridge({ pollMs: 10, graceMs: 30 });
  await writeFile(
    status,
    JSON.stringify({ updatedAt: new Date().toISOString(), state: 'offline', answeredAt: null }),
  );

  const meldungen = [];
  bridge.on('status', (wert) => meldungen.push(wert));
  bridge.start();
  await bridge.requestConnect('Heimnetz', 'geheim1234');
  await new Promise((fertig) => setTimeout(fertig, 200));
  bridge.stop();

  // Ein Knopf, der nichts tut und nichts sagt, ist schlimmer als eine
  // Fehlermeldung – die Lehre aus dem Updater, der genau so haengen blieb.
  assert.ok(meldungen.some((wert) => wert?.pending === 'connect'), 'erst sagen, dass etwas laeuft');
  assert.ok(
    meldungen.some((wert) => /nicht reagiert/.test(wert?.lastError ?? '')),
    'und dann, dass niemand geantwortet hat',
  );
});
