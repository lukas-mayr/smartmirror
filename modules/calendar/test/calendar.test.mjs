import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEvent,
  eventNotifications,
  eventsFromIcs,
  parseSources,
  selectEvents,
  startOfDay,
} from '../dist/shared.js';

const ZONE = 'Europe/Zurich';
const LOCALE = 'de-CH';
// Montag, 24. August 2026, 09:12 Ortszeit.
const NOW = new Date('2026-08-24T07:12:00.000Z');

/* -------------------------------- Quellen --------------------------------- */

test('liest Name und Adresse aus einer Zeile', () => {
  const [source] = parseSources('Familie | https://p42-calendars.icloud.com/published/2/abc');
  assert.equal(source.name, 'Familie');
  assert.equal(source.url, 'https://p42-calendars.icloud.com/published/2/abc');
});

test('macht aus webcal ein https', () => {
  // iCloud gibt den Link so heraus; ein Modul soll deswegen nicht scheitern.
  const [source] = parseSources('webcal://p42-calendars.icloud.com/published/2/abc');
  assert.equal(source.url, 'https://p42-calendars.icloud.com/published/2/abc');
  assert.equal(source.name, '');
});

test('ueberspringt Leerzeilen, Kommentare und Unsinn', () => {
  const sources = parseSources('\n# Notiz\nkeine Adresse\nhttps://example.com/a.ics\n');
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://example.com/a.ics'],
  );
});

/* --------------------------------- Fenster -------------------------------- */

test('faengt den Tag um Mitternacht an und nicht jetzt', () => {
  // Wer um 23:00 hinsieht, will nicht die Termine von morgen frueh unter
  // "heute" finden.
  assert.equal(new Date(startOfDay(NOW, ZONE)).toISOString(), '2026-08-23T22:00:00.000Z');
  assert.equal(new Date(startOfDay(NOW, ZONE, 1)).toISOString(), '2026-08-24T22:00:00.000Z');
});

