import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feedDescription,
  feedIcon,
  fitCount,
  parseEntries,
  parseEntry,
  restOpacity,
  slotCount,
  VISIBLE_MAX,
  VISIBLE_MIN,
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
    at: null,
    expiresAt: null,
    source: 'notifications',
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

/* ------------------------------ Hilfsgeruest ------------------------------ */

const item = (id, extra = {}) => ({
  id,
  label: '',
  title: id,
  meta: '',
  urgent: false,
  at: null,
  expiresAt: null,
  source: 'test',
  ...extra,
});

/* ------------------------------- Positionen ------------------------------- */

test('besetzt so viele Positionen, wie es Plaetze gibt', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
  assert.equal(visibleWindow(items, 0, 3).length, 3);
  assert.equal(visibleWindow(items, 0, 5).length, 5);
});

test('rueckt eine Position weiter und laeuft dabei im Kreis', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => item(id));
  const ids = (offset) => visibleWindow(items, offset, 3).map((entry) => entry.id);
  assert.deepEqual(ids(0), ['a', 'b', 'c']);
  assert.deepEqual(ids(1), ['b', 'c', 'd']);
  assert.deepEqual(ids(3), ['d', 'a', 'b']);
  // Nach einer vollen Runde steht wieder derselbe Eintrag oben.
  assert.deepEqual(ids(4), ids(0));
});

test('wiederholt nichts, wenn es weniger gibt als Plaetze', () => {
  // Derselbe Termin zweimal untereinander sieht nach einem Fehler aus.
  const items = [item('a'), item('b')];
  assert.deepEqual(
    visibleWindow(items, 7, 5).map((entry) => entry.id),
    ['a', 'b'],
  );
});

test('bleibt stehen, wenn genau alle Eintraege Platz haben', () => {
  // Nachruecken auf vier Plaetzen bei vier Eintraegen waere Bewegung ohne
  // Inhalt – dieselbe Liste, nur verschoben.
  const items = ['a', 'b', 'c', 'd'].map((id) => item(id));
  assert.deepEqual(
    visibleWindow(items, 2, 4).map((entry) => entry.id),
    ['a', 'b', 'c', 'd'],
  );
});

test('gibt fuer eine leere Liste nichts zurueck', () => {
  assert.deepEqual(visibleWindow([], 0, 3), []);
  assert.deepEqual(visibleWindow([item('a')], 0, 0), []);
});

/* --------------------------------- Plaetze -------------------------------- */

test('fuellt einen hohen Block mit mehr Positionen als einen flachen', () => {
  // Dieselbe Rechnung wie im Stylesheet: oben 108 px, darunter je 80 px plus
  // 16 px Abstand.
  assert.equal(fitCount(244, 800), 2);
  assert.equal(fitCount(500, 800), 5);
  assert.ok(fitCount(200, 400) < fitCount(900, 900));
});

test('gibt auch ohne brauchbares Mass noch die oberste Position her', () => {
  // Lieber eine Mitteilung zu gross als ein Block, der nichts zeigt: gemessen
  // wird vor dem ersten Zeichnen, und da steht die Liste noch auf null.
  assert.equal(fitCount(0, 0), VISIBLE_MIN);
  assert.equal(fitCount(-50, 800), VISIBLE_MIN);
  assert.equal(fitCount(Number.NaN, 800), VISIBLE_MIN);
});

test('schneidet keine Position an', () => {
  // Eine halbe Zeile am unteren Rand liest sich als Fehler und nicht als
  // Ausblick: was nicht ganz hineinpasst, wird nicht gezeigt.
  const block = 1000;
  const lead = Math.min(108, block * 0.15);
  const row = Math.min(80, block * 0.11);
  const list = lead + 2 * (row + 16) + row / 2;
  assert.equal(fitCount(list, block), 3);
});

test('macht die Liste kuerzer, wenn die Schrift groesser wird', () => {
  // Die richtige Reihenfolge: eine Mitteilung, die man aus dem Flur lesen
  // kann, ist mehr wert als drei, vor die man treten muss.
  assert.ok(fitCount(500, 500, 1.5) < fitCount(500, 500, 1));
  assert.ok(fitCount(500, 500, 0.8) > fitCount(500, 500, 1));
});

