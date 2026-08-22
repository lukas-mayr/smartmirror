import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accentForTemperature,
  barHeight,
  buildSlides,
  dayLabel,
  daysBetween,
  describeWeather,
  dwellMs,
  DWELL_SECONDS,
  HOURLY_POINTS,
  isoDay,
  peakIndex,
  pickHourly,
  toCelsius,
  weatherForm,
} from '../dist/shared.js';
import { MOTION } from '@mirror/sdk';

test('faerbt kalt blau und warm bernstein', () => {
  assert.equal(accentForTemperature(-5), '#6f9ad6');
  assert.equal(accentForTemperature(28), '#d99a4e');
});

test('bleibt zwischen den Endpunkten', () => {
  // In der Mitte der Spanne liegt jeder Kanal zwischen beiden Enden.
  const middle = accentForTemperature(11.5);
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(middle.slice(start, start + 2), 16));
  assert.ok(r > 0x6f && r < 0xd9, `Rot ausserhalb der Spanne: ${middle}`);
  assert.equal(g, 0x9a);
  assert.ok(b > 0x4e && b < 0xd6, `Blau ausserhalb der Spanne: ${middle}`);
});

test('kappt Ausreisser statt sie hochzurechnen', () => {
  // Minus vierzig Grad ist nicht "noch blauer" – die Spanne endet.
  assert.equal(accentForTemperature(-40), accentForTemperature(-5));
  assert.equal(accentForTemperature(50), accentForTemperature(28));
});

test('faellt bei fehlender Temperatur auf Grau zurueck', () => {
  assert.equal(accentForTemperature(Number.NaN), '#9a9aa3');
});

test('rechnet Fahrenheit in Celsius um', () => {
  assert.equal(toCelsius(32, 'imperial'), 0);
  assert.equal(Math.round(toCelsius(212, 'imperial')), 100);
  // Metrisch bleibt die Zahl, wie sie ist.
  assert.equal(toCelsius(18, 'metric'), 18);
});

test('gibt unbekannten Wettercodes trotzdem ein Symbol', () => {
  assert.deepEqual(describeWeather(4242), { label: 'Unbekannt', icon: 'cloud' });
});

test('unterscheidet Tag und Nacht nur dort, wo es einen Unterschied macht', () => {
  assert.equal(describeWeather(0, true).icon, 'sun');
  assert.equal(describeWeather(0, false).icon, 'moon');
  // Regen sieht nachts nicht anders aus.
  assert.equal(describeWeather(63, false).icon, 'cloud-rain');
});

/* -------------------------------- Karten --------------------------------- */

const CONFIG = {
  location: 'Wien',
  units: 'metric',
  forecastDays: 4,
  showWind: true,
  refreshMinutes: 15,
};

const STATE = {
  resolvedLocation: 'Wien, AT',
  current: { temperature: 21, apparentTemperature: 20, weatherCode: 2, windSpeed: 9, isDay: true },
  forecast: [
    { date: '2026-08-23', min: 12, max: 24, weatherCode: 0 },
    { date: '2026-08-24', min: 13, max: 26, weatherCode: 61 },
    { date: '2026-08-25', min: 11, max: 22, weatherCode: 3 },
  ],
  temperatureUnit: '\u00b0C',
  windUnit: 'km/h',
  fetchedAt: '2026-08-22T10:00:00.000Z',
};

const NOW = new Date('2026-08-22T10:00:00.000Z');

test('nimmt den Kalendertag des Spiegels, nicht den des Rechners', () => {
  // Kurz vor Mitternacht in Wien ist in Los Angeles noch Nachmittag.
  const moment = new Date('2026-08-22T22:30:00.000Z');
  assert.equal(isoDay(moment, 'Europe/Vienna'), '2026-08-23');
  assert.equal(isoDay(moment, 'America/Los_Angeles'), '2026-08-22');
});

test('zaehlt Tage ueber Monatsgrenzen hinweg', () => {
  assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(daysBetween('2026-08-22', '2026-08-22'), 0);
  assert.ok(Number.isNaN(daysBetween('unsinn', '2026-08-22')));
});

