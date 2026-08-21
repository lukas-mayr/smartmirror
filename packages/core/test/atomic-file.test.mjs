import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../dist/atomic-file.js';

const imVerzeichnis = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-atomic-'));
  return { dir, datei: join(dir, 'config.json') };
};

test('schreibt und liest zurueck', async () => {
  const { datei } = await imVerzeichnis();
  await writeJsonAtomic(datei, { deviceName: 'Flur', display: { rotation: 90 } });
  assert.deepEqual(await readJson(datei), { deviceName: 'Flur', display: { rotation: 90 } });
});

test('laesst keine Temporaerdateien liegen', async () => {
  const { dir, datei } = await imVerzeichnis();
  await writeJsonAtomic(datei, { a: 1 });
  await writeJsonAtomic(datei, { a: 2 });
  assert.deepEqual(await readdir(dir), ['config.json']);
});

test('eine fehlende Datei ist kein Fehler', async () => {
  const { dir } = await imVerzeichnis();
  assert.equal(await readJson(join(dir, 'gibtsnicht.json')), null);
});

test('abgeschnittenes JSON haelt den Spiegel nicht auf', async () => {
  // Genau der Zustand nach einem Stromausfall mitten im Schreiben: die Datei
  // existiert, ihr Inhalt ist unbrauchbar. Frueher flog der Fehler bis in den
  // Start des Core und der Spiegel blieb schwarz.
  const { dir, datei } = await imVerzeichnis();
  await writeFile(datei, '{ "deviceName": "Fl');

  assert.equal(await readJson(datei), null);

  // Das Kaputte bleibt daneben liegen – es ist die einzige Kopie der
  // Einstellungen.
  assert.deepEqual((await readdir(dir)).sort(), ['config.json.defekt']);
  assert.equal(await readFile(`${datei}.defekt`, 'utf8'), '{ "deviceName": "Fl');
});

test('auch eine Datei der Groesse 0 wird weggeraeumt', async () => {
  const { datei } = await imVerzeichnis();
  await writeFile(datei, '');
  assert.equal(await readJson(datei), null);
});

test('nach dem Wegraeumen laesst sich neu schreiben', async () => {
  // Der Weg zurueck in den Normalbetrieb: der Core legt seine
  // Standardkonfiguration an, als haette es die Datei nie gegeben.
  const { datei } = await imVerzeichnis();
  await writeFile(datei, 'kaputt');
  await readJson(datei);
  await writeJsonAtomic(datei, { schemaVersion: 2 });
  assert.deepEqual(await readJson(datei), { schemaVersion: 2 });
});
