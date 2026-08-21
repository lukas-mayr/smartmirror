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

test('faehrt mit einer zu neuen Config unveraendert weiter', () => {
  const input = { schemaVersion: CONFIG_SCHEMA_VERSION + 1, display: {} };
  const { config, changed } = migrateToLatest(input, silent);
  assert.equal(changed, false);
  assert.equal(config, input);
});
