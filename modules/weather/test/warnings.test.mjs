import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  meteoAlarmUrl,
  parseWarnings,
  selectWarnings,
  warningNotifications,
} from '../dist/warnings.js';

/*
 * Die Beispielantwort ist nachgebaut, nicht mitgeschnitten: sie zeigt die
 * Form, die die JSON-Schnittstelle von MeteoAlarm liefert – eine Liste von
 * CAP-Meldungen, je Meldung ein Sprachblock je Sprache, darin Stufe und Art
 * als Parameter und das Gebiet als Polygon.
 *
 * Dass eine nachgebaute Vorlage nicht dasselbe ist wie die Wirklichkeit, hat
 * dieses Modul schon einmal teuer bezahlt: die Vorgaengerfassung las den
 * Atom-Feed und suchte die Warnstufe in den Eintraegen, wo sie nie steht –
 * dort verlinkt jeder Eintrag nur ein zweites Dokument. Die Tests waren gruen,
 * weil die Vorlage sie enthielt, und der Spiegel zeigte nie eine Warnung. Der
 * erste Test unten prueft deshalb nicht, dass etwas herausfaellt, sondern dass
 * ueberhaupt etwas ankommt: "null Warnungen" ist die eine Antwort, die auch
 * dann richtig aussieht, wenn alles kaputt ist.
 */

/** Wien, ungefaehr – liegt im ersten Polygon, nicht im zweiten. */
const WIEN = { latitude: 48.21, longitude: 16.37 };

const UM_WIEN = '48.0,16.1 48.0,16.6 48.4,16.6 48.4,16.1 48.0,16.1';
const UM_INNSBRUCK = '47.1,11.2 47.1,11.6 47.4,11.6 47.4,11.2 47.1,11.2';

/** Eine Meldung in der Form der Schnittstelle, mit gezielt geaenderten Feldern. */
function meldung({ info = {}, area, ...alert } = {}) {
  return {
    alert: {
      identifier: '2.49.0.0.40.0.sturm',
      status: 'Actual',
      msgType: 'Alert',
      info: [
        {
          language: 'de-DE',
          event: 'Wind',
          severity: 'Severe',
          onset: '2026-08-22T12:00:00+02:00',
          expires: '2026-08-22T20:00:00+02:00',
          parameter: [
            { valueName: 'awareness_level', value: '3; orange; Severe' },
            { valueName: 'awareness_type', value: '1; Wind' },
          ],
          area: area ?? [{ areaDesc: 'Wien', polygon: [UM_WIEN] }],
          ...info,
        },
      ],
      ...alert,
    },
  };
}

const antwort = (...meldungen) => ({ geocodes: [], warnings: meldungen });

const NOW = new Date('2026-08-22T10:00:00.000Z');

/* --------------------------------- Feed ---------------------------------- */

