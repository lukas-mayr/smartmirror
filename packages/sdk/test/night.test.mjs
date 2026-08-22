import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NIGHT_MODE, isNightNow, normalizeNightMode } from '../dist/config.js';

/** Ein Zeitpunkt in der lokalen Zeitzone – isNightNow rechnet in Ortszeit. */
const at = (hours, minutes = 0) => new Date(2026, 7, 22, hours, minutes);

test('laeuft ueber Mitternacht hinweg', () => {
  // Der Normalfall: 22:30 bis 06:00 ist ein Fenster, das den Tageswechsel
  // ueberspringt. Eine naive Spanne "von kleiner nach groesser" waere hier
  // durchgehend aus.
  const night = { enabled: true, from: '22:30', to: '06:00' };
  assert.equal(isNightNow(night, at(23, 0)), true);
  assert.equal(isNightNow(night, at(3, 14)), true);
  assert.equal(isNightNow(night, at(22, 29)), false);
  assert.equal(isNightNow(night, at(12, 0)), false);
});

test('schliesst den Anfang ein und das Ende aus', () => {
  // Sonst waere eine Minute im Jahr doppelt oder gar nicht abgedeckt.
  const night = { enabled: true, from: '22:30', to: '06:00' };
  assert.equal(isNightNow(night, at(22, 30)), true);
  assert.equal(isNightNow(night, at(6, 0)), false);
  assert.equal(isNightNow(night, at(5, 59)), true);
});

test('kommt auch mit einem Fenster innerhalb eines Tages zurecht', () => {
  const window = { enabled: true, from: '13:00', to: '15:00' };
  assert.equal(isNightNow(window, at(14, 0)), true);
  assert.equal(isNightNow(window, at(12, 59)), false);
  assert.equal(isNightNow(window, at(15, 0)), false);
});

test('ist aus, wenn die Absenkung aus ist', () => {
  assert.equal(isNightNow({ enabled: false, from: '00:00', to: '23:59' }, at(3, 0)), false);
});

test('behandelt ein leeres Fenster als aus und nicht als immer', () => {
  // "von 6 bis 6" heisst nicht "immer" – wer beide Zeiten gleich setzt, hat
  // die Absenkung faktisch abgeschaltet, und der Spiegel soll dann nicht
  // rund um die Uhr grau sein.
  assert.equal(isNightNow({ enabled: true, from: '06:00', to: '06:00' }, at(3, 0)), false);
});

test('faellt bei unlesbaren Zeiten auf aus zurueck', () => {
  assert.equal(isNightNow({ enabled: true, from: 'spaet', to: '06:00' }, at(3, 0)), false);
});

/* ------------------------------ Normalisierung ----------------------------- */

test('raeumt Zeiten auf und faellt sonst auf die Voreinstellung zurueck', () => {
  assert.deepEqual(normalizeNightMode({ enabled: true, from: '7:05', to: '9:00' }), {
    enabled: true,
    from: '07:05',
    to: '09:00',
  });
  assert.deepEqual(normalizeNightMode({ from: '25:00', to: '10:61' }), {
    enabled: true,
    from: DEFAULT_NIGHT_MODE.from,
    to: DEFAULT_NIGHT_MODE.to,
  });
  assert.deepEqual(normalizeNightMode(null), DEFAULT_NIGHT_MODE);
});

test('nimmt ein ausdrueckliches Aus ernst', () => {
  // Fehlt das Feld, gilt die Voreinstellung (an). Steht dort `false`, nicht.
  assert.equal(normalizeNightMode({}).enabled, true);
  assert.equal(normalizeNightMode({ enabled: false }).enabled, false);
});
