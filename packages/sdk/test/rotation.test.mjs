import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRotation, normalizeRotation, ROTATIONS } from '../dist/rotation.js';

test('erlaubt genau die vier rechten Winkel', () => {
  assert.deepEqual([...ROTATIONS], [0, 90, 180, 270]);
  for (const rotation of ROTATIONS) assert.equal(isRotation(rotation), true);
  assert.equal(isRotation(45), false);
  assert.equal(isRotation('90'), false);
});

test('nimmt Zahlen als Zeichenkette an', () => {
  // So kommen sie aus dem <select> der Handy-App und aus --rotate im Installer.
  assert.equal(normalizeRotation('90'), 90);
  assert.equal(normalizeRotation('270'), 270);
});

test('faellt bei allem Unbrauchbaren auf quer zurueck', () => {
  // Wichtiger Fall: eine von Hand editierte Konfiguration. Ein krummer Wert
  // darf die Anzeige nicht schraeg stellen, sondern nur nicht drehen.
  assert.equal(normalizeRotation(45), 0);
  assert.equal(normalizeRotation(-90), 0);
  assert.equal(normalizeRotation('hochkant'), 0);
  assert.equal(normalizeRotation(undefined), 0);
  assert.equal(normalizeRotation(null), 0);
  assert.equal(normalizeRotation(''), 0);
});