test('waehlt den Feed anhand des Laendercodes', () => {
  assert.equal(meteoAlarmUrl('CH'), 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-switzerland');
  assert.equal(meteoAlarmUrl(' at '), 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-austria');
});

test('gibt fuer ein unbekanntes Land keinen Feed her', () => {
  // Lieber keine Warnungen als die eines anderen Landes.
  assert.equal(meteoAlarmUrl('JP'), null);
  assert.equal(meteoAlarmUrl('LI'), null);
  assert.equal(meteoAlarmUrl(''), null);
});

/* -------------------------------- Parser --------------------------------- */

test('liest Stufe, Art, Region und Zeitraum aus einer Meldung', () => {
  const [sturm, ...rest] = parseWarnings(antwort(meldung()), { language: 'de', place: WIEN });

  assert.equal(rest.length, 0, 'die eine Meldung, nicht mehr und nicht weniger');
  assert.deepEqual(sturm, {
    id: '2.49.0.0.40.0.sturm',
    event: 'Sturm',
    level: 3,
    area: 'Wien',
    from: '2026-08-22T10:00:00.000Z',
    until: '2026-08-22T18:00:00.000Z',
  });
});

test('laesst die Entwarnungen weg', () => {
  // Stufe 1 ist keine Warnung, sondern die Auskunft "nichts los" – und solche
  // Eintraege machen die Mehrzahl der Antwort aus.
  const ruhe = meldung({
    info: { severity: 'Minor', parameter: [{ valueName: 'awareness_level', value: '1; green; Minor' }] },
  });
  assert.deepEqual(parseWarnings(antwort(ruhe), { place: WIEN }), []);
});

test('nimmt die Stufe aus awareness_level und nicht aus der Dringlichkeit', () => {
  // Die Farben von MeteoAlarm haengen an awareness_level; severity ist
  // groeber und wuerde hier auf Gelb statt Rot hinauslaufen.
  const rot = meldung({
    info: { severity: 'Moderate', parameter: [{ valueName: 'awareness_level', value: '4; red; Extreme' }] },
  });
  assert.equal(parseWarnings(antwort(rot), { place: WIEN })[0].level, 4);
});

test('faellt auf die Dringlichkeit zurueck, wenn die Stufe fehlt', () => {
  // Eine Warnung mit ungefaehrer Stufe ist besser als keine Warnung.
  const ohneStufe = meldung({ info: { parameter: [], severity: 'Extreme' } });
  assert.equal(parseWarnings(antwort(ohneStufe), { place: WIEN })[0].level, 4);
});

test('nimmt den Beginn auch aus dem zweiten Feld', () => {
  // Nicht jeder Dienst setzt onset; effective meint dasselbe.
  const ohneOnset = meldung({ info: { onset: undefined, effective: '2026-08-22T14:00:00+02:00' } });
  assert.equal(parseWarnings(antwort(ohneOnset), { place: WIEN })[0].from, '2026-08-22T12:00:00.000Z');
});

test('nimmt den Sprachblock, der zur Anzeige passt', () => {
  const zweisprachig = meldung({ info: { language: 'en-GB', event: 'Strong wind' } });
  zweisprachig.alert.info.push({
    ...zweisprachig.alert.info[0],
    language: 'de-AT',
    event: 'Starker Wind',
    parameter: [{ valueName: 'awareness_level', value: '2; yellow; Moderate' }],
  });

  // Die Art kommt aus der Nummer, sobald es eine gibt – der Text zaehlt erst
  // dahinter. Genommen wird trotzdem der richtige Block: die Stufe steht dort.
  assert.equal(parseWarnings(antwort(zweisprachig), { language: 'de' })[0].level, 2);
  assert.equal(parseWarnings(antwort(zweisprachig), { language: 'fr' })[0].level, 3);
});

test('nimmt den Text, wenn die Art keine bekannte Nummer hat', () => {
  const unbekannt = meldung({
    info: { event: 'Sandsturm', parameter: [{ valueName: 'awareness_level', value: '3; orange' }] },
  });
  assert.equal(parseWarnings(antwort(unbekannt), { place: WIEN })[0].event, 'Sandsturm');
});

/* ------------------------------- Der Ort --------------------------------- */

test('haelt nur Warnungen, deren Gebiet den Ort einschliesst', () => {
  // Ohne diese Pruefung stuende die Lawinenwarnung fuer Tirol auf einem
  // Spiegel in Wien: MeteoAlarm warnt fuer ein ganzes Land.
  const tirol = meldung({ area: [{ areaDesc: 'Tirol', polygon: [UM_INNSBRUCK] }] });

  assert.deepEqual(parseWarnings(antwort(tirol), { place: WIEN }), []);
  assert.equal(parseWarnings(antwort(tirol)).length, 1, 'ohne bekannten Ort bleibt sie stehen');
});

test('behaelt eine Warnung ohne Polygon, statt sie wegzuwerfen', () => {
  // "Kein Polygon" heisst nicht "betrifft dich nicht", sondern "kann ich nicht
  // sagen" – und dann ist Zeigen die sichere Antwort.
  const ohneFlaeche = meldung({ area: [{ areaDesc: 'Ganz Österreich' }] });
  assert.equal(parseWarnings(antwort(ohneFlaeche), { place: WIEN }).length, 1);
});

test('nennt alle Gebiete einer Warnung, jedes einmal', () => {
  const zweiGebiete = meldung({
    area: [
      { areaDesc: 'Wien', polygon: [UM_WIEN] },
      { areaDesc: 'Wien' },
      { areaDesc: 'Niederösterreich' },
    ],
  });
  assert.equal(parseWarnings(antwort(zweiGebiete), { place: WIEN })[0].area, 'Wien, Niederösterreich');
});

/* ---------------------------- Zurueckgezogenes ---------------------------- */

test('zeigt weder eine Aufhebung noch die Warnung, die sie aufhebt', () => {
  // Ein Sturm, den der Wetterdienst abgeblasen hat, ist keine veraltete
  // Information, sondern eine falsche.
  const sturm = meldung({ identifier: 'sturm-1' });
  const aufhebung = meldung({
    identifier: 'sturm-2',
    msgType: 'Cancel',
    references: 'dienst@example.org,sturm-1,2026-08-22T12:00:00+02:00',
  });

  assert.deepEqual(parseWarnings(antwort(sturm, aufhebung), { place: WIEN }), []);
});

test('zeigt bei einer Fortschreibung nur die neue Meldung', () => {
  const alt = meldung({ identifier: 'sturm-1' });
  const neu = meldung({
    identifier: 'sturm-2',
    msgType: 'Update',
    references: 'dienst@example.org,sturm-1,2026-08-22T12:00:00+02:00',
  });

  assert.deepEqual(
    parseWarnings(antwort(alt, neu), { place: WIEN }).map((entry) => entry.id),
    ['sturm-2'],
  );
});

test('laesst Uebungen und Systemtests aus', () => {
  // Die haben auf einem Spiegel im Flur nichts verloren.
  assert.deepEqual(parseWarnings(antwort(meldung({ status: 'Exercise' })), { place: WIEN }), []);
  assert.equal(parseWarnings(antwort(meldung({ status: undefined })), { place: WIEN }).length, 1);
});

/* ------------------------------ Unbrauchbares ----------------------------- */

test('bleibt bei unbrauchbarem Inhalt still, statt zu werfen', () => {
  // Ein Wettermodul, das wegen eines Feldes gar nichts mehr zeigt, ist kaputt.
  for (const murks of [null, undefined, '', 42, {}, [], { warnings: null }, { warnings: [{}] }]) {
    assert.deepEqual(parseWarnings(murks), [], `Eingabe: ${JSON.stringify(murks) ?? 'undefined'}`);
  }
});

test('nimmt einen Sprachblock auch dann, wenn er nicht in einer Liste steht', () => {
  // Wer nur eines hat, schickt gern das nackte Objekt statt einer Liste.
  const nackt = meldung();
  nackt.alert.info = nackt.alert.info[0];
  nackt.alert.info.area = nackt.alert.info.area[0];
  assert.equal(parseWarnings(antwort(nackt), { place: WIEN }).length, 1);
});

/* -------------------------------- Auswahl -------------------------------- */

const DREI = [
  { id: 'a', event: 'Regen', level: 2, area: 'Tessin', from: null, until: '2026-08-22T18:00:00.000Z' },
  { id: 'b', event: 'Sturm', level: 3, area: 'Bern', from: null, until: '2026-08-22T18:00:00.000Z' },
];

test('stellt die ernsteste Warnung voran', () => {
  // Steht nur eine im Block, soll es die ernsteste sein.
  assert.deepEqual(
    selectWarnings(DREI, '', NOW).map((entry) => entry.level),
    [3, 2],
  );
});

test('filtert die Region als Text', () => {
  // Die Namen der Warnregionen sind Klartext; niemand soll ihre Kennung
  // heraussuchen muessen.
  assert.deepEqual(
    selectWarnings(DREI, 'tessin', NOW).map((entry) => entry.event),
    ['Regen'],
  );
});

test('laesst Abgelaufenes heraus', () => {
  assert.deepEqual(selectWarnings(DREI, '', new Date('2026-08-22T19:00:00.000Z')), []);
});

/* ------------------------------ Als Mitteilung ---------------------------- */

test('macht aus einer Warnung eine Mitteilung', () => {
  const warnungen = parseWarnings(antwort(meldung()), { place: WIEN });
  const [erste] = warningNotifications(warnungen, (stamp) => stamp.slice(11, 16));

  assert.equal(erste.label, 'Warnung');
  // Aus 3 m liest man ein Wort, und "Sturm" ist das Wort, um das es geht.
  assert.equal(erste.title, 'Sturm');
  assert.equal(erste.meta, 'Wien · ab 10:00 · bis 18:00');
  assert.equal(erste.at, '2026-08-22T10:00:00.000Z');
  assert.equal(erste.expiresAt, '2026-08-22T18:00:00.000Z');
});

test('macht erst ab Stufe orange etwas Dringendes', () => {
  const gelb = meldung({ info: { parameter: [{ valueName: 'awareness_level', value: '2; yellow; Moderate' }] } });
  const notes = warningNotifications(
    [...parseWarnings(antwort(meldung()), { place: WIEN }), ...parseWarnings(antwort(gelb), { place: WIEN })],
    () => '',
  );

  assert.equal(notes[0].urgent, true);
  assert.equal(notes[1].urgent, false);
});
