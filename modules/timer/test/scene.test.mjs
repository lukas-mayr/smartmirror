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
  benchAt,
  cargoPath,
  knuckleAt,
  mountainArea,
  mountainBox,
  mountainPath,
  pinAt,
  siteShift,
  surfaceAt,
  tauForShare,
  toothAt,
} from '../dist/scene.js';
import { mountainSize } from '../dist/shared.js';

/*
 * Eine Baustelle besteht aus Dingen, die unabhaengig voneinander entstanden
 * sind und trotzdem zusammenpassen muessen: ein Berg, der abgetragen wird, ein
 * Arm, der sich dreht, eine Maschine, die der Wand nachfaehrt, und ein Wagen,
 * der zur richtigen Zeit darunter steht. Ob das zusammengeht, sieht man auf dem
 * Spiegel — und dort erst, wenn es zu spaet ist. Deshalb wird es hier
 * gerechnet.
 *
 * Geprueft wird nicht die Zeichnung, sondern was sie behauptet.
 */

const POSES = Object.entries(POSE);

/* ---------------------------- Wie der Berg faellt -------------------------- */

test('jeder Eimer nimmt gleich viel Berg weg', () => {
  /*
   * Der Kern der ganzen Rechnung. Gleich viel heisst gleich viel *Flaeche* —
   * nicht gleich viel Hoehe und nicht gleich viel Breite. Waere es anders,
   * bliebe am Ende ein Rest stehen oder der Berg waere zu frueh weg, und in
   * beiden Faellen erzaehlte die Anzeige etwas anderes als die Uhr.
   */
  const full = mountainArea(1, 0);
  for (let share = 1; share >= 0; share -= 0.05) {
    const left = mountainArea(1, tauForShare(share)) / full;
    assert.ok(
      Math.abs(left - share) < 0.01,
      `bei ${share.toFixed(2)} stehen ${left.toFixed(3)} statt ${share.toFixed(2)}`,
    );
  }
});

test('der Anteil gilt fuer jede Berggroesse gleich', () => {
  // Hoehe und Breite skalieren gemeinsam, die Flaeche also mit dem Quadrat —
  // der Anteil bleibt derselbe. Sonst braeuchte ein kurzer Timer eine eigene
  // Tabelle.
  for (const size of [DIG.minSize, 0.5, 1]) {
    const full = mountainArea(size, 0);
    const half = mountainArea(size, tauForShare(0.5));
    assert.ok(Math.abs(half / full - 0.5) < 0.01, `bei Groesse ${size}: ${(half / full).toFixed(3)}`);
  }
});

test('abgebaut wird von der Seite: Kante wandert, Sohle sinkt', () => {
  const start = benchAt(1, 0);
  const middle = benchAt(1, tauForShare(0.5));
  const end = benchAt(1, tauForShare(0.02));
  assert.ok(middle.cut > start.cut, 'die Abbaukante wandert nicht');
  assert.ok(end.cut > middle.cut, 'die Abbaukante bleibt stehen');
  assert.ok(middle.crest < start.crest, 'die Sohle sinkt nicht');
  assert.ok(end.crest < middle.crest, 'die Sohle bleibt stehen');
});

test('am Anfang steht der Berg unberuehrt da', () => {
  /*
   * Die Kante beginnt links vom Fuss — weit genug, dass sie den Haufen
   * nirgends anschneidet. Sonst faehrt der Bagger den ersten Eimer in einen
   * Berg, der schon abgetragen aussieht.
   */
  const bench = benchAt(1, 0);
  assert.ok(bench.cut < MOUNTAIN.left, 'die Kante steht schon im Berg');
  for (let index = 0; index <= 40; index += 1) {
    const u = index / 40;
    const x = bench.left + u * bench.width;
    const profile = profileHeight(u) * bench.height;
    assert.ok(
      Math.abs(surfaceAt(bench, x) - profile) < 0.01,
      `bei u=${u.toFixed(2)} ist der Berg schon angeschnitten`,
    );
  }
});

test('die Sohle ist flach und die Kante gerade', () => {
  // Genau daran erkennt man eine Grube: eine waagerechte Sohle und eine
  // gerade Boeschung. Ein Haufen, der nur kleiner wird, hat beides nicht.
  const bench = benchAt(1, tauForShare(0.5));
  const onCrest = [];
  for (let x = bench.cut; x < bench.left + bench.width; x += 0.5) {
    const height = surfaceAt(bench, x);
    if (Math.abs(height - bench.crest) < 0.01) onCrest.push(x);
  }
  assert.ok(onCrest.length > 10, 'es gibt keine erkennbare Sohle');

  // Auf der Kante steigt die Flaeche mit fester Neigung.
  const a = surfaceAt(bench, bench.cut + 2);
  const b = surfaceAt(bench, bench.cut + 4);
  assert.ok(Math.abs(b - a - (a - 0)) < 0.05, 'die Kante ist nicht gerade');
});

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
});

