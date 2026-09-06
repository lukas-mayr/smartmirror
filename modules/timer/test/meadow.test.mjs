import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIG } from '@mirror/sdk';
import {
  BLADES,
  FIELD,
  GROUND,
  MEADOW,
  SURFACE,
  STROKE,
  SWIM,
  TURTLE,
  bladeHeightAt,
  bodyAt,
  flipperTipAt,
  grazeCut,
  grazeShift,
  headAt,
  meadowBox,
  meadowHeightAt,
  meadowLeft,
  meadowPath,
  noseAt,
  standingBlade,
  stubblePath,
} from '../dist/meadow.js';
import { mountainSize, remainingShare } from '../dist/shared.js';

/*
 * Eine Wiese, an der ein Tier frisst, besteht aus Dingen, die unabhaengig
 * voneinander entstanden sind und trotzdem zusammenpassen muessen: Gras, das
 * kuerzer wird, ein Schnabel, der es trifft, und ein Atemzug, der an der
 * Oberflaeche stattfinden muss und nicht daneben. Ob das zusammengeht, sieht
 * man auf dem Spiegel — und dort erst, wenn es zu spaet ist. Deshalb wird es
 * hier gerechnet.
 *
 * Geprueft wird nicht die Zeichnung, sondern was sie behauptet.
 */

const SIZES = [DIG.minSize, 0.8, 1];
const POSES = Object.entries(SWIM);

/* --------------------------- Wie die Wiese faellt -------------------------- */

test('jeder Biss nimmt gleich viel Wiese weg', () => {
  /*
   * Der Kern der Darstellung — und der Unterschied zum Berg: gleich viel heisst
   * hier gleich viel *Strecke*. Waere es anders, bliebe am Ende ein Buschen
   * stehen oder die Wiese waere zu frueh weg, und in beiden Faellen erzaehlte
   * das Bild etwas anderes als die Uhr.
   */
  for (const size of SIZES) {
    const full = MEADOW.right - meadowLeft(size);
    let previous = null;
    for (let share = 1; share >= 0; share -= 0.1) {
      const rest = MEADOW.right - grazeCut(size, share);
      assert.ok(Math.abs(rest - full * share) < 1e-9, `bei ${share.toFixed(1)} stehen ${rest}`);
      if (previous !== null) {
        assert.ok(rest < previous, 'die Kante wandert nicht');
      }
      previous = rest;
    }
  }
});

test('das rechte Ende steht fest, die Wiese waechst nach links', () => {
  /*
   * Dort hoert die Zeit auf, und zwar unabhaengig davon, wie lange sie laeuft.
   * Waechse die Wiese nach rechts, endete ein langer Timer an einer anderen
   * Stelle als ein kurzer — und die Schildkroete schwaemme bei jeder Dauer
   * woanders hin.
   */
  const short = meadowLeft(mountainSize(5 * 60_000));
  const long = meadowLeft(mountainSize(60 * 60_000));
  assert.ok(long < short, 'der laengere Timer bekommt keine laengere Wiese');
  assert.equal(grazeCut(1, 0), MEADOW.right);
  assert.equal(grazeCut(DIG.minSize, 0), MEADOW.right);
});

test('die groesste Wiese passt ins Feld und bleibt unter Wasser', () => {
  const box = meadowBox(1, 1);
  assert.ok(box.left >= 2, `die Wiese beginnt bei ${box.left}`);
  assert.ok(box.right <= FIELD.width - 2, `die Wiese reicht bis ${box.right}`);
  assert.equal(box.bottom, GROUND);
  // Gras, das aus dem Wasser ragt, ist Schilf und waechst nicht im Meer.
  assert.ok(box.top > SURFACE + 20, `die Halme reichen bis ${box.top.toFixed(1)}`);
});

test('die Wiese verschwindet, wenn nichts mehr steht', () => {
  assert.equal(meadowPath(1, 0), '');
  // Ein Bueschel von zwei Einheiten liest sich als Schmutz auf dem Spiegel und
  // nicht als "fast fertig".
  assert.equal(meadowPath(1, 0.0001), '');
  assert.ok(meadowPath(1, 1).length > 0);
});

test('der Umriss beginnt und endet auf dem Grund und ist geschlossen', () => {
  const path = meadowPath(1, 1);
  assert.match(path, new RegExp(`^M${meadowLeft(1)} ${GROUND}L`));
  assert.ok(path.endsWith(`L${MEADOW.right} ${GROUND}Z`), path.slice(-24));
});