test('nennt die naechsten Tage beim Namen und danach beim Wochentag', () => {
  const label = (iso) => dayLabel(iso, '2026-08-22', 'de-DE', 'Europe/Vienna');
  assert.equal(label('2026-08-22'), 'Heute');
  assert.equal(label('2026-08-23'), 'Morgen');
  assert.equal(label('2026-08-24'), 'Uebermorgen');
  assert.equal(label('2026-08-25'), 'Dienstag');
});

test('stellt heute vor die Vorhersage', () => {
  const slides = buildSlides(STATE, CONFIG, {
    locale: 'de-DE',
    timeZone: 'Europe/Vienna',
    now: NOW,
  });
  assert.deepEqual(
    slides.map((slide) => slide.label),
    ['Heute', 'Morgen', 'Uebermorgen', 'Dienstag'],
  );
  // Heute die gemessene Temperatur, spaeter der Tageshoechstwert.
  assert.deepEqual(
    slides.map((slide) => slide.temperature),
    [21, 24, 26, 22],
  );
});

test('gibt jeder Karte denselben Kurztext-Aufbau', () => {
  const slides = buildSlides(STATE, CONFIG, {
    locale: 'de-DE',
    timeZone: 'Europe/Vienna',
    now: NOW,
  });
  assert.equal(slides[0].note, 'Teilweise bewoelkt \u00b7 9 km/h');
  assert.equal(slides[1].note, 'Klar \u00b7 Tief 12\u00b0');
});

test('laesst den Wind weg, wenn er abgeschaltet ist', () => {
  const slides = buildSlides({ ...STATE, forecast: [] }, { ...CONFIG, showWind: false }, {
    locale: 'de-DE',
    timeZone: 'Europe/Vienna',
    now: NOW,
  });
  assert.equal(slides[0].note, 'Teilweise bewoelkt');
});

test('faerbt jede Karte nach ihrer eigenen Temperatur', () => {
  const slides = buildSlides(STATE, { ...CONFIG, units: 'imperial' }, {
    locale: 'de-DE',
    timeZone: 'Europe/Vienna',
    now: NOW,
  });
  // Fahrenheit-Werte gehen als Celsius in den Farbton, sonst waere alles warm.
  assert.equal(Math.round(slides[0].celsius), -6);
});

test('faengt ohne aktuellen Wert gar nicht erst an', () => {
  // Ein Stapel, der bei "Morgen" beginnt, behauptet, heute sei nichts bekannt.
  const slides = buildSlides({ ...STATE, current: null }, CONFIG, {
    locale: 'de-DE',
    timeZone: 'Europe/Vienna',
    now: NOW,
  });
  assert.deepEqual(slides, []);
});

/* ------------------------------ Tagesverlauf ------------------------------ */

test('nimmt den Tagesverlauf ab der aktuellen Stunde', () => {
  const points = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    temperature: hour,
  }));
  const picked = pickHourly(points, 8);
  // Was schon vorbei ist, gehoert nicht in einen Verlauf, den man jetzt liest:
  // der erste Punkt sitzt auf jetzt, der letzte auf der letzten Stunde des Tages.
  assert.deepEqual(
    picked.map((point) => point.hour),
    ['08', '11', '14', '17', '20', '23'],
  );
});

test('rutscht zurueck, wenn der Rest des Tages nicht mehr reicht', () => {
  const points = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    temperature: hour,
  }));
  // Um 23 Uhr bliebe nach vorn genau ein Punkt uebrig. Lieber der ganze Tag
  // als ein einzelner Balken am Abend.
  const picked = pickHourly(points, 23);
  assert.deepEqual(
    picked.map((point) => point.hour),
    ['18', '19', '20', '21', '22', '23'],
  );
});

test('liefert immer genau so viele Punkte, wie das Diagramm traegt', () => {
  const points = Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, '0'),
    temperature: hour,
  }));
  // Egal zu welcher Stunde gefragt wird: die Zahl der Balken bleibt dieselbe,
  // sonst spraenge die Breite der Grafik im Lauf des Tages.
  for (let nowHour = 0; nowHour < 24; nowHour += 1) {
    assert.equal(pickHourly(points, nowHour).length, HOURLY_POINTS);
  }
});

