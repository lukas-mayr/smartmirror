import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRule, keyOf, parseIcs, parseWallTime, toInstant, unfold } from '../dist/ics.js';

const ZONE = 'Europe/Zurich';

const wrap = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR`;

/* --------------------------------- Lesen ---------------------------------- */

test('setzt gefaltete Zeilen wieder zusammen', () => {
  // Wer das ueberspringt, verliert die zweite Haelfte jedes laengeren
  // Betreffs – und lange Betreffs sind die Regel.
  const lines = unfold('SUMMARY:Elternabend in der\r\n  Aula des Schulhauses\r\nLOCATION:Bern');
  assert.equal(lines[0], 'SUMMARY:Elternabend in der Aula des Schulhauses');
  assert.equal(lines[1], 'LOCATION:Bern');
});

test('liest einen Termin mit Zeitzone', () => {
  const [event] = parseIcs(
    wrap(
      'BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Standup\r\nLOCATION:Kueche\r\n' +
        'DTSTART;TZID=Europe/Zurich:20260824T093000\r\nDTEND;TZID=Europe/Zurich:20260824T094500\r\nEND:VEVENT',
    ),
  );
  assert.equal(event.summary, 'Standup');
  assert.equal(event.location, 'Kueche');
  assert.equal(event.start.zone, 'Europe/Zurich');
  // 09:30 in Zuerich ist im Sommer 07:30 UTC.
  assert.equal(new Date(toInstant(event.start, ZONE)).toISOString(), '2026-08-24T07:30:00.000Z');
});

test('erkennt einen ganztaegigen Termin', () => {
  const [event] = parseIcs(
    wrap('BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Ferien\r\nDTSTART;VALUE=DATE:20260824\r\nEND:VEVENT'),
  );
  assert.equal(event.start.allDay, true);
  // Ohne Ende dauert er den ganzen Tag.
  assert.equal(event.end.day, 25);
});

test('nimmt Z als UTC', () => {
  const time = parseWallTime('20260824T073000Z', {});
  assert.equal(time.zone, 'UTC');
  assert.equal(new Date(toInstant(time, ZONE)).toISOString(), '2026-08-24T07:30:00.000Z');
});

test('laesst abgesagte Termine weg', () => {
  // Wer einen Termin absagt, will ihn nicht mehr an der Wand sehen.
  const events = parseIcs(
    wrap(
      'BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Zahnarzt\r\nSTATUS:CANCELLED\r\nDTSTART:20260824T090000Z\r\nEND:VEVENT',
    ),
  );
  assert.deepEqual(events, []);
});

test('uebersteht Muell, statt zu werfen', () => {
  assert.deepEqual(parseIcs(''), []);
  assert.deepEqual(parseIcs('<html>Wartung</html>'), []);
  assert.deepEqual(parseIcs(wrap('BEGIN:VEVENT\r\nSUMMARY:ohne Anfang\r\nEND:VEVENT')), []);
});

test('macht aus escapten Zeichen wieder Text', () => {
  const [event] = parseIcs(
    wrap('BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Essen\\, Trinken\\nund mehr\r\nDTSTART:20260824T090000Z\r\nEND:VEVENT'),
  );
  assert.equal(event.summary, 'Essen, Trinken und mehr');
});

/* --------------------------------- Serien --------------------------------- */

const serie = (rule, extra = '') =>
  parseIcs(
    wrap(
      `BEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Serie\r\nDTSTART;TZID=Europe/Zurich:20260824T093000\r\n` +
        `DTEND;TZID=Europe/Zurich:20260824T094500\r\nRRULE:${rule}\r\n${extra}END:VEVENT`,
    ),
  )[0];

const days = (event, rule, fromIso, toIso) =>
  expandRule(event, Date.parse(fromIso), Date.parse(toIso), ZONE).map((time) => keyOf(time));

test('zaehlt eine taegliche Serie durch', () => {
  const event = serie('FREQ=DAILY');
  assert.deepEqual(days(event, 'FREQ=DAILY', '2026-08-24T00:00:00Z', '2026-08-26T23:59:59Z'), [
    '20260824T093000',
    '20260825T093000',
    '20260826T093000',
  ]);
});

test('beachtet INTERVAL und COUNT', () => {
  const event = serie('FREQ=DAILY;INTERVAL=2;COUNT=3');
  assert.deepEqual(days(event, '', '2026-08-24T00:00:00Z', '2026-09-30T00:00:00Z'), [
    '20260824T093000',
    '20260826T093000',
    '20260828T093000',
  ]);
});

test('hoert bei UNTIL auf', () => {
  const event = serie('FREQ=DAILY;UNTIL=20260826T235959Z');
  assert.equal(days(event, '', '2026-08-24T00:00:00Z', '2026-09-30T00:00:00Z').length, 3);
});

test('verteilt eine Woche auf mehrere Wochentage', () => {
  const event = serie('FREQ=WEEKLY;BYDAY=MO,WE,FR');
  assert.deepEqual(days(event, '', '2026-08-24T00:00:00Z', '2026-08-30T23:59:59Z'), [
    '20260824T093000',
    '20260826T093000',
    '20260828T093000',
  ]);
});

test('haelt eine monatliche Serie am Monatsende fest', () => {
  // Der 31. in einem 30-Tage-Monat rutscht auf den letzten Tag, statt in den
  // Folgemonat zu springen.
  const event = parseIcs(
    wrap(
      'BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:Miete\r\nDTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY\r\nEND:VEVENT',
    ),
  )[0];
  const out = expandRule(event, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-04-30T00:00:00Z'), ZONE);
  assert.deepEqual(out.map(keyOf), [
    '20260131T000000',
    '20260228T000000',
    '20260331T000000',
    '20260430T000000',
  ]);
});

test('behaelt die Uhrzeit ueber die Zeitumstellung hinweg', () => {
  // In Millisekunden gerechnet waere aus 09:30 nach der Umstellung 08:30 oder
  // 10:30 geworden.
  const event = serie('FREQ=WEEKLY');
  const out = expandRule(event, Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-11-05T00:00:00Z'), ZONE);
  const stamps = out.map((time) => new Date(toInstant(time, ZONE)).toISOString());
  // Vor der Umstellung 07:30 UTC, danach 08:30 UTC – die Wanduhr zeigt beide
  // Male halb zehn.
  assert.ok(stamps.some((stamp) => stamp.endsWith('T07:30:00.000Z')));
  assert.ok(stamps.some((stamp) => stamp.endsWith('T08:30:00.000Z')));
});

test('erreicht das Fenster auch bei einer alten Serie', () => {
  // Eine taegliche Serie, die vor zwanzig Jahren begann, muss bis heute
  // durchgezaehlt werden, bevor der erste sichtbare Termin herauskommt.
  const event = parseIcs(
    wrap(
      'BEGIN:VEVENT\r\nUID:alt\r\nSUMMARY:Alt\r\nDTSTART;VALUE=DATE:20060101\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT',
    ),
  )[0];
  const out = expandRule(event, Date.parse('2026-08-24T00:00:00Z'), Date.parse('2026-08-25T00:00:00Z'), ZONE);
  assert.ok(out.length >= 1);
  assert.equal(keyOf(out[0]).slice(0, 6), '202608');
});

test('macht aus einer unverstandenen Regel einen Einzeltermin', () => {
  // Besser einmal richtig als beliebig oft falsch.
  const event = serie('FREQ=SECONDLY;INTERVAL=7');
  const out = expandRule(event, Date.parse('2026-08-24T00:00:00Z'), Date.parse('2026-08-25T00:00:00Z'), ZONE);
  assert.equal(out.length, 1);
});
