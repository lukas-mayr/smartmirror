import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actualDeparture,
  boardStopName,
  countdown,
  departureNotifications,
  parseBoard,
  parseDelay,
  selectDepartures,
} from '../dist/shared.js';

const ZONE = 'Europe/Zurich';
const LOCALE = 'de-CH';
// 24. August 2026, 09:12 Ortszeit in Zuerich.
const NOW = new Date('2026-08-24T07:12:00.000Z');

/*
 * Die Antwort ist nachgebaut, nicht mitgeschnitten: sie zeigt die Form, die
 * die Auskunft dokumentiert. Belegt ist damit das Verhalten des Parsers, nicht
 * die Uebereinstimmung mit den Live-Daten.
 */
const BOARD = {
  stop: { name: 'Bern' },
  connections: [
    {
      time: '2026-08-24 09:19:00',
      type: 'strain',
      line: 'S3',
      '*L': 'S3',
      terminal: { name: 'Biel/Bienne' },
      track: '5',
      dep_delay: '+3',
    },
    {
      time: '2026-08-24 09:25:00',
      type: 'bus',
      line: '10',
      terminal: { name: 'Koeniz' },
      dep_delay: '',
    },
    {
      time: '2026-08-24 09:31:00',
      type: 'train',
      line: 'IC 8',
      terminal: { name: 'Brig' },
      track: '7',
      dep_delay: 'X',
    },
    { time: 'kaputt', line: 'X1', terminal: { name: 'Nirgendwo' } },
  ],
};

/* --------------------------------- Lesen ---------------------------------- */

test('liest Linie, Ziel, Gleis und Zeit', () => {
  const [erste] = parseBoard(BOARD, ZONE);
  assert.equal(erste.line, 'S3');
  assert.equal(erste.destination, 'Biel/Bienne');
  assert.equal(erste.track, '5');
  // Die Auskunft meint Ortszeit ohne Zone – 09:19 in Bern ist 07:19 UTC.
  assert.equal(new Date(erste.scheduled).toISOString(), '2026-08-24T07:19:00.000Z');
});

test('unterscheidet Verspaetung, Puenktlichkeit und Ausfall', () => {
  // Ein Ausfall ist keine Verspaetung von null Minuten.
  assert.deepEqual(parseDelay('+3'), { delay: 3, cancelled: false });
  assert.deepEqual(parseDelay(''), { delay: 0, cancelled: false });
  assert.deepEqual(parseDelay('X'), { delay: 0, cancelled: true });
  assert.deepEqual(parseDelay(undefined), { delay: 0, cancelled: false });
});

test('ueberspringt eine Verbindung ohne brauchbare Zeit', () => {
  assert.equal(parseBoard(BOARD, ZONE).length, 3);
});

test('bleibt bei unbrauchbarer Antwort still, statt zu werfen', () => {
  assert.deepEqual(parseBoard(null, ZONE), []);
  assert.deepEqual(parseBoard({ connections: 'nein' }, ZONE), []);
  assert.equal(boardStopName({}, 'Bern'), 'Bern');
});

test('rechnet die Verspaetung in die Abfahrt ein', () => {
  const [erste] = parseBoard(BOARD, ZONE);
  assert.equal(new Date(actualDeparture(erste)).toISOString(), '2026-08-24T07:22:00.000Z');
});

/* -------------------------------- Auswaehlen ------------------------------ */

test('laesst weg, was der Fussweg nicht mehr hergibt', () => {
  // Eine Abfahrt in zehn Minuten ist keine Information, wenn man fuenfzehn
  // Minuten zur Haltestelle braucht. Um 09:12 mit Fussweg 15 bleibt nur, was
  // ab 09:27 faehrt.
  const departures = parseBoard(BOARD, ZONE);
  assert.deepEqual(
    selectDepartures(departures, NOW, 15, '', 10).map((entry) => entry.line),
    ['IC 8'],
  );
  assert.equal(selectDepartures(departures, NOW, 0, '', 10).length, 3);
});

test('filtert die Linien', () => {
  const departures = parseBoard(BOARD, ZONE);
  assert.deepEqual(
    selectDepartures(departures, NOW, 0, 's3, 10', 10).map((entry) => entry.line),
    ['S3', '10'],
  );
});

test('sortiert nach tatsaechlicher Abfahrt', () => {
  const departures = parseBoard(BOARD, ZONE);
  // Nach Plan faehrt die S3 um 09:19 zuerst, mit drei Minuten Verspaetung um
  // 09:22 immer noch vor dem Bus um 09:25.
  assert.deepEqual(
    selectDepartures(departures, NOW, 0, '', 10).map((entry) => entry.line),
    ['S3', '10', 'IC 8'],
  );

  // Mit zehn Minuten waere sie hinter ihm: sortiert wird nach dem, was
  // tatsaechlich faehrt, und nicht nach dem, was im Fahrplan steht.
  const spaet = departures.map((entry) => (entry.line === 'S3' ? { ...entry, delay: 10 } : entry));
  assert.deepEqual(
    selectDepartures(spaet, NOW, 0, '', 10).map((entry) => entry.line),
    ['10', 'S3', 'IC 8'],
  );
});

test('behaelt einen Ausfall in der Liste', () => {
  // Dass etwas nicht faehrt, ist die wichtigere Nachricht.
  const departures = parseBoard(BOARD, ZONE);
  const ausfall = selectDepartures(departures, NOW, 0, '', 10).find((entry) => entry.cancelled);
  assert.equal(ausfall.line, 'IC 8');
});

/* ------------------------------- Beschriften ------------------------------ */

test('zaehlt in Minuten herunter', () => {
  const [erste] = parseBoard(BOARD, ZONE);
  assert.equal(countdown(erste, NOW, LOCALE, ZONE), '10 min');
});

test('nennt einen Ausfall beim Namen', () => {
  const ausfall = parseBoard(BOARD, ZONE)[2];
  assert.equal(countdown(ausfall, NOW, LOCALE, ZONE), 'faellt aus');
});

test('wechselt jenseits einer Stunde auf die Uhrzeit', () => {
  // Ab einer Stunde rechnet niemand mehr in Minuten.
  const spaet = { ...parseBoard(BOARD, ZONE)[0], scheduled: Date.parse('2026-08-24T12:00:00Z'), delay: 0 };
  assert.match(countdown(spaet, NOW, LOCALE, ZONE), /^\d{2}:\d{2}$/);
});

/* ------------------------------ Als Mitteilung ---------------------------- */

test('macht aus einer Abfahrt eine Mitteilung', () => {
  const [note] = departureNotifications([parseBoard(BOARD, ZONE)[0]], NOW, LOCALE, ZONE);
  // "Biel/Bienne" ist die Auskunft, "S3" die Herkunft.
  assert.equal(note.label, 'Abfahrt · S3');
  assert.equal(note.title, 'Biel/Bienne');
  assert.equal(note.meta, '10 min · +3 · Gl. 5');
  // Sie laeuft ab, wenn der Zug weg ist – nicht frueher, nicht spaeter.
  assert.equal(note.expiresAt, '2026-08-24T07:22:00.000Z');
});

test('macht einen Ausfall dringend', () => {
  const ausfall = parseBoard(BOARD, ZONE)[2];
  const [note] = departureNotifications([ausfall], NOW, LOCALE, ZONE);
  assert.equal(note.urgent, true);
});