test('vor dem ersten Biss ist die Wiese unberuehrt', () => {
  // Sonst frisst die Schildkroete den ersten Halm an einer Wiese, die schon
  // angefressen aussieht.
  assert.equal(grazeCut(1, 1), meadowLeft(1));
  assert.equal(stubblePath(1, 1), '');
  for (let x = meadowLeft(1); x <= MEADOW.right; x += 1) {
    assert.equal(meadowHeightAt(1, 1, x), bladeHeightAt(1, x));
  }
});

test('hinter der Kante steht Stoppel und vor ihr Gras', () => {
  /*
   * Genau daran erkennt man eine abgeweidete Wiese: eine Spur. Ohne sie wuerde
   * das Gras ausgeblendet und nicht gefressen — derselbe Unterschied wie
   * zwischen einer Grube und einem Berg, der kleiner wird.
   */
  const cut = grazeCut(1, 0.5);
  assert.equal(meadowHeightAt(1, 0.5, cut - 4), 0);
  assert.ok(meadowHeightAt(1, 0.5, cut + 4) > 4);
  const stubble = stubblePath(1, 0.5);
  assert.ok(stubble.length > 0, 'es bleibt keine Spur');
  assert.ok(stubblePath(1, 0.1).length > stubble.length, 'die Spur waechst nicht mit');
});

test('die Wiese laeuft an ihren Enden aus, die frische Kante nicht', () => {
  // Eine Wiese hoert nicht an einer Kante auf, sie duennt aus — ausser dort, wo
  // eben noch ein Maul war.
  const left = meadowLeft(1);
  assert.ok(bladeHeightAt(1, left + 1) < bladeHeightAt(1, left + 10));
  assert.ok(bladeHeightAt(1, MEADOW.right - 1) < bladeHeightAt(1, MEADOW.right - 10));
  const cut = grazeCut(1, 0.5);
  assert.ok(meadowHeightAt(1, 0.5, cut + 0.5) > 6, 'die Fresskante ist keine Kante');
});

test('kein Halm gleicht dem naechsten, und keiner faellt aus dem Muster', () => {
  /*
   * Ein Muster aus lauter gleichen Spitzen ist ein Kamm und keine Wiese. Drei
   * Zahlen machen den Unterschied — Hoehe, Breite, Neigung —, und keine davon
   * darf ueber das Muster gleich bleiben.
   */
  assert.ok(BLADES.length >= 7, 'zu wenige Halme: das Muster wiederholt sich sichtbar');
  const heights = BLADES.map((blade) => blade.height);
  assert.ok(Math.max(...heights) <= 1 && Math.min(...heights) > 0.4);
  assert.equal(new Set(heights).size, BLADES.length, 'zwei Halme sind gleich hoch');
  assert.ok(new Set(BLADES.map((blade) => blade.width)).size > BLADES.length / 2);

  // Die Neigungen wechseln die Richtung und heben sich ungefaehr auf: alle in
  // dieselbe Richtung waeren eine Stroemung, und eine, die immer steht, ist
  // keine.
  const leans = BLADES.map((blade) => blade.lean);
  assert.ok(leans.some((lean) => lean > 0) && leans.some((lean) => lean < 0));
  assert.ok(Math.abs(leans.reduce((sum, lean) => sum + lean, 0)) < 6);
});

test('die Halme stehen fest an der Wiese und nicht an ihrem Rest', () => {
  /*
   * Gezaehlt wird vom rechten Ende her. Nur so steht derselbe Halm bei jedem
   * Stand an derselben Stelle — sonst rutschte die ganze Wiese bei jedem Biss
   * ein Stueck, und aus dem Fressen wuerde ein Flackern.
   */
  const third = standingBlade(3);
  assert.ok(third.right < MEADOW.right && third.left < third.right);
  assert.ok(third.tip.x > third.left && third.tip.x < third.right);
  for (const share of [1, 0.7, 0.3]) {
    assert.equal(standingBlade(3).tip.x, third.tip.x, `bei Rest ${share} steht er woanders`);
  }
});

/* ------------------ Trifft der Schnabel, was sie frisst? ------------------- */

