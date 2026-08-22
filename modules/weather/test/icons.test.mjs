import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUDS, FIELD, REACH, SAFE_MARGIN, cloudBox, cloudPath, glyphBox } from '../dist/glyphs.js';
import { WEATHER_CODES } from '../dist/shared.js';

/*
 * Die Symbole des Wettermoduls stehen sehr gross auf dem Spiegel und bewegen
 * sich. Beides zusammen hat einen Fehler erzeugt, den man erst sieht, wenn er
 * schon da ist: die Wolken waren so gezeichnet, dass sie ueber die Kante ihres
 * Feldes reichten, und das SVG hat sie stillschweigend abgeschnitten.
 *
 * Die Tests hier rechnen deshalb nicht die Zeichnung nach, sondern ihren
 * *Bewegungsraum*: Form plus halbe Strichstaerke plus groesster Ausschlag der
 * Animation. Was da hineinpasst, kann nicht mehr an den Rand stossen.
 */

/** Jedes Symbol, das describeWeather() ueberhaupt liefern kann. */
const NAMES = [
  ...new Set(
    Object.values(WEATHER_CODES).flatMap((entry) => [entry.icon, entry.night].filter(Boolean)),
  ),
  // Der Rueckfall fuer unbekannte Wettercodes.
  'cloud',
];

test('kein Symbol stoesst an den Rand seines Feldes', () => {
  for (const name of NAMES) {
    const b = glyphBox(name);
    assert.ok(
      b.left >= SAFE_MARGIN,
      `${name} steht links ueber der Kante: ${b.left.toFixed(2)}`,
    );
    assert.ok(
      b.right <= FIELD - SAFE_MARGIN,
      `${name} steht rechts ueber der Kante: ${b.right.toFixed(2)}`,
    );
    assert.ok(b.top >= SAFE_MARGIN, `${name} steht oben ueber der Kante: ${b.top.toFixed(2)}`);
    assert.ok(
      b.bottom <= FIELD - SAFE_MARGIN,
      `${name} steht unten ueber der Kante: ${b.bottom.toFixed(2)}`,
    );
  }
});

test('der Bewegungsraum ist groesser als die Zeichnung', () => {
  // Sonst pruefte der Test oben die Bewegung gar nicht mit.
  const still = cloudBox(CLOUDS.high);
  const moving = glyphBox('cloud-rain');
  assert.ok(moving.left < still.left - REACH.drift.x, 'die Drift fehlt in der Rechnung');
  assert.ok(moving.bottom > still.bottom + REACH.fall.down, 'der Fallweg fehlt in der Rechnung');
});

test('eine Wolke laeuft ueber ihre drei Kuppen und schliesst sich', () => {
  const d = cloudPath(CLOUDS.low);
  // Boden nach links, dann drei Boegen, dann zu.
  assert.match(d, /^M[\d.]+ [\d.]+H[\d.]+A/);
  assert.equal(d.match(/A/g)?.length, 3);
  assert.ok(d.endsWith('Z'));
});

test('kein Bogen ist kleiner als seine Sehne', () => {
  /*
   * Der Fehler des ersten Satzes: SVG vergroessert einen zu kleinen Radius
   * stillschweigend, und die Kuppe blaeht sich weiter auf als gedacht. Passt
   * jede Sehne in ihren Kreis, kann das nicht passieren.
   */
  for (const [name, spec] of Object.entries(CLOUDS)) {
    const d = cloudPath(spec);
    let cursor = null;
    for (const match of d.matchAll(/([MHA])([\d. ]+)/g)) {
      const nums = match[2].trim().split(/\s+/).map(Number);
      if (match[1] === 'M') cursor = { x: nums[0], y: nums[1] };
      else if (match[1] === 'H') cursor = { x: nums[0], y: cursor.y };
      else {
        // A rx ry Drehung gross-Flag Richtungs-Flag x y
        const [r, , , , , x, y] = nums;
        const chord = Math.hypot(x - cursor.x, y - cursor.y);
        assert.ok(
          chord <= 2 * r + 1e-9,
          `${name}: Sehne ${chord.toFixed(2)} passt nicht in den Kreis mit Radius ${r}`,
        );
        cursor = { x, y };
      }
    }
  }
});
