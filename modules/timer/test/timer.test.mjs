import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIG } from '@mirror/sdk';
import {
  bucketCount,
  digPhaseMs,
  durationMs,
  formatRemaining,
  loadCount,
  mountainSize,
  remainingShare,
  timerLabel,
  timerWindow,
} from '../dist/shared.js';

/*
 * Die eine Regel, an der dieses Modul haengt: der Bagger arbeitet immer gleich
 * schnell. Ein laengerer Timer macht den Berg groesser und nicht die Bewegung
 * langsamer — ein Bagger in Zeitlupe sieht nicht nach viel Arbeit aus, sondern
 * nach einem haengenden Bildschirm.
 *
 * Genau das laesst sich pruefen, ohne einen Browser zu starten: die Dauer
 * eines Eimers ist eine Konstante, die Zahl der Eimer eine Rechnung.
 */

/* --------------------------------- Der Takt -------------------------------- */

test('ein Eimer dauert immer gleich lang, egal wie lang der Timer ist', () => {
  for (const minutes of [1, 5, 10, 25, 60, 120]) {
    const total = durationMs(minutes);
    const perBucket = total / bucketCount(total);
    assert.ok(
      Math.abs(perBucket - DIG.bucket) < 1,
      `${minutes} min: ein Eimer dauert ${perBucket} ms statt ${DIG.bucket} ms`,
    );
  }
});

test('laenger heisst mehr Eimer und mehr Lastwagen', () => {
  assert.ok(bucketCount(durationMs(30)) > bucketCount(durationMs(10)));
  assert.ok(loadCount(durationMs(30)) > loadCount(durationMs(10)));
  // Vier Eimer auf einen Wagen – und der angefangene zaehlt mit.
  assert.equal(loadCount(DIG.bucket * DIG.perLoad), 1);
  assert.equal(loadCount(DIG.bucket * (DIG.perLoad + 1)), 2);
});

test('auch der kuerzeste Timer hat etwas zu graben', () => {
  assert.ok(bucketCount(1000) >= 1);
  assert.ok(bucketCount(0) >= 1);
  assert.ok(bucketCount(Number.NaN) >= 1);
});

/* --------------------------------- Der Berg -------------------------------- */

test('der Berg waechst mit der Dauer, ohne aus dem Block zu wachsen', () => {
  const sizes = [1, 5, 10, 30, 60, 120].map((minutes) => mountainSize(durationMs(minutes)));
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index] >= sizes[index - 1], `bei ${index} wird der Berg kleiner statt groesser`);
  }
  assert.ok(sizes.at(-1) <= 1, 'der Berg waechst ueber den Block hinaus');
  assert.ok(sizes[0] >= DIG.minSize, 'ein kurzer Timer bekommt keinen erkennbaren Berg');
});

test('eine halbe Stunde ist sichtbar mehr Berg als zehn Minuten', () => {
  // Ohne diesen Abstand waere die Groesse zwar formal richtig und trotzdem
  // wertlos: zwei Timer, die gleich aussehen, sagen nichts ueber ihre Dauer.
  const short = mountainSize(durationMs(10));
  const long = mountainSize(durationMs(30));
  assert.ok(long - short > 0.15, `Unterschied nur ${(long - short).toFixed(3)}`);
});

test('ab einer halben Stunde ist der Berg voll', () => {
  /*
   * Laenger heisst ab hier nicht mehr groesser. Der Block waechst nicht mit,
   * und zwei Berge, die sich um eine Handbreit unterscheiden, sagen weniger
   * als einer, der voll ist. Der Bereich, in dem man den Unterschied sieht,
   * liegt dort, wo ein Timer meistens steht: in der ersten halben Stunde.
   */
  assert.equal(mountainSize(durationMs(30)), 1);
  assert.equal(mountainSize(durationMs(120)), 1);
});

