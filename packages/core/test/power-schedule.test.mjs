import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledState } from '../dist/power.js';

/** Baut eine minimale Konfiguration nur mit den fuer den Zeitplan noetigen Feldern. */
const withRules = (rules, scheduleEnabled = true) => ({
  power: { scheduleEnabled, rules, manualOverride: null },
});

/** 2026-08-20 ist ein Donnerstag (Wochentag 4). */
const at = (hours, minutes = 0) => new Date(2026, 7, 20, hours, minutes);

test('ohne aktiven Zeitplan ist das Display immer an', () => {
  assert.equal(scheduledState(withRules([], false), at(3)), true);
});

test('normales Tagesfenster', () => {
  const config = withRules([{ id: 'a', days: [4], on: '06:00', off: '23:00' }]);
  assert.equal(scheduledState(config, at(5, 59)), false);
  assert.equal(scheduledState(config, at(6, 0)), true);
  assert.equal(scheduledState(config, at(22, 59)), true);
  assert.equal(scheduledState(config, at(23, 0)), false);
});

test('Fenster ueber Mitternacht bleibt nach 0 Uhr aktiv', () => {
  // Genau der Fall, den eine naive Vergleichslogik falsch macht.
  const config = withRules([{ id: 'nacht', days: [4], on: '20:00', off: '02:00' }]);
  assert.equal(scheduledState(config, at(19, 59)), false);
  assert.equal(scheduledState(config, at(20, 0)), true);
  assert.equal(scheduledState(config, at(23, 30)), true);
  assert.equal(scheduledState(config, at(1, 30)), true);
  assert.equal(scheduledState(config, at(2, 0)), false);
});

test('Regeln fuer andere Wochentage greifen nicht', () => {
  const config = withRules([{ id: 'wochenende', days: [0, 6], on: '08:00', off: '23:00' }]);
  assert.equal(scheduledState(config, at(12)), false);
});

test('mehrere Fenster am selben Tag', () => {
  const config = withRules([
    { id: 'morgens', days: [4], on: '06:00', off: '09:00' },
    { id: 'abends', days: [4], on: '17:00', off: '23:00' },
  ]);
  assert.equal(scheduledState(config, at(7)), true);
  assert.equal(scheduledState(config, at(12)), false);
  assert.equal(scheduledState(config, at(18)), true);
});

test('unlesbare Uhrzeiten schalten nicht versehentlich ab', () => {
  // Lieber ein Spiegel, der leuchtet, als einer, der wegen eines Tippfehlers
  // in der Konfiguration dauerhaft schwarz bleibt.
  const config = withRules([{ id: 'kaputt', days: [4], on: 'abends', off: '??' }]);
  assert.equal(scheduledState(config, at(3)), true);
});
