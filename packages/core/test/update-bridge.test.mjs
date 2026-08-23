import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Der Core startet den Updater nicht selbst - er legt eine Datei hin und
 * wartet darauf, dass der Updater seine Statusdatei schreibt. Beide Haelften
 * gehoeren verschiedenen Prozessen, und dazwischen liegt systemd.
 *
 * Auf einem Geraet im Feld blieb genau diese Uebergabe aus: die Path-Unit
 * feuerte nicht, der Updater lief nie, und die App zeigte fuer immer "suche
 * nach Updates ...". Nicht weil der Fehler schwer zu finden gewesen waere,
 * sondern weil ihn niemand sehen konnte. Die Tests hier halten fest, dass eine
 * unbeantwortete Anfrage sichtbar wird.
 */

const dataDir = await mkdtemp(join(tmpdir(), 'mirror-update-'));
process.env.MIRROR_DATA_DIR = dataDir;
const { UpdateBridge } = await import('../dist/update-bridge.js');

const statusDatei = join(dataDir, 'update-status.json');
const anfrageDatei = join(dataDir, 'update-request.json');
const systemDatei = join(dataDir, 'system-request.json');

const POLL_MS = 20;
const GRACE_MS = 150;

async function schreibeStatus(patch = {}) {
  await writeFile(
    statusDatei,
    JSON.stringify({ phase: 'idle', currentVersion: '1.0.0', blocked: [], ...patch }, null, 2),
  );
}

/** Wartet, bis die Bedingung gilt – oder bis die Geduld am Ende ist. */
async function bis(bedingung, grenzeMs = 3_000) {
  const ende = Date.now() + grenzeMs;
  while (Date.now() < ende) {
    if (bedingung()) return true;
    await new Promise((weiter) => setTimeout(weiter, 10));
  }
  return false;
}

async function bruecke() {
  await rm(anfrageDatei, { force: true });
  await rm(systemDatei, { force: true });
  const instanz = new UpdateBridge({ pollMs: POLL_MS, graceMs: GRACE_MS });
  instanz.start();
  return instanz;
}

test('bittet den Systemdienst, den Updater zu starten', async () => {
  await schreibeStatus();
  const bridge = await bruecke();
  try {
    await bridge.requestCheck();
    // Frueher haing der Knopf allein an mirror-updater.path. Blieb die aus,
    // passierte nichts – und niemand erfuhr davon.
    assert.equal(JSON.parse(await readFile(systemDatei, 'utf8')).action, 'run-updater');
    assert.equal(JSON.parse(await readFile(anfrageDatei, 'utf8')).action, 'check');
  } finally {
    bridge.stop();
  }
});

test('meldet es, wenn der Updater auf die Anfrage nicht reagiert', async () => {
  await schreibeStatus();
  const bridge = await bruecke();
  try {
    await bridge.requestCheck();
    assert.equal(bridge.status.phase, 'checking', 'der Knopf soll sofort reagieren');

    // Der Updater laeuft nicht: die Statusdatei bleibt, wie sie war.
    const gemeldet = await bis(() => bridge.status.lastError !== undefined);
    assert.ok(gemeldet, 'nach der Schonfrist muss der Ausfall benannt werden');
    assert.match(bridge.status.lastError, /nicht reagiert/);
    // Und der Zustand faellt auf das zurueck, was tatsaechlich in der Datei
    // steht – statt fuer immer auf "checking" stehen zu bleiben.
    assert.equal(bridge.status.phase, 'idle');
  } finally {
    bridge.stop();
  }
});

test('uebernimmt, was der Updater meldet, sobald er sich meldet', async () => {
  await schreibeStatus();
  const bridge = await bruecke();
  try {
    await bridge.requestCheck();
    assert.equal(bridge.status.phase, 'checking');

    // So meldet sich der Updater: mit frischem lastCheck, also bei jedem Lauf
    // anders. Genau daran erkennt der Core, dass er gelaufen ist.
    await schreibeStatus({ lastCheck: new Date().toISOString(), availableVersion: '1.1.0' });

    const uebernommen = await bis(() => bridge.status.availableVersion === '1.1.0');
    assert.ok(uebernommen, 'die Meldung des Updaters muss ankommen');
    assert.equal(bridge.status.phase, 'idle');
    assert.equal(bridge.status.lastError, undefined);
  } finally {
    bridge.stop();
  }
});

test('bleibt ohne offene Anfrage bei dem, was in der Datei steht', async () => {
  await schreibeStatus({ availableVersion: '2.0.0' });
  const bridge = await bruecke();
  try {
    const gelesen = await bis(() => bridge.status.availableVersion === '2.0.0');
    assert.ok(gelesen);
    // Ohne Anfrage darf nie ein Ausfall gemeldet werden, egal wie lange die
    // Datei unveraendert bleibt.
    await new Promise((weiter) => setTimeout(weiter, GRACE_MS * 2));
    assert.equal(bridge.status.lastError, undefined);
  } finally {
    bridge.stop();
  }
});
