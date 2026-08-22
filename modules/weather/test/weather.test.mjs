import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accentForTemperature, describeWeather, toCelsius } from '../dist/shared.js';

test('faerbt kalt blau und warm bernstein', () => {
  assert.equal(accentForTemperature(-5), '#6f9ad6');
  assert.equal(accentForTemperature(28), '#d99a4e');
});

test('bleibt zwischen den Endpunkten', () => {
  // In der Mitte der Spanne liegt jeder Kanal zwischen beiden Enden.
  const middle = accentForTemperature(11.5);
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(middle.slice(start, start + 2), 16));
  assert.ok(r > 0x6f && r < 0xd9, `Rot ausserhalb der Spanne: ${middle}`);
  assert.equal(g, 0x9a);
  assert.ok(b > 0x4e && b < 0xd6, `Blau ausserhalb der Spanne: ${middle}`);
});

test('kappt Ausreisser statt sie hochzurechnen', () => {
  // Minus vierzig Grad ist nicht "noch blauer" – die Spanne endet.
  assert.equal(accentForTemperature(-40), accentForTemperature(-5));
  assert.equal(accentForTemperature(50), accentForTemperature(28));
});

test('faellt bei fehlender Temperatur auf Grau zurueck', () => {
  assert.equal(accentForTemperature(Number.NaN), '#9a9aa3');
});

test('rechnet Fahrenheit in Celsius um', () => {
  assert.equal(toCelsius(32, 'imperial'), 0);
  assert.equal(Math.round(toCelsius(212, 'imperial')), 100);
  // Metrisch bleibt die Zahl, wie sie ist.
  assert.equal(toCelsius(18, 'metric'), 18);
});

test('gibt unbekannten Wettercodes trotzdem ein Symbol', () => {
  assert.deepEqual(describeWeather(4242), { label: 'Unbekannt', icon: 'cloud' });
});

test('unterscheidet Tag und Nacht nur dort, wo es einen Unterschied macht', () => {
  assert.equal(describeWeather(0, true).icon, 'sun');
  assert.equal(describeWeather(0, false).icon, 'moon');
  // Regen sieht nachts nicht anders aus.
  assert.equal(describeWeather(63, false).icon, 'cloud-rain');
});
