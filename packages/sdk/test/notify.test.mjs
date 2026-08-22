import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeNotifications,
  normalizeNotification,
  sortNotifications,
} from '../dist/notify.js';

const NOW = new Date('2026-08-22T10:00:00.000Z');

/* -------------------------------- Annehmen -------------------------------- */

test('macht aus einer knappen Meldung einen vollstaendigen Eintrag', () => {
  // Ein Modul soll melden duerfen, was es weiss, und nicht Felder fuellen
  // muessen, zu denen es nichts zu sagen hat.
  const entry = normalizeNotification({ title: 'Standup' }, 'calendar', 'cal-1', 0, NOW);
  assert.deepEqual(entry, {
    id: 'cal-1:0',
    label: '',
    title: 'Standup',
    meta: '',
    urgent: false,
    at: null,
    expiresAt: null,
    source: 'calendar',
  });
});

test('stellt die Instanz vor die Id', () => {
  // Zwei Kalenderbloecke sind zwei Quellen, und ihre Termine duerfen einander
  // nicht ueberschreiben.
  const a = normalizeNotification({ id: 'heute', title: 'A' }, 'calendar', 'cal-1', 0, NOW);
  const b = normalizeNotification({ id: 'heute', title: 'B' }, 'calendar', 'cal-2', 0, NOW);
  assert.equal(a.id, 'cal-1:heute');
  assert.equal(b.id, 'cal-2:heute');
});

test('nimmt Zeitpunkte als Text und als Datum', () => {
  const entry = normalizeNotification(
    { title: 'Zug', at: new Date('2026-08-22T10:07:00.000Z'), expiresAt: '2026-08-22T10:08:00Z' },
    'departures',
    'sbb-1',
    0,
    NOW,
  );
  assert.equal(entry.at, '2026-08-22T10:07:00.000Z');
  assert.equal(entry.expiresAt, '2026-08-22T10:08:00.000Z');
});

test('rechnet eine Laufzeit in einen Zeitpunkt um', () => {
  // Ein Skript rechnet lieber in Sekunden ("gilt zehn Minuten") als in
  // Zeitstempeln.
  const entry = normalizeNotification({ title: 'Timer', ttlSeconds: 600 }, 'x', 'x-1', 0, NOW);
  assert.equal(entry.expiresAt, '2026-08-22T10:10:00.000Z');
});

test('verwirft eine Meldung ohne Titel', () => {
  // Eine Mitteilung ohne Aussage ist keine.
  assert.equal(normalizeNotification({ title: '   ' }, 'x', 'x-1', 0, NOW), null);
});

test('uebergeht einen unlesbaren Zeitstempel, statt die Meldung zu verwerfen', () => {
  const entry = normalizeNotification({ title: 'Termin', at: 'morgen' }, 'x', 'x-1', 0, NOW);
  assert.equal(entry.at, null);
  assert.equal(entry.title, 'Termin');
});

/* -------------------------------- Auswaehlen ------------------------------- */

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

test('behandelt einen unlesbaren Zeitstempel als "gilt weiter"', () => {
  assert.equal(activeNotifications([item('x', { expiresAt: 'unsinn' })], NOW).length, 1);
});

/* -------------------------------- Sortieren -------------------------------- */

test('zieht Dringendes nach oben', () => {
  const items = [item('a'), item('b'), item('dringend', { urgent: true })];
  assert.deepEqual(
    sortNotifications(items).map((entry) => entry.id),
    ['dringend', 'a', 'b'],
  );
});

test('stellt das Naechste vor das Spaetere', () => {
  // Ohne die Zeit stuende die Abfahrt in sieben Minuten hinter dem Termin von
  // morgen, nur weil das Kalendermodul frueher gemeldet hat.
  const items = [
    item('morgen', { at: '2026-08-23T09:00:00.000Z' }),
    item('gleich', { at: '2026-08-22T10:07:00.000Z' }),
  ];
  assert.deepEqual(
    sortNotifications(items).map((entry) => entry.id),
    ['gleich', 'morgen'],
  );
});

test('stellt Terminiertes vor Unterminiertes', () => {
  const items = [item('zettel'), item('termin', { at: '2026-08-23T09:00:00.000Z' })];
  assert.deepEqual(
    sortNotifications(items).map((entry) => entry.id),
    ['termin', 'zettel'],
  );
});

test('laesst gleich Eingestufte in ihrer Reihenfolge', () => {
  // Sonst sprungt die Liste bei jedem Zeichnen um.
  const items = [item('a'), item('b'), item('c')];
  assert.deepEqual(
    sortNotifications(items).map((entry) => entry.id),
    ['a', 'b', 'c'],
  );
});

test('sortiert Dringendes vor das Naechste', () => {
  // Eine Sturmwarnung ohne Uhrzeit steht ueber dem Bus in sieben Minuten.
  const items = [
    item('bus', { at: '2026-08-22T10:07:00.000Z' }),
    item('sturm', { urgent: true }),
  ];
  assert.deepEqual(
    sortNotifications(items).map((entry) => entry.id),
    ['sturm', 'bus'],
  );
});