test('jeder Eimer nimmt einen Bissen, und der letzte raeumt den Berg weg', () => {
  const total = durationMs(1);
  const buckets = bucketCount(total);
  assert.equal(remainingShare(0, total), 1);
  assert.equal(remainingShare(DIG.bucket, total), 1 - 1 / buckets);
  assert.equal(remainingShare(total, total), 0);
  // Zwischen zwei Eimern steht der Berg still – der Bissen gehoert zum Graben
  // und nicht zum Vergehen der Zeit.
  assert.equal(remainingShare(DIG.bucket + 1, total), remainingShare(DIG.bucket * 1.9, total));
});

test('was ueber die Zeit hinausgeht, laesst den Berg nicht negativ werden', () => {
  const total = durationMs(5);
  assert.equal(remainingShare(total * 3, total), 0);
  assert.equal(remainingShare(-1000, total), 1);
});

/* -------------------------------- Der Versatz ------------------------------ */

test('der Versatz liegt immer innerhalb einer Ladung', () => {
  const period = DIG.bucket * DIG.perLoad;
  for (const elapsed of [0, 1, 4999, 5000, 19_999, 20_000, 123_456]) {
    const phase = digPhaseMs(elapsed);
    assert.ok(phase >= 0 && phase < period, `${elapsed} ms ergibt Versatz ${phase} ms`);
  }
  // Nach genau einer Ladung steht die Bewegung wieder am Anfang.
  assert.equal(digPhaseMs(period), 0);
  assert.equal(digPhaseMs(period + 1200), 1200);
});

/* --------------------------------- Ziffern --------------------------------- */

test('die Restzeit wird aufgerundet, damit nicht 0:00 dasteht, solange etwas laeuft', () => {
  assert.equal(formatRemaining(1), '00:01');
  assert.equal(formatRemaining(1000), '00:01');
  assert.equal(formatRemaining(1001), '00:02');
  assert.equal(formatRemaining(0), '00:00');
  assert.equal(formatRemaining(-5000), '00:00');
});

test('die Stunde kommt erst dazu, wenn es eine gibt', () => {
  assert.equal(formatRemaining(59_000), '00:59');
  assert.equal(formatRemaining(600_000), '10:00');
  assert.equal(formatRemaining(3_600_000), '1:00:00');
  assert.equal(formatRemaining(3_723_000), '1:02:03');
});

/* -------------------------------- Der Zustand ------------------------------ */

test('zwei brauchbare Zeitpunkte ergeben einen Timer, alles andere keinen', () => {
  const window = timerWindow({ startedAt: '2026-08-23T10:00:00.000Z', endsAt: '2026-08-23T10:10:00.000Z' });
  assert.equal(window.end - window.start, 600_000);

  assert.equal(timerWindow(undefined), null);
  assert.equal(timerWindow({ startedAt: null, endsAt: null }), null);
  assert.equal(timerWindow({ startedAt: 'Unsinn', endsAt: 'auch Unsinn' }), null);
  // Ein Ende vor dem Anfang ist kein Timer, sondern ein Fehler – und ein Block,
  // der daran zerbricht, zeigt gar nichts mehr.
  assert.equal(
    timerWindow({ startedAt: '2026-08-23T10:10:00.000Z', endsAt: '2026-08-23T10:00:00.000Z' }),
    null,
  );
});

test('aus einer leeren Beschriftung wird "Timer" und keine leere Zeile', () => {
  assert.equal(timerLabel('Pizza'), 'Pizza');
  assert.equal(timerLabel('  Pizza  '), 'Pizza');
  assert.equal(timerLabel(''), 'Timer');
  assert.equal(timerLabel(undefined), 'Timer');
});

test('eine unbrauchbare Dauer faellt auf die Voreinstellung zurueck', () => {
  assert.equal(durationMs(25), 25 * 60_000);
  assert.equal(durationMs('25'), 25 * 60_000);
  assert.equal(durationMs(0), 10 * 60_000);
  assert.equal(durationMs(-5), 10 * 60_000);
  assert.equal(durationMs('Unsinn'), 10 * 60_000);
});
