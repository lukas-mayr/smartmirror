import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeNotifications,
  parseEntries,
  parseEntry,
  VISIBLE,
  visibleWindow,
} from '../dist/shared.js';

/* ------------------------------- Eintraege -------------------------------- */

test('liest Woher, Was und Zusatz aus einer Zeile', () => {
  const entry = parseEntry('Termin · in 18 min | Standup | 09:30 · Kueche', 0);
  assert.deepEqual(entry, {
    id: 'entry-0',
    label: 'Termin · in 18 min',
    title: 'Standup',
    meta: '09:30 · Kueche',
    urgent: false,
    expiresAt: null,
  });
});

test('nimmt eine Zeile ohne Trennzeichen als das, was sie ist', () => {
  // Wer nur "Muell rausstellen" eintippt, meint einen Titel und keine kaputte
  // Zeile – und die Anzeige soll ihn zeigen, nicht ihn verwerfen.
  const entry = parseEntry('Muell rausstellen', 3);
  assert.equal(entry.title, 'Muell rausstellen');
  assert.equal(entry.label, '');
  assert.equal(entry.meta, '');
});

test('macht ein Ausrufezeichen am Anfang dringend', () => {
  const entry = parseEntry('!Paket | Zustellung heute', 0);
  assert.equal(entry.urgent, true);
  assert.equal(entry.label, 'Paket');
  assert.equal(entry.title, 'Zustellung heute');
});

test('ueberspringt leere Zeilen statt Luecken zu zeigen', () => {
  const entries = parseEntries('Standup\n\n   \nZahnarzt\n');
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ['Standup', 'Zahnarzt'],
  );
});

test('verwirft eine Zeile ohne Titel', () => {
  // "Termin |" ist eine Herkunft ohne Aussage – dafuer gibt es keine Zeile.
  assert.equal(parseEntry('Termin |', 0), null);
  assert.equal(parseEntry('   ', 0), null);
});

/* -------------------------------- Auswahl --------------------------------- */

const NOW = new Date('2026-08-22T10:00:00.000Z');

const item = (id, extra = {}) => ({
  id,
  label: '',
  title: id,
  meta: '',
  urgent: false,
  expiresAt: null,
  ...extra,
});

test('laesst Abgelaufenes heraus', () => {
  // "Bus in 7 min" von vor einer Stunde ist keine veraltete Information,
  // sondern eine falsche.
  const items = [
    item('alt', { expiresAt: '2026-08-22T09:00:00.000Z' }),
    item('gilt', { expiresAt: '2026-08-22T11:00:00.000Z' }),
    item('ohne Ende'),
  ];
  assert.deepEqual(
    activeNotifications(items, NOW).map((entry) => entry.id),
    ['gilt', 'ohne Ende'],
  );
});

test('zieht Dringendes nach oben und laesst den Rest in Ruhe', () => {
  const items = [item('a'), item('b'), item('dringend', { urgent: true }), item('c')];
  assert.deepEqual(
    activeNotifications(items, NOW).map((entry) => entry.id),
    ['dringend', 'a', 'b', 'c'],
  );
});

test('behandelt einen unlesbaren Zeitstempel als "gilt weiter"', () => {
  // Lieber eine Mitteilung zu lang als eine, die wegen eines Tippfehlers in
  // einem Kommando nie erscheint.
  assert.equal(activeNotifications([item('x', { expiresAt: 'unsinn' })], NOW).length, 1);
});

/* ------------------------------- Positionen ------------------------------- */

test('besetzt hoechstens drei Positionen', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
  assert.equal(visibleWindow(items, 0).length, VISIBLE);
});

test('rueckt eine Position weiter und laeuft dabei im Kreis', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => item(id));
  const ids = (offset) => visibleWindow(items, offset).map((entry) => entry.id);
  assert.deepEqual(ids(0), ['a', 'b', 'c']);
  assert.deepEqual(ids(1), ['b', 'c', 'd']);
  assert.deepEqual(ids(3), ['d', 'a', 'b']);
  // Nach einer vollen Runde steht wieder derselbe Eintrag oben.
  assert.deepEqual(ids(4), ids(0));
});

test('wiederholt nichts, wenn es weniger gibt als Plaetze', () => {
  // Derselbe Termin dreimal untereinander sieht nach einem Fehler aus.
  const items = [item('a'), item('b')];
  assert.deepEqual(
    visibleWindow(items, 7).map((entry) => entry.id),
    ['a', 'b'],
  );
});

test('bleibt bei genau drei Eintraegen stehen', () => {
  // Nachruecken auf drei Plaetzen bei drei Eintraegen waere Bewegung ohne
  // Inhalt – dieselbe Liste, nur verschoben.
  const items = ['a', 'b', 'c'].map((id) => item(id));
  assert.deepEqual(
    visibleWindow(items, 2).map((entry) => entry.id),
    ['a', 'b', 'c'],
  );
});

test('gibt fuer eine leere Liste nichts zurueck', () => {
  assert.deepEqual(visibleWindow([], 0), []);
});