test('gibt einen kurzen Verlauf unveraendert zurueck', () => {
  const points = [
    { hour: '08', temperature: 12 },
    { hour: '14', temperature: 21 },
  ];
  assert.deepEqual(pickHourly(points, 8), points);
  assert.deepEqual(pickHourly([], 8), []);
});

test('findet die Spitze des Verlaufs', () => {
  assert.equal(
    peakIndex([
      { hour: '08', temperature: 12 },
      { hour: '14', temperature: 21 },
      { hour: '20', temperature: 17 },
    ]),
    1,
  );
  assert.equal(peakIndex([]), -1);
});

test('rechnet die Balkenhoehe gegen die Spanne des Tages', () => {
  // Der kaelteste Punkt bleibt ein Balken und wird kein Strich.
  assert.equal(barHeight(12, 12, 21), 18);
  assert.equal(barHeight(21, 12, 21), 100);
  // Ohne Spanne gibt es nichts zu vergleichen: alle Balken gleich hoch.
  assert.equal(barHeight(18, 18, 18), 100);
});

/* ---------------------------------- Form ---------------------------------- */

const place = (patch = {}) => ({ size: 'l', stale: false, error: false, night: false, ...patch });

test('zeigt in jeder Aufhaengung dieselbe Form', () => {
  // Die Form haengt an der Groesse und an sonst nichts. Ein Modul, das im
  // Kopfband etwas anderes zeigte als im Raster, waere fuer den, der davor
  // steht, zwei Module: derselbe Name, dieselbe Groesse, zwei Anzeigen.
  assert.equal(weatherForm(place({ size: 's' })), 'badge');
  assert.equal(weatherForm(place({ size: 'm' })), 'full');
  assert.equal(weatherForm(place({ size: 'l' })), 'deck');
  assert.equal(weatherForm(place({ size: 'xl' })), 'full');
});

test('schaltet nur im grossen Block durch, und nur mit frischen Werten', () => {
  assert.equal(weatherForm(place({ size: 'l' })), 'deck');
  assert.equal(weatherForm(place({ size: 'l', stale: true })), 'full');
  assert.equal(weatherForm(place({ size: 'l', error: true })), 'full');
  // Nachts bewegt sich nichts – im dunklen Raum zieht jede Bewegung den Blick.
  assert.equal(weatherForm(place({ size: 'l', night: true })), 'full');
});

test('faellt bei einer unbekannten Groesse auf die feste Ansicht zurueck', () => {
  assert.equal(weatherForm(place({ size: 'xxl' })), 'full');
});

/* ------------------------------- Standzeit -------------------------------- */

test('nimmt ohne eigene Angabe den Takt des Design-Systems', () => {
  // Aeltere Konfigurationen kennen das Feld nicht und sollen sich nicht
  // ploetzlich anders bewegen.
  assert.equal(dwellMs(undefined), MOTION.dwell);
  assert.equal(dwellMs(null), MOTION.dwell);
  assert.equal(dwellMs('acht'), MOTION.dwell);
  // Nicht als "null Sekunden" lesen: Number(null) und Number('') sind beide 0.
  assert.equal(dwellMs(''), MOTION.dwell);
  assert.equal(dwellMs('8'), MOTION.dwell);
});

test('rechnet Sekunden in Millisekunden', () => {
  assert.equal(dwellMs(2.6), 2600);
  assert.equal(dwellMs(8), 8000);
  assert.equal(dwellMs(12.4), 12400);
});

test('haelt die Standzeit in ihrer Spanne', () => {
  // Von Hand bearbeitete Dateien koennen alles enthalten; ein Takt von einer
  // Zehntelsekunde waere ein Flackern, einer von einer Stunde ein Stillstand.
  assert.equal(dwellMs(0.1), DWELL_SECONDS.min * 1000);
  assert.equal(dwellMs(-5), DWELL_SECONDS.min * 1000);
  assert.equal(dwellMs(3600), DWELL_SECONDS.max * 1000);
});
