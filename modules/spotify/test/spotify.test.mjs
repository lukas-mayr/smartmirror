import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accentFromPixels, elapsedFraction, extractCode, formatTime, nextShown, REDIRECT_URI } from '../dist/shared.js';

test('rechnet den Fortschritt zwischen zwei Antworten weiter', () => {
  const sampledAt = new Date('2026-01-01T12:00:00Z').toISOString();
  const state = { playing: true, durationMs: 200_000, progressMs: 100_000, sampledAt };
  const now = Date.parse(sampledAt) + 50_000;
  assert.equal(elapsedFraction(state, now), 0.75);
});

test('laesst den Balken stehen, solange die Musik steht', () => {
  const sampledAt = new Date('2026-01-01T12:00:00Z').toISOString();
  const state = { playing: false, durationMs: 200_000, progressMs: 100_000, sampledAt };
  const now = Date.parse(sampledAt) + 60_000;
  assert.equal(elapsedFraction(state, now), 0.5);
});

test('laeuft nicht ueber das Ende des Titels hinaus', () => {
  const sampledAt = new Date('2026-01-01T12:00:00Z').toISOString();
  // Passiert bei jedem Titelwechsel: die Anzeige rechnet weiter, waehrend die
  // naechste Antwort noch unterwegs ist.
  const state = { playing: true, durationMs: 10_000, progressMs: 9_000, sampledAt };
  assert.equal(elapsedFraction(state, Date.parse(sampledAt) + 60_000), 1);
});

test('bleibt bei fehlenden Angaben bei null', () => {
  assert.equal(elapsedFraction({}), 0);
  assert.equal(elapsedFraction({ durationMs: 1_000 }), 0);
});

test('formatiert Zeiten als Minuten und Sekunden', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9_000), '0:09');
  assert.equal(formatTime(187_000), '3:07');
  assert.equal(formatTime(3_600_000), '1:00:00');
});

test('die Redirect-URI ist eine Loopback-Adresse', () => {
  // Spotify nimmt seit April 2025 nur noch HTTPS oder Loopback. Faellt das
  // hier auseinander, laesst sich die App im Dashboard nicht mehr anlegen.
  const url = new URL(REDIRECT_URI);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
});

test('liest den Code aus der eingefuegten Adresse', () => {
  const url = `${REDIRECT_URI}?code=AQD_abc-123&state=xyz`;
  assert.equal(extractCode(url), 'AQD_abc-123');
});

test('nimmt auch den blanken Code an', () => {
  assert.equal(extractCode('  AQD_abc-123  '), 'AQD_abc-123');
});

test('erkennt eine abgelehnte Anmeldung', () => {
  assert.throws(
    () => extractCode(`${REDIRECT_URI}?error=access_denied`),
    (error) => error.message.includes('access_denied'),
  );
});

test('sagt es, wenn in der Adresse kein Code steht', () => {
  assert.throws(
    () => extractCode(`${REDIRECT_URI}?foo=bar`),
    (error) => error.message.includes('kein Code'),
  );
});

test('schaltet der Reihe nach durch die aktiven Konten', () => {
  assert.equal(nextShown([1, 3, 5], 1), 3);
  assert.equal(nextShown([1, 3, 5], 3), 5);
  assert.equal(nextShown([1, 3, 5], 5), 1);
});

test('beginnt vorne, wenn der Gezeigte weggefallen ist', () => {
  // Konto 3 hat die Musik gestoppt, waehrend es zu sehen war.
  assert.equal(nextShown([1, 5], 3), 1);
  assert.equal(nextShown([2], null), 2);
});

test('ohne aktive Konten wird niemand gezeigt', () => {
  assert.equal(nextShown([], 1), null);
});

test('zieht aus einem roten Cover einen roten Akzent', () => {
  // 4 Pixel sattes Rot (RGBA).
  const pixels = new Uint8ClampedArray([220, 30, 30, 255, 220, 30, 30, 255, 220, 30, 30, 255, 220, 30, 30, 255]);
  assert.equal(accentFromPixels(pixels), 'hsl(0, 70%, 65%)');
});

test('mittelt Rottoene um den Nullpunkt herum nicht zu Cyan', () => {
  // 350 und 10 Grad muessen bei 0 landen, nicht bei 180.
  const pixels = new Uint8ClampedArray([
    230, 25, 60, 255, // ~350 Grad
    230, 60, 25, 255, // ~10 Grad
  ]);
  const accent = accentFromPixels(pixels);
  const hue = Number(/hsl\((\d+)/.exec(accent)[1]);
  assert.ok(hue <= 15 || hue >= 345, `Farbton ${hue} liegt nicht bei Rot`);
});

test('ein graues Cover gibt keinen Akzent her', () => {
  const pixels = new Uint8ClampedArray([128, 128, 128, 255, 40, 40, 40, 255, 200, 200, 200, 255]);
  assert.equal(accentFromPixels(pixels), null);
});
