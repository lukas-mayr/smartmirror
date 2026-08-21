import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidManifest } from '../dist/manifest.js';

const base = { id: 'mein-modul', name: 'Mein Modul', version: '1.0.0' };

const rejects = (manifest, teil) =>
  assert.throws(() => assertValidManifest(manifest, 'test'), (error) => error.message.includes(teil));

test('ein Manifest ohne Groessenangabe ist gueltig', () => {
  assertValidManifest(base, 'test');
  assertValidManifest({ ...base, sizes: ['m', 'xl'], preferredSize: 'm' }, 'test');
});

test('lehnt unbrauchbare Groessenangaben ab', () => {
  rejects({ ...base, sizes: [] }, 'nicht leere Liste');
  rejects({ ...base, sizes: ['riesig'] }, 'unbekannte Blockgroesse');
  rejects({ ...base, preferredSize: 'riesig' }, 'keine Blockgroesse');
});

test('lehnt einen Vorschlag ab, den das Modul selbst nicht anbietet', () => {
  // Ein Fehler im Manifest und keine Auslegungsfrage: sonst haette das Modul
  // beim Hinzufuegen eine Groesse, die es danach nie wieder bekommen kann.
  rejects({ ...base, sizes: ['l', 'xl'], preferredSize: 's' }, 'steht nicht in "sizes"');
});
