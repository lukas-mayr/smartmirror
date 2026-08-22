import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateToLatest } from '../dist/migrations/index.js';
import { CONFIG_SCHEMA_VERSION } from '../../sdk/dist/config.js';

const silent = () => {};

test('macht aus dem einen Randabstand vier Raender', () => {
  const { config, changed } = migrateToLatest(
    { schemaVersion: 2, display: { paddingPercent: 6, rotation: 90 } },
    silent,
  );
  assert.equal(changed, true);
  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  // Nach dem Update muss der Spiegel genauso aussehen wie vorher.
  assert.deepEqual(config.display.insets, { top: 6, right: 6, bottom: 6, left: 6 });
  assert.equal(config.display.paddingPercent, undefined);
  assert.equal(config.display.rotation, 90);
});

test('schickt einen laufenden Spiegel nicht in die Einrichtung', () => {
  const { config } = migrateToLatest({ schemaVersion: 2, display: {} }, silent);
  assert.equal(config.setup.step, 'done');
  // Ohne Zeitstempel: der gefuehrte Durchlauf hat nie stattgefunden. Der Start
  // erkennt daran, dass ein Geraet ohne gekoppeltes Handy doch fragen muss.
  assert.equal(config.setup.completedAt, null);
});

test('laeuft von Version 1 in einem Rutsch durch', () => {
  const { config } = migrateToLatest({ schemaVersion: 1, display: { paddingPercent: 2 } }, silent);
  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(config.display.rotation, 0);
  assert.deepEqual(config.display.insets, { top: 2, right: 2, bottom: 2, left: 2 });
});

test('ueberschreibt nichts, was schon da ist', () => {
  // Nach einem zurueckgerollten Update steht die Versionsnummer wieder tiefer,
  // die neuen Felder aber schon in der Datei.
  const { config } = migrateToLatest(
    {
      schemaVersion: 2,
      display: { paddingPercent: 4, insets: { top: 1, right: 2, bottom: 3, left: 4 } },
      setup: { step: 'frame', completedAt: null },
    },
    silent,
  );
  assert.deepEqual(config.display.insets, { top: 1, right: 2, bottom: 3, left: 4 });
  assert.equal(config.setup.step, 'frame');
});

test('macht aus Zonen Rasterplaetze', () => {
  const { config } = migrateToLatest(
    {
      schemaVersion: 3,
      display: { insets: { top: 4, right: 4, bottom: 4, left: 4 }, rotation: 0 },
      instances: [
        { id: 'clock-1', moduleId: 'clock', zone: 'top-center', order: 0, enabled: true, config: {} },
        { id: 'weather-1', moduleId: 'weather', zone: 'top-right', order: 0, enabled: true, config: {} },
      ],
    },
    silent,
  );

  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.deepEqual(config.display.grid, { columns: 6, rows: 4 });
  assert.equal(config.screens.length, 1);

  // Wer seinen Spiegel eingerichtet hatte, findet danach alles ungefaehr dort
  // wieder, wo es vorher war: Mitte oben bleibt Mitte oben.
  const [clock, weather] = config.instances;
  assert.deepEqual({ x: clock.x, y: clock.y }, { x: 2, y: 0 });
  assert.deepEqual({ x: weather.x, y: weather.y }, { x: 4, y: 0 });
  assert.equal(clock.screenId, config.screens[0].id);
  assert.equal(clock.order, undefined);
  // Die alte Zonen-Zeichenkette ist weg; `zone` heisst ab Version 5 das Band
  // der Szene und ist etwas anderes. Die Uhr landet dort immer im Kopf.
  assert.equal(clock.zone, 'head');
  assert.equal(weather.zone, 'head');
});

test('stapelt zwei Module aus derselben Zone untereinander', () => {
  const { config } = migrateToLatest(
    {
      schemaVersion: 3,
      display: {},
      instances: [
        { id: 'a-1', moduleId: 'clock', zone: 'top-left', order: 1 },
        { id: 'b-1', moduleId: 'clock', zone: 'top-left', order: 0 },
      ],
    },
    silent,
  );
  // `order` entscheidet, wer den Wunschplatz zuerst bekommt.
  const first = config.instances.find((entry) => entry.id === 'b-1');
  const second = config.instances.find((entry) => entry.id === 'a-1');
  assert.deepEqual({ x: first.x, y: first.y }, { x: 0, y: 0 });
  assert.deepEqual({ x: second.x, y: second.y }, { x: 0, y: 1 });
});

