import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIG } from '@mirror/sdk';
import {
  ARM,
  FIELD,
  GROUND,
  MOUNTAIN,
  POSE,
  PROFILE,
  SLEW_X,
  TRACK,
  TRUCK,
  cargoPath,
  knuckleAt,
  mountainBox,
  mountainHeightAt,
  mountainPath,
  mountainSpan,
  pinAt,
  toothAt,
} from '../dist/scene.js';
import { mountainSize } from '../dist/shared.js';

/*
 * Eine Baustelle besteht aus drei Dingen, die unabhaengig voneinander
 * entstanden sind und trotzdem zusammenpassen muessen: ein Berg, der kleiner
 * wird, ein Arm, der sich dreht, und ein Wagen, der darunter steht. Ob das
 * zusammengeht, sieht man auf dem Spiegel — und dort erst, wenn es zu spaet
 * ist. Deshalb wird es hier gerechnet.
 *
 * Geprueft wird nicht die Zeichnung, sondern was sie behauptet: dass der Zahn
 * den Berg trifft, dass die Ladung in die Mulde faellt und dass nichts an den
 * Rand des Feldes stoesst.
 */

const POSES = Object.entries(POSE);

/* ------------------------ Trifft der Bagger den Berg? ---------------------- */

test('der Grabzug ueberstreicht den Fuss des Berges', () => {
  /*
   * Der Berg schrumpft auf seinen linken Fuss zu. Faehrt der Zahn von rechts
   * davon nach links darueber hinweg, trifft er den Berg in jeder Groesse —
   * beim ersten Eimer wie beim letzten. Ginge der Zug woanders entlang, gruebe
   * der Bagger irgendwann sichtbar neben dem Berg.
   */
  const reach = toothAt(POSE.reach);
  const full = toothAt(POSE.full);
  assert.ok(reach.x > MOUNTAIN.left, `der Zug beginnt schon links vom Berg (${reach.x})`);
  assert.ok(full.x < MOUNTAIN.left, `der Zug endet rechts vom Fuss (${full.x})`);
});

test('der Zahn kommt beim Graben auf dem Boden an', () => {
  const cut = toothAt(POSE.cut);
  assert.ok(cut.y > GROUND - 4, `der Zahn bleibt ${(GROUND - cut.y).toFixed(1)} ueber dem Boden`);
  assert.ok(cut.y <= GROUND, 'der Zahn faehrt unter den Boden');
});

test('die eingezogene Schaufel steht neben der Raupe und nicht darauf', () => {
  // Eine Schaufel, die durch das eigene Fahrwerk faehrt, faellt sofort auf.
  const full = toothAt(POSE.full);
  assert.ok(full.x > TRACK.right, `die Schaufel landet auf der Raupe (${full.x})`);
});

/* ----------------------- Faellt die Ladung in die Mulde? ------------------- */

test('nach der Drehung haengt die Schaufel ueber der Mulde', () => {
  const tooth = toothAt(POSE.tipped, true);
  assert.ok(
    tooth.x > TRUCK.bed.left && tooth.x < TRUCK.bed.right,
    `gekippt wird bei x=${tooth.x.toFixed(1)}, die Mulde liegt bei ${TRUCK.bed.left}..${TRUCK.bed.right}`,
  );
  // Ueber der Bordwand: von unterhalb kaeme nichts hinein.
  assert.ok(tooth.y < TRUCK.rim, `die Schaufel kippt unterhalb der Bordwand (y=${tooth.y.toFixed(1)})`);
});

test('der Schwenk endet neben der Maschine und nicht ueber ihr', () => {
  /*
   * Nach der Drehung haengt die Schaufel schon links der Raupe — von dort aus
   * kippt sie nur noch nach links weiter, ueber die Mulde. Bliebe sie ueber der
   * Maschine stehen, schuettete sie auf das eigene Dach.
   */
  const raised = toothAt(POSE.raised, true);
  assert.ok(raised.x < TRACK.left, `die gehobene Schaufel steht bei x=${raised.x.toFixed(1)}`);
  assert.ok(raised.y < TRUCK.rim, 'die gehobene Schaufel haengt unterhalb der Bordwand');
  // Und sie kippt weiter nach links, nicht zurueck.
  assert.ok(toothAt(POSE.tipped, true).x < raised.x);
});

