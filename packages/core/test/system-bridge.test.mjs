import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'deploy/mirror-system.sh');

/**
 * Der Neustart hat zwei Haelften: der Core schreibt eine Auftragsdatei, ein
 * Root-Dienst liest sie. Sie liegen in verschiedenen Sprachen und in
 * verschiedenen Verzeichnissen, und nichts haelt sie zusammen ausser dem
 * Format dieser einen Datei. Die Tests hier pruefen deshalb beide Seiten gegen
 * dieselbe Datei und nicht jede Seite gegen ihre eigene Vorstellung davon.
 */

// Ein Verzeichnis fuer die ganze Datei: paths.js liest MIRROR_DATA_DIR beim
// Import, und ein Modul wird nur einmal geladen. Pro Test neu zu setzen haette
// nur so ausgesehen, als wirke es.
const dataDir = await mkdtemp(join(tmpdir(), 'mirror-system-'));
process.env.MIRROR_DATA_DIR = dataDir;
const { requestRestart } = await import('../dist/system-bridge.js');

const anfrage = join(dataDir, 'system-request.json');

// Attrappe statt echtem systemctl: der Test soll pruefen, was aufgerufen
// wuerde, und nicht die Maschine neu starten, auf der er laeuft.
const binDir = join(dataDir, 'bin');
const protokoll = join(dataDir, 'systemctl.log');
await mkdir(binDir);
await writeFile(join(binDir, 'systemctl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${protokoll}\n`);
await chmod(join(binDir, 'systemctl'), 0o755);

/** Setzt beide Seiten zurueck, damit kein Test den naechsten faerbt. */
async function sauber() {
  await rm(anfrage, { force: true });
  await rm(protokoll, { force: true });
}

async function ausfuehren() {
  const { stdout } = await run('bash', [script], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, MIRROR_DATA_DIR: dataDir },
  });
  const aufrufe = existsSync(protokoll)
    ? (await readFile(protokoll, 'utf8')).trim().split('\n').filter(Boolean)
    : [];
  return { ausgabe: stdout, aufrufe };
}

test('schreibt fuer "services" einen Auftrag, den das Skript ausfuehrt', async () => {
  await sauber();
  await requestRestart('services');

  const geschrieben = JSON.parse(await readFile(anfrage, 'utf8'));
  assert.equal(geschrieben.action, 'restart-services');
  assert.ok(Number.isFinite(Date.parse(geschrieben.requestedAt)), 'braucht einen lesbaren Zeitstempel');

  assert.deepEqual((await ausfuehren()).aufrufe, ['restart mirror-core.service mirror-shell.service']);
});

test('schreibt fuer "device" einen Auftrag, der das Geraet neu startet', async () => {
  await sauber();
  await requestRestart('device');

  assert.equal(JSON.parse(await readFile(anfrage, 'utf8')).action, 'reboot');
  assert.deepEqual((await ausfuehren()).aufrufe, ['--no-block reboot']);
});

test('raeumt den Auftrag weg, bevor er ihn ausfuehrt', async () => {
  await sauber();
  await requestRestart('device');
  await ausfuehren();
  // Sonst faende die Path-Unit ihn nach dem Neustart wieder vor – und der
  // Spiegel startete beim Booten endlos neu.
  assert.equal(existsSync(anfrage), false);
});

test('verwirft einen Auftrag, der den Stromausfall ueberlebt hat', async () => {
  await sauber();
  const alt = new Date(Date.now() - 60 * 60_000).toISOString();
  await writeFile(anfrage, JSON.stringify({ action: 'reboot', requestedAt: alt }));

  const { aufrufe, ausgabe } = await ausfuehren();
  assert.deepEqual(aufrufe, []);
  assert.match(ausgabe, /verworfen/);
});

test('verwirft einen Auftrag aus der Zukunft – die Uhr des Pi kann falsch stehen', async () => {
  await sauber();
  const spaeter = new Date(Date.now() + 60 * 60_000).toISOString();
  await writeFile(anfrage, JSON.stringify({ action: 'reboot', requestedAt: spaeter }));

  const { aufrufe, ausgabe } = await ausfuehren();
  assert.deepEqual(aufrufe, []);
  assert.match(ausgabe, /Zukunft/);
});

test('fuehrt nur die beiden bekannten Auftraege aus', async () => {
  await sauber();
  await writeFile(anfrage, JSON.stringify({ action: 'halt', requestedAt: new Date().toISOString() }));

  const { aufrufe, ausgabe } = await ausfuehren();
  assert.deepEqual(aufrufe, []);
  assert.match(ausgabe, /Unbekannter Auftrag/);
});

test('ein Auftrag mit Leerzeichen bringt das Skript nicht aus dem Tritt', async () => {
  await sauber();
  // Frueher trennte das Skript an Leerzeichen: davon landete "rm" im Auftrag
  // und "-rf" im Zeitstempel, und es stuerzte in der Rechnung darunter ab –
  // statt abzulehnen.
  await writeFile(anfrage, JSON.stringify({ action: 'rm -rf /', requestedAt: new Date().toISOString() }));

  const { aufrufe } = await ausfuehren();
  assert.deepEqual(aufrufe, []);
  assert.equal(existsSync(anfrage), false);
});

test('eine unlesbare Datei ist kein Grund, irgendetwas zu tun', async () => {
  await sauber();
  await writeFile(anfrage, 'kein json');

  const { aufrufe } = await ausfuehren();
  assert.deepEqual(aufrufe, []);
  assert.equal(existsSync(anfrage), false);
});

test('ohne Auftrag passiert nichts', async () => {
  await sauber();
  assert.deepEqual((await ausfuehren()).aufrufe, []);
});