test('dreht das Raster fuer einen hochkant aufgehaengten Spiegel', () => {
  const { config } = migrateToLatest(
    { schemaVersion: 3, display: { rotation: 90 }, instances: [{ id: 'c-1', moduleId: 'clock', zone: 'bottom-right' }] },
    silent,
  );
  assert.deepEqual(config.display.grid, { columns: 4, rows: 6 });
  // Unten rechts bleibt unten rechts, auch wenn das Raster anders steht.
  assert.deepEqual({ x: config.instances[0].x, y: config.instances[0].y }, { x: 2, y: 5 });
});

test('laesst schon vorhandene Rasterplaetze stehen', () => {
  // Nach einem zurueckgerollten Update steht die Versionsnummer wieder auf 3,
  // die Plaetze aber schon in der Datei.
  const { config } = migrateToLatest(
    {
      schemaVersion: 3,
      display: {},
      screens: [{ id: 'screen-2', name: 'Abends', durationSeconds: 45 }],
      instances: [{ id: 'clock-1', moduleId: 'clock', screenId: 'screen-2', x: 1, y: 2, size: 'xl' }],
    },
    silent,
  );
  assert.deepEqual(config.screens, [
    { id: 'screen-2', name: 'Abends', durationSeconds: 45, layout: 'grid' },
  ]);
  assert.deepEqual(
    { x: config.instances[0].x, y: config.instances[0].y, size: config.instances[0].size },
    { x: 1, y: 2, size: 'xl' },
  );
});

test('faehrt mit einer zu neuen Config unveraendert weiter', () => {
  const input = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, display: {} };
  const { config, changed } = migrateToLatest(input, silent);
  assert.equal(changed, false);
  assert.equal(config, input);
});

test('ergaenzt Anordnungsart, Band und Nachtabsenkung', () => {
  const { config } = migrateToLatest(
    {
      schemaVersion: 4,
      display: { grid: { columns: 4, rows: 10 } },
      screens: [{ id: 'screen-1', name: 'Screen 1', durationSeconds: 20 }],
      instances: [
        { id: 'clock-1', moduleId: 'clock', screenId: 'screen-1', x: 0, y: 4, size: 'l' },
        { id: 'weather-1', moduleId: 'weather', screenId: 'screen-1', x: 0, y: 4, size: 'l' },
        { id: 'spotify-1', moduleId: 'spotify', screenId: 'screen-1', x: 0, y: 8, size: 'xl' },
        { id: 'bus-1', moduleId: 'bus', screenId: 'screen-1', x: 3, y: 0, size: 's' },
      ],
    },
    silent,
  );

  // Bestehende Screens bleiben im freien Raster – ein Update ordnet die Wand
  // nicht ungefragt neu an.
  assert.equal(config.screens[0].layout, 'grid');

  const zone = (id) => config.instances.find((entry) => entry.id === id).zone;
  // Die Uhr gehoert in den Kopf, egal wo sie im Raster lag.
  assert.equal(zone('clock-1'), 'head');
  // Sonst entscheidet die Zeile: oberstes Fuenftel Kopf, unterstes Fussband.
  assert.equal(zone('bus-1'), 'head');
  assert.equal(zone('weather-1'), 'main');
  assert.equal(zone('spotify-1'), 'foot');

  assert.deepEqual(config.display.nightMode, { enabled: true, from: '22:30', to: '06:00' });
});

test('laesst eine schon gesetzte Anordnung und ein gesetztes Band stehen', () => {
  // Nach einem zurueckgerollten Update steht die Versionsnummer wieder auf 4,
  // die neuen Felder aber schon in der Datei.
  const { config } = migrateToLatest(
    {
      schemaVersion: 4,
      display: { nightMode: { enabled: false, from: '23:00', to: '05:30' } },
      screens: [{ id: 'screen-1', name: 'Screen 1', durationSeconds: 20, layout: 'zones' }],
      instances: [{ id: 'clock-1', moduleId: 'clock', screenId: 'screen-1', x: 0, y: 0, zone: 'foot' }],
    },
    silent,
  );
  assert.equal(config.screens[0].layout, 'zones');
  assert.equal(config.instances[0].zone, 'foot');
  assert.deepEqual(config.display.nightMode, { enabled: false, from: '23:00', to: '05:30' });
});