test('der groesste Berg passt vollstaendig ins Feld', () => {
  const box = mountainBox(1, 1);
  assert.ok(box.right <= FIELD.width - 2, `der Berg reicht bis ${box.right}`);
  assert.ok(box.top >= FIELD.top + 2, `der Gipfel steht bei ${box.top}`);
  assert.equal(box.bottom, GROUND);
});

test('ein langer Timer beginnt mit einem hoeheren Berg als ein kurzer', () => {
  const short = mountainBox(mountainSize(10 * 60_000), 1);
  const long = mountainBox(mountainSize(60 * 60_000), 1);
  assert.ok(long.top < short.top, 'der laengere Timer bekommt keinen hoeheren Berg');
  assert.ok(long.right > short.right, 'der laengere Timer bekommt keinen breiteren Berg');
  assert.ok(long.right <= FIELD.width - 2, 'der lange Berg laeuft aus dem Feld');
});

/* -------------------- Faehrt der Bagger der Wand nach? --------------------- */

test('der Bagger steht still, solange die Kante den Berg nicht anschneidet', () => {
  assert.equal(siteShift(1, 1), 0);
});

test('der Bagger faehrt der Abbaukante nach', () => {
  let previous = -1;
  for (let share = 1; share >= 0; share -= 0.1) {
    const shift = siteShift(1, share);
    assert.ok(shift >= previous, `bei ${share.toFixed(1)} faehrt er zurueck`);
    previous = shift;
  }
  assert.ok(previous > 20, `am Ende ist er nur ${previous.toFixed(1)} weit gekommen`);
});

test('der Zahn greift in die Wand, egal wie weit der Abbau ist', () => {
  /*
   * Die Zeichnung faehrt als Ganzes mit dem Vorschub, der Zahn also auch. Er
   * muss dabei immer knapp hinter der Zehe der Kante stehen — dort wird
   * gegraben. Faende der Zug woanders statt, schaufelte der Bagger sichtbar in
   * die Luft.
   */
  const tooth = toothAt(POSE.reach).x;
  for (const size of [DIG.minSize, 0.5, 1]) {
    for (let share = 1; share >= 0.05; share -= 0.05) {
      const bench = benchAt(size, tauForShare(share));
      const toe = Math.max(bench.left, bench.cut);
      const reach = tooth + siteShift(size, share);
      assert.ok(
        reach >= toe - 0.5 && reach <= toe + 4,
        `Groesse ${size}, Rest ${share.toFixed(2)}: Zahn bei ${reach.toFixed(1)}, Wand bei ${toe.toFixed(1)}`,
      );
    }
  }
});