/* --------------------------------- Termine -------------------------------- */

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:standup
SUMMARY:Standup
LOCATION:Kueche
DTSTART;TZID=Europe/Zurich:20260824T093000
DTEND;TZID=Europe/Zurich:20260824T094500
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
EXDATE;TZID=Europe/Zurich:20260826T093000
END:VEVENT
BEGIN:VEVENT
UID:standup
RECURRENCE-ID;TZID=Europe/Zurich:20260825T093000
SUMMARY:Standup (spaeter)
DTSTART;TZID=Europe/Zurich:20260825T103000
DTEND;TZID=Europe/Zurich:20260825T104500
END:VEVENT
BEGIN:VEVENT
UID:ferien
SUMMARY:Ferienbeginn
DTSTART;VALUE=DATE:20260824
END:VEVENT
END:VCALENDAR`;

const window = (days) => ({
  from: NOW.getTime(),
  to: startOfDay(NOW, ZONE, days),
});

test('loest eine Serie im Fenster auf', () => {
  const { from, to } = window(1);
  const events = eventsFromIcs(ICS, 'Familie', from, to, ZONE);
  assert.deepEqual(
    events.map((event) => event.title).sort(),
    ['Ferienbeginn', 'Standup'],
  );
});

test('laesst einen ausgenommenen Termin weg', () => {
  const { from, to } = window(7);
  const events = eventsFromIcs(ICS, 'Familie', from, to, ZONE);
  const mittwoch = events.filter((event) => new Date(event.start).toISOString().startsWith('2026-08-26'));
  assert.deepEqual(mittwoch, []);
});

test('ersetzt einen verschobenen Serientermin, statt ihn zu verdoppeln', () => {
  // Ein Standup, der einmal auf 10:30 gerueckt ist, steht einmal da.
  const { from, to } = window(7);
  const dienstag = eventsFromIcs(ICS, 'Familie', from, to, ZONE).filter((event) =>
    new Date(event.start).toISOString().startsWith('2026-08-25'),
  );
  assert.equal(dienstag.length, 1);
  assert.equal(dienstag[0].title, 'Standup (spaeter)');
});

test('laesst Vergangenes des Tages heraus', () => {
  // Ein Kalender, der abgelaufene Termine zeigt, kostet nur Platz.
  const spaet = new Date('2026-08-24T18:00:00.000Z');
  const events = eventsFromIcs(ICS, 'Familie', spaet.getTime(), startOfDay(spaet, ZONE, 1), ZONE);
  assert.deepEqual(
    events.map((event) => event.title),
    ['Ferienbeginn'],
  );
});

/* --------------------------------- Auswahl -------------------------------- */

const event = (id, start, extra = {}) => ({
  id,
  title: id,
  location: '',
  start: Date.parse(start),
  end: Date.parse(start) + 3_600_000,
  allDay: false,
  calendar: '',
  ...extra,
});

test('sortiert nach Beginn und stellt Ganztaegiges voran', () => {
  const day = Date.parse('2026-08-24T00:00:00Z');
  const items = [
    event('spaet', '2026-08-24T14:00:00Z'),
    event('frueh', '2026-08-24T08:00:00Z'),
    event('ganztags', '2026-08-24T08:00:00Z', { allDay: true, start: day, end: day + 86_400_000 }),
  ];
  assert.deepEqual(
    selectEvents(items, 10, Date.parse('2026-08-25T00:00:00Z')).map((entry) => entry.id),
    ['ganztags', 'frueh', 'spaet'],
  );
});

test('zeigt denselben Termin aus zwei Kalendern nur einmal', () => {
  // Der Geburtstag steht im Familienkalender und im eigenen.
  const items = [
    { ...event('a', '2026-08-24T08:00:00Z'), title: 'Geburtstag', calendar: 'Familie' },
    { ...event('b', '2026-08-24T08:00:00Z'), title: 'Geburtstag', calendar: 'Privat' },
  ];
  assert.equal(selectEvents(items, 10, Date.parse('2026-08-25T00:00:00Z')).length, 1);
});

/* ------------------------------- Beschriften ------------------------------ */

test('rechnet nah Bevorstehendes in Minuten', () => {
  // "in 18 min" beantwortet die Frage, die man um neun Uhr morgens hat.
  const labels = describeEvent(event('x', '2026-08-24T07:30:00Z'), NOW, ZONE, LOCALE);
  assert.equal(labels.time, 'in 18 min');
  assert.equal(labels.day, '');
});

test('sagt "jetzt", solange es laeuft', () => {
  const laufend = event('x', '2026-08-24T07:00:00Z');
  assert.equal(describeEvent(laufend, NOW, ZONE, LOCALE).time, 'jetzt');
});

test('nennt morgen beim Namen und spaeter den Wochentag', () => {
  assert.equal(describeEvent(event('x', '2026-08-25T12:00:00Z'), NOW, ZONE, LOCALE).day, 'Morgen');
  assert.equal(describeEvent(event('x', '2026-08-27T12:00:00Z'), NOW, ZONE, LOCALE).day, 'Do');
});

test('gibt einem ganztaegigen Termin keine erfundene Uhrzeit', () => {
  const ferien = event('x', '2026-08-24T00:00:00Z', { allDay: true });
  const labels = describeEvent(ferien, NOW, ZONE, LOCALE);
  assert.equal(labels.time, '');
  assert.equal(labels.day, 'Heute');
});

/* ------------------------------ Als Mitteilung ---------------------------- */

test('macht aus einem Termin eine Mitteilung', () => {
  const [note] = eventNotifications([event('standup', '2026-08-24T07:30:00Z')], NOW, ZONE, LOCALE);
  // Im Mitteilungsblock steht der Titel gross, also gehoert der Termin dorthin
  // und die Zeit ins Label.
  assert.equal(note.label, 'Termin · in 18 min');
  assert.equal(note.title, 'standup');
  assert.equal(note.at, '2026-08-24T07:30:00.000Z');
  // Er verschwindet, wenn er vorbei ist, und nicht wenn er beginnt.
  assert.equal(note.expiresAt, '2026-08-24T08:30:00.000Z');
  assert.equal(note.urgent, false);
});
