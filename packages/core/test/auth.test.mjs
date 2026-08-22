import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Die Pfade des Core stehen beim Import fest. Der Speicherort muss also vor
 * dem ersten Laden gesetzt sein – deshalb ein dynamischer Import statt eines
 * Kopfes voller Imports.
 */
const dataDir = await mkdtemp(join(tmpdir(), 'mirror-auth-'));
process.env.MIRROR_DATA_DIR = dataDir;
const authFile = join(dataDir, 'auth.json');
const { AuthStore } = await import('../dist/auth.js');

async function paired(store, name) {
  const code = store.startPairing().code;
  const result = await store.redeem(code, name);
  assert.ok(result, 'Kopplung sollte gelingen');
  return result;
}

test('koppelt mehrere Geraete nebeneinander', async () => {
  await writeFile(authFile, JSON.stringify({ clients: [] }));
  const store = new AuthStore();
  await store.load();

  const first = await paired(store, 'iPhone · App');
  const second = await paired(store, 'iPad');

  assert.notEqual(first.token, second.token);
  assert.notEqual(first.device.id, second.device.id);
  // Das erste Geraet darf durch das zweite nichts verlieren.
  assert.equal(store.identify(first.token) !== null, true);
  assert.equal(store.identify(second.token) !== null, true);
  assert.equal(store.listClients().length, 2);
});

test('haengt gleichen Namen eine Nummer an', async () => {
  await writeFile(authFile, JSON.stringify({ clients: [] }));
  const store = new AuthStore();
  await store.load();

  await paired(store, 'iPhone');
  await paired(store, 'iPhone');

  assert.deepEqual(
    store.listClients().map((client) => client.name),
    ['iPhone', 'iPhone (2)'],
  );
});

test('entzieht genau ein Geraet', async () => {
  await writeFile(authFile, JSON.stringify({ clients: [] }));
  const store = new AuthStore();
  await store.load();

  const first = await paired(store, 'Handy A');
  const second = await paired(store, 'Handy B');

  assert.equal(await store.revoke(first.device.id), true);
  assert.equal(store.identify(first.token) !== null, false);
  assert.equal(store.identify(second.token) !== null, true);
  // Ein zweiter Entzug desselben Geraets ist kein Fehler, aber auch kein Treffer.
  assert.equal(await store.revoke(first.device.id), false);
});

test('ein zweiter Wunsch zieht dem ersten den Code nicht weg', async () => {
  await writeFile(authFile, JSON.stringify({ clients: [] }));
  const store = new AuthStore();
  await store.load();

  const first = store.startPairing();
  const second = store.startPairing();
  assert.equal(first.code, second.code);
});

test('verwirft den Code nach zu vielen Fehlversuchen', async () => {
  await writeFile(authFile, JSON.stringify({ clients: [] }));
  const store = new AuthStore();
  await store.load();

  const { code } = store.startPairing();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await store.redeem(wrong, 'Angreifer'), null);
  }
  assert.equal(store.pendingCode, null);
  // Auch der richtige Code hilft jetzt nicht mehr: gesperrt ist gesperrt.
  assert.equal(await store.redeem(code, 'Handy'), null);
});

test('traegt fehlende Ids aus aelteren Dateien nach', async () => {
  await writeFile(
    authFile,
    JSON.stringify({
      clients: [
        { tokenHash: 'a'.repeat(64), name: 'Altes Handy', pairedAt: '2024-01-01T10:00:00.000Z', lastSeen: '2024-01-01T10:00:00.000Z' },
      ],
    }),
  );
  const store = new AuthStore();
  await store.load();

  const [client] = store.listClients();
  assert.equal(client.name, 'Altes Handy');
  assert.ok(client.id, 'Ohne Id liesse sich das Geraet nicht einzeln entziehen');

  // Und die Id muss in der Datei stehen, sonst waere sie beim naechsten Start
  // eine andere – und die Geraeteliste am Handy verlore ihren Bezug.
  const stored = JSON.parse(await readFile(authFile, 'utf8'));
  assert.equal(stored.clients[0].id, client.id);
});

test('erkennt das Geraet zu einem Token wieder', async () => {
  await writeFile(authFile, JSON.stringify({ clients: [] }));
  const store = new AuthStore();
  await store.load();

  const { token, device } = await paired(store, 'Handy');
  assert.equal(store.identify(token)?.id, device.id);
  assert.equal(store.identify('unsinn'), null);
  assert.equal(store.identify(undefined), null);
});
