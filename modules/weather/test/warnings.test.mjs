import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  meteoAlarmUrl,
  parseWarnings,
  selectWarnings,
  warningNotifications,
} from '../dist/warnings.js';

/*
 * Der Beispiel-Feed ist nachgebaut, nicht mitgeschnitten: er zeigt die Form,
 * die MeteoAlarm dokumentiert – Eintraege mit cap-Feldern und den beiden
 * Parametern fuer Stufe und Art. Was diese Tests belegen, ist deshalb das
 * Verhalten des Parsers und nicht die Uebereinstimmung mit den Live-Daten.
 */
const FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
  <entry>
    <id>2.49.0.0.756.0.ruhe</id>
    <title>Keine Warnung</title>
    <cap:event>No warnings</cap:event>
    <cap:areaDesc>Bern</cap:areaDesc>
    <cap:parameter><cap:valueName>awareness_level</cap:valueName><cap:value>1; green; Minor</cap:value></cap:parameter>
    <cap:parameter><cap:valueName>awareness_type</cap:valueName><cap:value>1; Wind</cap:value></cap:parameter>
  </entry>
  <entry>
    <id>2.49.0.0.756.0.sturm</id>
    <title>Wind warning</title>
    <cap:event>Wind</cap:event>
    <cap:onset>2026-08-22T12:00:00+02:00</cap:onset>
    <cap:expires>2026-08-22T20:00:00+02:00</cap:expires>
    <cap:areaDesc>Bern</cap:areaDesc>
    <cap:parameter><cap:valueName>awareness_level</cap:valueName><cap:value>3; orange; Severe</cap:value></cap:parameter>
    <cap:parameter><cap:valueName>awareness_type</cap:valueName><cap:value>1; Wind</cap:value></cap:parameter>
  </entry>
  <entry>
    <id>2.49.0.0.756.0.gewitter</id>
    <title>Thunderstorm warning</title>
    <cap:event>Thunderstorm</cap:event>
    <cap:effective>2026-08-22T14:00:00+02:00</cap:effective>
    <cap:expires>2026-08-22T18:00:00+02:00</cap:expires>
    <cap:areaDesc>Tessin</cap:areaDesc>
    <cap:parameter><cap:valueName>awareness_level</cap:valueName><cap:value>2; yellow; Moderate</cap:value></cap:parameter>
    <cap:parameter><cap:valueName>awareness_type</cap:valueName><cap:value>3; Thunderstorms</cap:value></cap:parameter>
  </entry>
</feed>`;

const NOW = new Date('2026-08-22T10:00:00.000Z');

/* --------------------------------- Feed ---------------------------------- */

test('waehlt den Feed anhand des Laendercodes', () => {
  assert.equal(
    meteoAlarmUrl('CH'),
    'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-switzerland',
  );
  assert.equal(meteoAlarmUrl('at'), 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-austria');
});

test('gibt fuer ein unbekanntes Land keinen Feed her', () => {
  // Lieber keine Warnungen als die eines anderen Landes.
  assert.equal(meteoAlarmUrl('JP'), null);
  assert.equal(meteoAlarmUrl(''), null);
});

/* -------------------------------- Parser --------------------------------- */

test('liest Stufe, Art, Region und Zeitraum aus einem Eintrag', () => {
  const [sturm] = parseWarnings(FEED);
  assert.equal(sturm.event, 'Sturm');
  assert.equal(sturm.level, 3);
  assert.equal(sturm.area, 'Bern');
  assert.equal(sturm.from, '2026-08-22T10:00:00.000Z');
  assert.equal(sturm.until, '2026-08-22T18:00:00.000Z');
});

test('laesst die Entwarnungen weg', () => {
  // Stufe 1 ist keine Warnung, sondern die Auskunft "nichts los" – und solche
  // Eintraege machen die Mehrzahl des Feeds aus.
  assert.deepEqual(
    parseWarnings(FEED).map((entry) => entry.event),
    ['Sturm', 'Gewitter'],
  );
});

test('nimmt den Beginn auch aus dem zweiten Feld', () => {
  // Nicht jeder Dienst setzt onset; effective meint dasselbe.
  const gewitter = parseWarnings(FEED)[1];
  assert.equal(gewitter.from, '2026-08-22T12:00:00.000Z');
});

test('bleibt bei unbrauchbarem Inhalt still, statt zu werfen', () => {
  // Ein Wettermodul, das wegen eines Feldes gar nichts mehr zeigt, ist kaputt.
  assert.deepEqual(parseWarnings(''), []);
  assert.deepEqual(parseWarnings('<html><body>Wartung</body></html>'), []);
  assert.deepEqual(parseWarnings('<feed><entry><title>halb'), []);
});

/* -------------------------------- Auswahl -------------------------------- */

test('stellt die ernsteste Warnung voran', () => {
  // Steht nur eine im Block, soll es die ernsteste sein.
  assert.deepEqual(
    selectWarnings(parseWarnings(FEED), '', NOW).map((entry) => entry.level),
    [3, 2],
  );
});

test('filtert die Region als Text', () => {
  // Die Namen der Warnregionen sind Klartext; niemand soll ihre Kennung
  // heraussuchen muessen.
  assert.deepEqual(
    selectWarnings(parseWarnings(FEED), 'tessin', NOW).map((entry) => entry.event),
    ['Gewitter'],
  );
});

test('laesst Abgelaufenes heraus', () => {
  const spaeter = new Date('2026-08-22T19:00:00.000Z');
  assert.deepEqual(selectWarnings(parseWarnings(FEED), '', spaeter), []);
});

/* ------------------------------ Als Mitteilung ---------------------------- */

test('macht aus einer Warnung eine Mitteilung', () => {
  const warnings = selectWarnings(parseWarnings(FEED), '', NOW);
  const [erste] = warningNotifications(warnings, (stamp) => stamp.slice(11, 16));
  assert.equal(erste.label, 'Warnung');
  // Aus 3 m liest man ein Wort, und "Sturm" ist das Wort, um das es geht.
  assert.equal(erste.title, 'Sturm');
  assert.equal(erste.meta, 'Bern · ab 10:00 · bis 18:00');
  assert.equal(erste.at, '2026-08-22T10:00:00.000Z');
  assert.equal(erste.expiresAt, '2026-08-22T18:00:00.000Z');
});

test('macht erst ab Stufe orange etwas Dringendes', () => {
  const warnings = selectWarnings(parseWarnings(FEED), '', NOW);
  const notes = warningNotifications(warnings, () => '');
  assert.equal(notes[0].urgent, true);
  assert.equal(notes[1].urgent, false);
});