test('auch ganz vorgerueckt bleibt die Baustelle im Feld', () => {
  const shift = siteShift(1, 0);
  for (const [name, pose] of POSES) {
    for (const slewed of [false, true]) {
      for (const [part, point] of [
        ['Knick', knuckleAt(pose, slewed)],
        ['Bolzen', pinAt(pose, slewed)],
        ['Zahn', toothAt(pose, slewed)],
      ]) {
        assert.ok(
          point.x + shift <= FIELD.width - 2,
          `${name}/${part} steht vorgerueckt bei ${(point.x + shift).toFixed(1)}`,
        );
        assert.ok(point.x >= 2, `${name}/${part} steht links ueber der Kante: ${point.x.toFixed(1)}`);
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
  assert.ok(TRACK.right + shift < FIELD.width, 'die Raupe faehrt aus dem Feld');
  assert.ok(TRUCK.bed.right + shift < FIELD.width, 'die Mulde faehrt aus dem Feld');
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
  // Und ueber der Stirnwand, die hoeher steht als die Seitenwand.
  assert.ok(tooth.y < TRUCK.headboard, 'die Schaufel streift die Stirnwand');
});

test('der Schwenk endet neben der Maschine und nicht ueber ihr', () => {
  const raised = toothAt(POSE.raised, true);
  assert.ok(raised.x < TRACK.left, `die gehobene Schaufel steht bei x=${raised.x.toFixed(1)}`);
  assert.ok(raised.y < TRUCK.rim, 'die gehobene Schaufel haengt unterhalb der Bordwand');
  assert.ok(toothAt(POSE.tipped, true).x < raised.x, 'sie kippt zurueck statt weiter');
});

test('der Wagen faehrt erst los, wenn die Schaufel leer ist', () => {
  /*
   * Der Fehler, den man sofort sieht: der Wagen zieht an, waehrend die letzte
   * Ladung noch faellt, und sie landet daneben. Der letzte Eimer einer Ladung
   * ist der `perLoad`-te; sein Kippen endet bei `dump.to` seiner eigenen Dauer.
   */
  const lastDumpEnds = (DIG.perLoad - 1 + DIG.dump.to) / DIG.perLoad;
  assert.ok(
    DIG.swap.leave > lastDumpEnds,
    `der Wagen faehrt bei ${DIG.swap.leave}, das Kippen endet erst bei ${lastDumpEnds.toFixed(3)}`,
  );

  // Und der naechste steht, bevor der erste Eimer der neuen Ladung kippt.
  const firstDumpStarts = DIG.dump.from / DIG.perLoad;
  assert.ok(
    DIG.swap.ready < firstDumpStarts,
    `der neue Wagen steht erst bei ${DIG.swap.ready}, gekippt wird schon bei ${firstDumpStarts.toFixed(3)}`,
  );
});

test('der volle Wagen faehrt weit genug, um aus dem Bild zu sein', () => {
  assert.ok(
    TRUCK.exit + TRUCK.bed.right + siteShift(1, 0) < 0,
    'ein Stueck des Wagens bleibt sichtbar stehen',
  );
});

test('die Ladung sitzt auf der Bordwand und nicht in der Mulde', () => {
  /*
   * Von der Seite schaut niemand in einen Kipper hinein: sichtbar ist eine
   * Ladung erst, wenn sie oben ueber steht. Ihre Grundlinie *ist* deshalb die
   * Bordwand — kein Punkt darf darunter liegen.
   */
  const numbers = [...cargoPath().matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  assert.ok(Math.max(...ys) <= TRUCK.rim, 'die Ladung reicht in die Mulde hinein');
  assert.ok(Math.min(...ys) < TRUCK.rim, 'die Ladung steht nicht ueber der Bordwand');
  assert.ok(Math.min(...xs) >= TRUCK.bed.left, 'die Ladung haengt links ueber der Bordwand');
  assert.ok(Math.max(...xs) <= TRUCK.bed.right, 'die Ladung haengt rechts ueber der Bordwand');
});

/* -------------------------------- Der Aufbau ------------------------------- */

test('die Spiegelung ist die Drehung: was rechts der Achse liegt, liegt danach links davon', () => {
  const tooth = toothAt(POSE.raised);
  const turned = toothAt(POSE.raised, true);
  assert.ok(Math.abs(tooth.x - SLEW_X - (SLEW_X - turned.x)) < 1e-9);
  assert.equal(tooth.y, turned.y);
});

test('der Bagger steht links vom Berg und der Wagen links vom Bagger', () => {
  // Die Leserichtung der Szene: Material wandert vom Berg ueber den Bagger auf
  // den Wagen und faehrt nach links davon.
  assert.ok(TRUCK.bed.right < TRACK.left, 'die Mulde steht unter der Raupe');
  assert.ok(TRACK.right < MOUNTAIN.left, 'die Raupe steht im Berg');
  assert.equal(SLEW_X, (TRACK.left + TRACK.right) / 2, 'die Drehachse liegt nicht mittig auf der Raupe');
});

test('die eingezogene Schaufel steht neben der Raupe und nicht darauf', () => {
  // Eine Schaufel, die durch das eigene Fahrwerk faehrt, faellt sofort auf.
  assert.ok(toothAt(POSE.full).x > TRACK.right, 'die Schaufel landet auf der Raupe');
});

test('der Zahn kommt beim Graben auf dem Boden an', () => {
  const cut = toothAt(POSE.cut);
  assert.ok(cut.y > GROUND - 4, `der Zahn bleibt ${(GROUND - cut.y).toFixed(1)} ueber dem Boden`);
  assert.ok(cut.y <= GROUND, 'der Zahn faehrt unter den Boden');
});

test('der Arm haengt an vier Punkten, und jeder liegt hinter dem vorigen', () => {
  assert.ok(ARM.knuckle.y < ARM.foot.y, 'der Ausleger zeigt nicht nach oben');
  assert.ok(ARM.pin.y > ARM.knuckle.y, 'der Stiel zeigt nicht nach unten');
  assert.ok(ARM.tip.x < ARM.pin.x, 'die Schaufel zeigt von der Maschine weg statt zu ihr hin');
  assert.equal(ARM.tip.x, MOUNTAIN.left + 2);
});

test('die linke Flanke steht steiler als die rechte', () => {
  // An ihr wird gegraben; die rechte laeuft aus. Ein symmetrischer Kegel waere
  // ein Dach und kein Berg.
  const peak = PROFILE.reduce((best, point) => (point.y > best.y ? point : best));
  assert.equal(peak.y, 1);
  assert.ok(peak.x < 0.5, `der Gipfel steht bei ${peak.x}`);
});

/** Das Profil, wie scene.ts es liest — hier noch einmal, um es zu pruefen. */
function profileHeight(u) {
  if (u <= 0 || u >= 1) return 0;
  let previous = PROFILE[0];
  for (const point of PROFILE.slice(1)) {
    if (u <= point.x) {
      const span = point.x - previous.x;
      return previous.y + (point.y - previous.y) * (span === 0 ? 0 : (u - previous.x) / span);
    }
    previous = point;
  }
  return 0;
}