test('der Schnabel steht an der Fresskante, egal wie weit sie ist', () => {
  /*
   * Die Zeichnung faehrt als Ganzes mit dem Vorschub, der Schnabel also auch.
   * Faende der Biss woanders statt, fraesse die Schildkroete sichtbar neben der
   * Wiese — der gleiche Fehler wie eine Schaufel, die in die Luft greift.
   */
  for (const size of SIZES) {
    for (let share = 1; share >= 0; share -= 0.05) {
      const mouth = TURTLE.mouth.x + grazeShift(size, share);
      assert.ok(
        Math.abs(mouth - grazeCut(size, share)) < 1e-9,
        `Groesse ${size}, Rest ${share.toFixed(2)}: Schnabel bei ${mouth.toFixed(1)}`,
      );
    }
  }
});

test('beim Biss taucht der Kopf ins Gras und nicht in den Sand', () => {
  const nose = noseAt(SWIM.bite);
  // Gemessen am hoechsten Halm dicht hinter der Kante: zwischen zwei Spitzen
  // steht das Gras tiefer, und dort hindurch faehrt jeder Schnabel.
  let tips = 0;
  for (let x = TURTLE.mouth.x; x <= TURTLE.mouth.x + 12; x += 0.5) {
    tips = Math.max(tips, bladeHeightAt(1, x));
  }
  const grass = GROUND - tips;
  assert.ok(nose.y > grass, `der Schnabel bleibt ${(grass - nose.y).toFixed(1)} ueber den Halmen`);
  assert.ok(nose.y < GROUND, 'der Schnabel faehrt in den Grund');
  // Und er taucht nach unten, nicht nach oben: ein Biss ist eine Bewegung zum
  // Gras hin.
  assert.ok(nose.y > noseAt(SWIM.glide).y);
});

test('sie schwimmt in Leserichtung: Kopf rechts, Panzer links', () => {
  assert.ok(TURTLE.mouth.x > TURTLE.neck.x, 'der Kopf sitzt hinter dem Panzer');
  assert.ok(TURTLE.neck.x > TURTLE.crest.x, 'der Hals sitzt hinter dem Ruecken');
  assert.ok(TURTLE.crest.x > TURTLE.tail.x, 'der Ruecken sitzt hinter dem Schwanz');
  assert.ok(TURTLE.hind.x < TURTLE.tail.x, 'die Hinterflosse steht vorn');
  // Der Panzer ist flach: eine Suppenschildkroete ist im Seitenriss lang und
  // niedrig, und daran erkennt man sie.
  const length = TURTLE.mouth.x - TURTLE.hind.x;
  const height = TURTLE.mouth.y - TURTLE.crest.y;
  assert.ok(length > height * 2, `sie ist ${length} lang und ${height} hoch`);
});

/* ----------------------- Bekommt sie oben Luft? ---------------------------- */

test('im Atemzug erreicht die Nase die Oberflaeche', () => {
  /*
   * Der Sinn der ganzen Runde. Eine Schildkroete, die einen halben Meter unter
   * der Oberflaeche Luft holt, ist ertrunken — und aus drei Metern sieht man
   * genau das: ein Tier, das oben ankommt oder eben nicht.
   */
  const nose = noseAt(SWIM.breath);
  assert.ok(Math.abs(nose.y - SURFACE) <= 2, `die Nase steht bei ${nose.y.toFixed(1)}`);
});

test('der Panzer bleibt dabei unter Wasser', () => {
  // Eine Schildkroete, die aus dem Wasser springt, ist ein Delfin.
  const crest = bodyAt(TURTLE.crest, SWIM.breath);
  assert.ok(crest.y > SURFACE + 4, `der Panzer steht bei ${crest.y.toFixed(1)}`);
  assert.ok(crest.y > noseAt(SWIM.breath).y, 'die Nase kommt nicht ueber den Panzer');
});

test('sie steigt und sinkt, und dazwischen liegt kein Sprung', () => {
  const rises = [SWIM.glide, SWIM.climb, SWIM.breath, SWIM.sink].map((pose) => pose.rise);
  assert.deepEqual([...rises].sort((a, b) => b - a)[0], SWIM.breath.rise);
  assert.ok(SWIM.climb.rise > SWIM.glide.rise && SWIM.climb.rise < SWIM.breath.rise);
  assert.ok(SWIM.sink.rise > 0 && SWIM.sink.rise < SWIM.climb.rise);
  // Aufwaerts die Nase hoch, abwaerts die Nase runter — sonst schwimmt sie
  // rueckwaerts nach oben.
  assert.ok(SWIM.climb.pitch < 0 && SWIM.breath.pitch < 0);
  assert.ok(SWIM.sink.pitch > 0);
});

