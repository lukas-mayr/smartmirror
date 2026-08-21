import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedFraction, extractCode, formatTime, REDIRECT_URI } from '../dist/shared.js';

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
