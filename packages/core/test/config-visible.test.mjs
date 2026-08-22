import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Der Store liest sein Verzeichnis beim Laden des Moduls aus der Umgebung.
 * Deshalb erst die Wurzel setzen, dann importieren – und deshalb steht dieser
 * Fall in einer eigenen Datei: node --test gibt jeder Datei einen eigenen
 * Prozess, und eine gesetzte Wurzel wirkte sonst in die anderen Tests hinein.
 */
const root = await mkdtemp(join(tmpdir(), 'mirror-config-'));
process.env.MIRROR_APP_ROOT = root;

const { ConfigStore } = await import('../dist/config-store.js');

const schreibe = async (config) => {
  await mkdir(join(root, '.data'), { recursive: true });
  await writeFile(join(root, '.data', 'config.json'), JSON.stringify(config), 'utf8');
};

const instanz = (id, extra = {}) => ({
  id,
  moduleId: id.split('-')[0],
  screenId: 'screen-1',
  x: 0,
  y: 0,
  zone: 'main',
  size: 'l',
  enabled: true,
  config: {},
  ...extra,
});

test('ein Block ohne Platz raeumt keinem anderen den seinen weg', async () => {
  // Beide liegen auf 0,0. Sichtbar waere das eine Ueberlappung und der zweite
  // wiche aus – unsichtbar gibt es nichts, wovor er ausweichen muesste.
  await schreibe({
    schemaVersion: 6,
    screens: [{ id: 'screen-1', name: 'Screen 1', durationSeconds: 20, layout: 'grid' }],
    instances: [
      instanz('calendar-1', { visible: false }),
      instanz('weather-1'),
    ],
  });

  const store = new ConfigStore();
  const config = await store.load();
  const kalender = config.instances.find((entry) => entry.id === 'calendar-1');
  const wetter = config.instances.find((entry) => entry.id === 'weather-1');

  assert.equal(kalender.visible, false);
  // Der sichtbare bleibt, wo er war – der unsichtbare hat ihn nicht verdraengt.
  assert.deepEqual({ x: wetter.x, y: wetter.y }, { x: 0, y: 0 });
  // Und der unsichtbare behaelt seine Koordinaten fuer den Tag, an dem er
  // wieder eingeblendet wird.
  assert.deepEqual({ x: kalender.x, y: kalender.y }, { x: 0, y: 0 });
  // Laufen tut er trotzdem.
  assert.equal(kalender.enabled, true);
});

test('ohne Angabe ist ein Block sichtbar', async () => {
  await schreibe({
    schemaVersion: 6,
    screens: [{ id: 'screen-1', name: 'Screen 1', durationSeconds: 20, layout: 'grid' }],
    instances: [instanz('clock-1')],
  });
  const config = await new ConfigStore().load();
  assert.equal(config.instances[0].visible, true);
});