test('die Spiegelung ist die Drehung: was rechts der Achse liegt, liegt danach links davon', () => {
  const tooth = toothAt(POSE.raised);
  const turned = toothAt(POSE.raised, true);
  assert.ok(Math.abs(tooth.x - SLEW_X - (SLEW_X - turned.x)) < 1e-9);
  assert.equal(tooth.y, turned.y);
});

/* --------------------------- Bleibt alles im Feld? ------------------------- */

test('kein Gelenk stoesst an den Rand des Feldes', () => {
  for (const [name, pose] of POSES) {
    for (const slewed of [false, true]) {
      for (const [part, point] of [
        ['Knick', knuckleAt(pose, slewed)],
        ['Bolzen', pinAt(pose, slewed)],
        ['Zahn', toothAt(pose, slewed)],
      ]) {
        assert.ok(point.x >= 2, `${name}/${part} steht links ueber der Kante: ${point.x.toFixed(1)}`);
        assert.ok(
          point.x <= FIELD.width - 2,
          `${name}/${part} steht rechts ueber der Kante: ${point.x.toFixed(1)}`,
        );
        assert.ok(
          point.y >= FIELD.top + 2,
          `${name}/${part} steht oben ueber der Kante: ${point.y.toFixed(1)}`,
        );
        assert.ok(
          point.y <= FIELD.top + FIELD.height - 2,
          `${name}/${part} steht unten ueber der Kante: ${point.y.toFixed(1)}`,
        );
      }
    }
  }
});

test('der groesste Berg passt vollstaendig ins Feld', () => {
  const box = mountainBox(1, 1);
  assert.ok(box.right <= FIELD.width - 2, `der Berg reicht bis ${box.right}`);
  assert.ok(box.top >= FIELD.top + 2, `der Gipfel steht bei ${box.top}`);
  assert.equal(box.bottom, GROUND);
});

test('der Bagger steht links vom Berg und der Wagen links vom Bagger', () => {
  // Die Leserichtung der Szene: Material wandert vom Berg ueber den Bagger auf
  // den Wagen und faehrt nach links davon.
  assert.ok(TRUCK.bed.right < TRACK.left, 'die Mulde steht unter der Raupe');
  assert.ok(TRACK.right < MOUNTAIN.left, 'die Raupe steht im Berg');
  assert.equal(SLEW_X, (TRACK.left + TRACK.right) / 2, 'die Drehachse liegt nicht mittig auf der Raupe');
});

/* ------------------------------ Wie der Berg faellt ------------------------ */

test('der Berg verschwindet, wenn nichts mehr da ist', () => {
  assert.equal(mountainPath(1, 0), '');
  assert.equal(mountainPath(0, 1), '');
  // Ein Rest von wenigen Hundertsteln ist ein Strich auf dem Boden und liest
  // sich als Schmutz auf dem Spiegel, nicht als "fast fertig".
  assert.equal(mountainPath(DIG.minSize, 0.0001), '');
});

test('der Umriss beginnt und endet auf dem Boden und ist geschlossen', () => {
  const path = mountainPath(1, 1);
  assert.match(path, new RegExp(`^M${MOUNTAIN.left} ${GROUND}L`));
  assert.ok(path.endsWith('Z'));
  // Ein Stuetzpunkt je Profilpunkt, der erste als M, der Rest als L.
  assert.equal(path.match(/L/g).length, PROFILE.length - 1);
});

test('der Berg wird mit jedem Eimer kleiner und nie wieder groesser', () => {
  let previous = Number.POSITIVE_INFINITY;
  for (let share = 1; share >= 0; share -= 0.05) {
    const span = mountainSpan(1, share);
    const area = span.width * span.height;
    assert.ok(area <= previous + 1e-9, `bei ${share.toFixed(2)} waechst der Berg wieder`);
    previous = area;
  }
});

