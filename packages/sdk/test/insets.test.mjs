import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustAllInsets,
  adjustInset,
  clampInset,
  createDefaultInsets,
  INSET_MAX,
  INSET_SIDES,
  INSET_STEP,
  insetsEqual,
  insetToPixels,
  normalizeInsets,
} from '../dist/insets.js';

test('vier Seiten, alle gleich, wenn nichts anderes gesagt wird', () => {
  assert.deepEqual(Object.keys(createDefaultInsets()).sort(), [...INSET_SIDES].sort());
  assert.deepEqual(createDefaultInsets(3), { top: 3, right: 3, bottom: 3, left: 3 });
});

test('begrenzt auf den erlaubten Bereich', () => {
  assert.equal(clampInset(-5), 0);
  assert.equal(clampInset(999), INSET_MAX);
});

test('rundet auf die Schrittweite', () => {
  // Wiederholtes "+"/"−" summiert sonst Gleitkommareste auf, und in der
  // Konfigurationsdatei stuende am Ende 4.499999999999999.
  let insets = createDefaultInsets(0);
  for (let i = 0; i < 10; i += 1) insets = adjustInset(insets, 'top', INSET_STEP);
  assert.equal(insets.top, 5);
  assert.equal(clampInset(2.3), 2.5);
});

test('nimmt einen einzelnen Wert an – so sah die Einstellung frueher aus', () => {
  // `paddingPercent` galt fuer alle vier Seiten. Konfigurationen aus dieser
  // Zeit und von Hand editierte Dateien duerfen nicht auf dem Standard landen.
  assert.deepEqual(normalizeInsets(7), { top: 7, right: 7, bottom: 7, left: 7 });
  assert.deepEqual(normalizeInsets('7'), { top: 7, right: 7, bottom: 7, left: 7 });
});

test('ergaenzt fehlende Seiten aus dem Rueckfallwert', () => {
  assert.deepEqual(normalizeInsets({ top: 1 }, 6), { top: 1, right: 6, bottom: 6, left: 6 });
  assert.deepEqual(normalizeInsets(null, 2), { top: 2, right: 2, bottom: 2, left: 2 });
  assert.deepEqual(normalizeInsets({ top: 'krumm' }, 2), { top: 2, right: 2, bottom: 2, left: 2 });
});

test('verschiebt einzelne und alle Kanten', () => {
  const insets = createDefaultInsets(4);
  assert.deepEqual(adjustInset(insets, 'left', 0.5), { top: 4, right: 4, bottom: 4, left: 4.5 });
  assert.deepEqual(adjustAllInsets(insets, -1), createDefaultInsets(3));
  // Nach aussen ist an der Bildschirmkante Schluss – weiter gibt es keine Pixel.
  assert.equal(adjustInset(createDefaultInsets(0), 'top', -1).top, 0);
});

test('vergleicht alle vier Seiten', () => {
  assert.equal(insetsEqual(createDefaultInsets(), createDefaultInsets()), true);
  assert.equal(insetsEqual(createDefaultInsets(), adjustInset(createDefaultInsets(), 'bottom', 0.5)), false);
});

test('rechnet fuer die Anzeige in Pixel um', () => {
  assert.equal(insetToPixels(2.5, 1080), 27);
  assert.equal(insetToPixels(0, 1920), 0);
});