/* --------------------------- Bleibt alles im Feld? ------------------------- */

test('in jeder Stellung und ganz vorgerueckt bleibt sie im Feld', () => {
  const shift = grazeShift(1, 0);
  for (const [name, pose] of POSES) {
    const points = [
      ['Nase', noseAt(pose)],
      ['Hals', headAt(TURTLE.neck, pose)],
      ['Ruecken', bodyAt(TURTLE.crest, pose)],
      ['Schwanz', bodyAt(TURTLE.tail, pose)],
      ['Hinterflosse', bodyAt(TURTLE.hind, pose)],
      ['Vorderflosse', flipperTipAt(pose)],
    ];
    for (const [part, point] of points) {
      assert.ok(point.x >= 2, `${name}/${part} steht links ueber der Kante: ${point.x.toFixed(1)}`);
      assert.ok(
        point.x + shift <= FIELD.width - 2,
        `${name}/${part} steht vorgerueckt bei ${(point.x + shift).toFixed(1)}`,
      );
      assert.ok(
        point.y >= FIELD.top + 2,
        `${name}/${part} steht oben ueber der Kante: ${point.y.toFixed(1)}`,
      );
      assert.ok(point.y <= GROUND, `${name}/${part} steckt im Grund: ${point.y.toFixed(1)}`);
    }
  }
});

test('die Flosse schlaegt und faehrt dabei nicht in den Grund', () => {
  /*
   * Sie schlaegt im Takt des Bisses weiter, waehrend die Schildkroete ueber der
   * Kante steht — und dort ist der Grund nah. Eine Flosse, die im Abschlag im
   * Sand steckt, macht aus dem Schweben ein Kriechen.
   */
  const down = flipperTipAt(SWIM.glide, STROKE.down);
  const up = flipperTipAt(SWIM.glide, STROKE.up);
  assert.ok(down.y < GROUND - 4, `die Flosse streift den Grund bei ${down.y.toFixed(1)}`);
  assert.ok(up.y < down.y - 4, 'die Flosse steht still');
  assert.ok(STROKE.up < 0 && STROKE.down > 0, 'sie schlaegt nur in eine Richtung');
});

/* ------------------------ Passt sie zum Takt des Moduls? ------------------- */

test('der vierte Biss ist zu Ende, bevor sie aufsteigt', () => {
  /*
   * Dieselbe Rechnung wie beim Lastwagen, der erst anfaehrt, wenn die Schaufel
   * leer ist: der letzte Biss einer Runde endet bei 79 % ihrer Dauer, und erst
   * danach faengt der Aufstieg an. Die 79 stehen als Keyframe im Stylesheet.
   * Steigt sie frueher, reisst sie den letzten Halm im Aufstieg ab.
   */
  const bitesPerRound = DIG.perLoad;
  const biteEnds = 0.16; // Ende des Bisses, als Anteil eines Bisses (sea-bite)
  const lastBiteEnds = (bitesPerRound - 1 + biteEnds) / bitesPerRound;
  assert.ok(lastBiteEnds <= 0.79, `der letzte Biss endet bei ${(lastBiteEnds * 100).toFixed(1)} %`);
});

test('die Wiese folgt derselben Uhr wie der Berg', () => {
  // Ein Biss dauert `DIG.bucket`, und was er wegnimmt, faellt aus derselben
  // Rechnung wie der Bissen aus dem Berg. Das Motiv aendert das Bild und nicht
  // die Zeit.
  const total = 20 * 60_000;
  const size = mountainSize(total);
  const full = MEADOW.right - meadowLeft(size);
  const afterOne = MEADOW.right - grazeCut(size, remainingShare(DIG.bucket, total));
  const afterTwo = MEADOW.right - grazeCut(size, remainingShare(2 * DIG.bucket, total));
  assert.ok(Math.abs(full - afterOne - (afterOne - afterTwo)) < 1e-9, 'zwei Bisse, zwei Groessen');
  assert.ok(full - afterOne > 0, 'der erste Biss nimmt nichts weg');
});