test('der Berg wird flacher als er schmaler wird', () => {
  /*
   * Ein abgetragener Haufen ist flacher und nicht bloss kleiner: gegraben wird
   * von der Seite. Waere beides gleich, saehe der Abbau aus wie ein Zoom.
   */
  const full = mountainSpan(1, 1);
  const half = mountainSpan(1, 0.5);
  assert.ok(half.height / full.height < half.width / full.width);
});

test('der Gipfel steht dort, wo das Profil ihn hinstellt', () => {
  const peak = PROFILE.reduce((best, point) => (point.y > best.y ? point : best));
  assert.equal(peak.y, 1);
  const span = mountainSpan(1, 1);
  const height = mountainHeightAt(1, 1, MOUNTAIN.left + peak.x * span.width);
  assert.ok(Math.abs(height - span.height) < 1e-9);
  // Neben dem Berg ist kein Berg.
  assert.equal(mountainHeightAt(1, 1, MOUNTAIN.left - 1), 0);
  assert.equal(mountainHeightAt(1, 1, MOUNTAIN.left + span.width + 1), 0);
});

test('die linke Flanke steht steiler als die rechte', () => {
  // An ihr wird gegraben; die rechte laeuft aus. Ein symmetrischer Kegel waere
  // ein Dach und kein Berg.
  const peak = PROFILE.reduce((best, point) => (point.y > best.y ? point : best));
  assert.ok(peak.x < 0.5, `der Gipfel steht bei ${peak.x}`);
});

test('ein langer Timer beginnt mit einem hoeheren Berg als ein kurzer', () => {
  const short = mountainBox(mountainSize(10 * 60_000), 1);
  const long = mountainBox(mountainSize(60 * 60_000), 1);
  assert.ok(long.top < short.top, 'der laengere Timer bekommt keinen hoeheren Berg');
  assert.ok(long.right > short.right, 'der laengere Timer bekommt keinen breiteren Berg');
  assert.ok(long.right <= FIELD.width - 2, 'der lange Berg laeuft aus dem Feld');
});

/* -------------------------------- Der Wagen -------------------------------- */

test('die Ladung bleibt in der Mulde', () => {
  const numbers = [...cargoNumbers()];
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  assert.ok(Math.min(...xs) >= TRUCK.bed.left, 'die Ladung haengt links ueber der Bordwand');
  assert.ok(Math.max(...xs) <= TRUCK.bed.right, 'die Ladung haengt rechts ueber der Bordwand');
  assert.ok(Math.max(...ys) <= TRUCK.floor, 'die Ladung faellt durch den Muldenboden');
  // Ein Haufen ragt ueber die Bordwand – sonst waere die Mulde nur halb voll.
  assert.ok(Math.min(...ys) < TRUCK.rim, 'die Ladung bleibt unter der Bordwand');
});

test('der volle Wagen faehrt weit genug, um aus dem Bild zu sein', () => {
  assert.ok(TRUCK.exit + TRUCK.bed.right < 0, 'ein Stueck des Wagens bleibt sichtbar stehen');
});

test('der Arm haengt an vier Punkten, und jeder liegt hinter dem vorigen', () => {
  // Fuss, Knick, Bolzen, Zahn: erst hinauf zum Knick, dann hinunter zum Boden.
  assert.ok(ARM.knuckle.y < ARM.foot.y, 'der Ausleger zeigt nicht nach oben');
  assert.ok(ARM.pin.y > ARM.knuckle.y, 'der Stiel zeigt nicht nach unten');
  assert.ok(ARM.tip.x < ARM.pin.x, 'die Schaufel zeigt von der Maschine weg statt zu ihr hin');
  assert.equal(ARM.tip.x, MOUNTAIN.left + 2);
});

/** Alle Zahlen eines Pfades in ihrer Reihenfolge: x, y, x, y, … */
function* cargoNumbers() {
  for (const match of cargoPath().matchAll(/-?\d+(?:\.\d+)?/g)) {
    yield Number(match[0]);
  }
}
