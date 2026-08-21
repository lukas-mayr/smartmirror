import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultSetup, isSetupStep, normalizeSetup, setupStepNumber, withSetupStep } from '../dist/setup.js';

test('beginnt beim Kopplungscode', () => {
  assert.deepEqual(createDefaultSetup(), { step: 'pair', completedAt: null });
});

test('kennt genau drei Schritte', () => {
  assert.equal(isSetupStep('pair'), true);
  assert.equal(isSetupStep('frame'), true);
  assert.equal(isSetupStep('done'), true);
  assert.equal(isSetupStep('rahmen'), false);
});

test('faellt bei Unbrauchbarem auf den Anfang zurueck', () => {
  assert.deepEqual(normalizeSetup(undefined), { step: 'pair', completedAt: null });
  assert.deepEqual(normalizeSetup({ step: 'irgendwas' }), { step: 'pair', completedAt: null });
});

test('setzt den Zeitstempel genau einmal', () => {
  // Er beantwortet "war dieser Spiegel schon einmal fertig eingerichtet?" –
  // am Start haengt daran, ob eine alte Konfiguration in die Einrichtung geht.
  const frame = withSetupStep(createDefaultSetup(), 'frame');
  assert.equal(frame.completedAt, null);

  const done = withSetupStep(frame, 'done');
  assert.equal(typeof done.completedAt, 'string');

  const again = withSetupStep(withSetupStep(done, 'frame'), 'done');
  assert.equal(again.completedAt, done.completedAt);
});

test('zaehlt die Schritte fuer die Fortschrittsanzeige', () => {
  assert.equal(setupStepNumber('pair'), 1);
  assert.equal(setupStepNumber('frame'), 2);
  assert.equal(setupStepNumber('done'), 3);
});