test('nimmt einen unsinnigen Faktor nicht ernst', () => {
  // Aus der Konfiguration kann alles kommen; eine Liste, die daran zerbricht,
  // waere ein Block, der nichts mehr zeigt.
  const normal = fitCount(500, 500, 1);
  assert.equal(fitCount(500, 500, Number.NaN), normal);
  assert.equal(fitCount(500, 500, undefined), normal);
  // Geklemmt statt uebernommen: bei 1,6 ist Schluss.
  assert.equal(fitCount(500, 500, 99), fitCount(500, 500, 1.6));
  assert.ok(fitCount(500, 500, 1.6) < normal);
});

test('zeigt in derselben Hauptzone mehr Zeilen als die klobige Fassung', () => {
  // Der ganze Zweck der schmalen Zeile: eine Hauptzone von 1060 px fasste mit
  // 232-px-Zeilen drei Mitteilungen, jetzt ist sie voll besetzt.
  assert.equal(fitCount(1060, 1060), VISIBLE_MAX);
});

test('haelt sich an die Obergrenze aus dem Design-System', () => {
  // Ab hier liest niemand mehr eine Liste, sondern sieht eine Wand aus Text.
  assert.equal(fitCount(10_000, 10_000), VISIBLE_MAX);
});

test('nimmt die eingestellte Zahl, aber nur soweit sie hineinpasst', () => {
  assert.equal(slotCount(0, 4), 4);
  assert.equal(slotCount(2, 4), 2);
  assert.equal(slotCount(9, 4), 4);
  assert.equal(slotCount(-3, 4), 4);
});

/* -------------------------------- Deckkraft ------------------------------- */

test('verteilt den Verlauf auf die Positionen, die es gerade gibt', () => {
  // Bei zwei Ausblick-Positionen dieselben Werte wie frueher, bei mehr
  // dieselben Enden und Stufen dazwischen.
  assert.equal(restOpacity(1, 2), 0.8);
  assert.equal(restOpacity(2, 2), 0.45);
  const five = [1, 2, 3, 4, 5].map((step) => restOpacity(step, 5));
  assert.equal(five[0], 0.8);
  assert.equal(five.at(-1), 0.45);
  for (let i = 1; i < five.length; i += 1) assert.ok(five[i] < five[i - 1]);
});

test('laesst eine einzelne Ausblick-Position hell', () => {
  // Sie ist die erste darunter und nicht die letzte – als "letzte" fiele sie
  // sofort auf den blassesten Wert.
  assert.equal(restOpacity(1, 1), 0.8);
});

/* --------------------------------- Zeile ---------------------------------- */

test('gibt jeder Quelle ihr Symbol', () => {
  // Die Herkunft steht nicht mehr als Wort ueber dem Titel, sondern als
  // Symbol davor.
  assert.equal(feedIcon(item('a', { source: 'calendar' })), 'calendar-days');
  assert.equal(feedIcon(item('a', { source: 'sbb' })), 'train-front');
  assert.equal(feedIcon(item('a', { source: 'timer' })), 'timer');
  assert.equal(feedIcon(item('a', { source: 'weather' })), 'cloud');
  assert.equal(feedIcon(item('a', { source: 'spotify' })), 'music');
  assert.equal(feedIcon(item('a', { source: 'notifications' })), 'bell');
});

test('gibt einer unbekannten Quelle die Glocke', () => {
  // Kein Notbehelf: "eine Mitteilung, sonst weiss ich nichts" ist genau das,
  // was eine Glocke sagt.
  assert.equal(feedIcon(item('a', { source: 'irgendwas' })), 'bell');
});

test('stellt das Warndreieck vor die Herkunft', () => {
  // Bei einer Sturmwarnung ist das Dringende die Nachricht und die Wolke nur
  // die Adresse.
  assert.equal(feedIcon(item('a', { source: 'weather', urgent: true })), 'triangle-alert');
});

test('legt Herkunft und Zusatz in eine Zeile', () => {
  assert.equal(
    feedDescription({ label: 'Termin', meta: '09:30 · Kueche' }),
    'Termin · 09:30 · Kueche',
  );
});

test('laesst die Beschreibung weg, wo nichts steht', () => {
  // Eine Mitteilung ohne Zusatz ist ein Titel und keine halbe Zeile.
  assert.equal(feedDescription({ label: '', meta: '' }), '');
  assert.equal(feedDescription({ label: 'Termin', meta: '' }), 'Termin');
  assert.equal(feedDescription({ label: '  ', meta: '09:30' }), '09:30');
});
