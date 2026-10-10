import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIG } from '@mirror/sdk';
import {
  AXIS,
  CAB,
  FIELD,
  FLAT_SHIFT,
  GROUND,
  HOOK,
  JIB,
  PALLET,
  PYRAMID,
  SLEW,
  SWITCH,
  TOWER,
  TROLLEY,
  WEIGHT,
  carriedAt,
  craneBox,
  laidAt,
  palletTop,
  pyramidPlan,
  reachFor,
  stoneBox,
  stonesPath,
} from '../dist/crane.js';
import { durationMs, loadCount } from '../dist/shared.js';

/*
 * Ein Kran, der eine Pyramide baut, besteht aus zwei Haelften, die sich nie
 * sehen: das Stylesheet kennt den Ablauf, diese Rechnung kennt den Ort. Ob der
 * Stein dort landet, wo die Pyramide ihn erwartet, sieht man auf dem Spiegel —
 * und dort erst, wenn es zu spaet ist. Deshalb wird es hier gerechnet.
 */

const LOAD = DIG.bucket * DIG.perLoad;
const MINUTES = [1, 3, 5, 10, 25, 60, 120];

/* ------------------------------- Die Steine -------------------------------- */

test('ein Stein je Ladung, und der letzte ist die Spitze', () => {
  for (const minutes of MINUTES) {
    const total = durationMs(minutes);
    const plan = pyramidPlan(total);
    assert.equal(plan.total, (plan.rows * (plan.rows + 1)) / 2, `${minutes} min: keine Pyramide`);
    assert.equal(plan.total - plan.laid, loadCount(total), `${minutes} min: Steine passen nicht zu den Ladungen`);
    // Das vorgelegte Fundament fuellt nie mehr als die unterste Reihe.
    assert.ok(plan.laid < plan.rows, `${minutes} min: ${plan.laid} Steine vorgelegt`);
  }
});

test('laenger heisst mehr Steine', () => {
  let previous = 0;
  for (const minutes of MINUTES) {
    const plan = pyramidPlan(durationMs(minutes));
    assert.ok(plan.total > previous, `${minutes} min baut nicht mehr als die kuerzere Dauer`);
    previous = plan.total;
  }
});

test('die Spitze sitzt genau dann, wenn die Zeit um ist', () => {
  for (const minutes of MINUTES) {
    const total = durationMs(minutes);
    const plan = pyramidPlan(total);
    assert.equal(laidAt(plan, 0), plan.laid);
    assert.equal(laidAt(plan, total - 1), plan.total - 1, `${minutes} min: Spitze zu frueh`);
    assert.equal(laidAt(plan, total), plan.total, `${minutes} min: Spitze zu spaet`);
  }
});

test('jeder Stein liegt auf zweien, und nichts ragt aus dem Feld', () => {
  for (const minutes of MINUTES) {
    const plan = pyramidPlan(durationMs(minutes));
    for (let index = 0; index < plan.total; index += 1) {
      const box = stoneBox(plan, index);
      assert.ok(box.top >= GROUND - PYRAMID.height - 1e-9, `${minutes} min: Stein ${index} zu hoch`);
      assert.ok(box.left >= 0 && box.right <= TOWER.left - 4, `${minutes} min: Stein ${index} neben der Pyramide`);
      if (box.bottom === GROUND) continue;
      const below = [];
      for (let other = 0; other < index; other += 1) {
        const under = stoneBox(plan, other);
        if (Math.abs(under.top - box.bottom) < 1e-9 && under.right > box.left && under.left < box.right) {
          below.push(under);
        }
      }
      assert.equal(below.length, 2, `${minutes} min: Stein ${index} liegt auf ${below.length}`);
    }
  }
});

test('die Pyramide besteht aus Steinen und nicht aus einer Flaeche', () => {
  const plan = pyramidPlan(durationMs(10));
  assert.equal(stonesPath(plan, 0), '');
  assert.equal(stonesPath(plan, 5).match(/M/g).length, 5);
  assert.equal(stonesPath(plan, 999).match(/M/g).length, plan.total);
});

/* -------------------------------- Die Fahrt -------------------------------- */

test('der Kran setzt den Stein genau auf seinen Platz', () => {
  for (const minutes of MINUTES) {
    const plan = pyramidPlan(durationMs(minutes));
    for (let index = 0; index < plan.total; index += 1) {
      const box = stoneBox(plan, index);
      const { reach, drop } = reachFor(plan, index);
      assert.ok(Math.abs(TROLLEY.x + reach - (box.left + box.right) / 2) < 0.01, `${minutes} min: Stein ${index} daneben`);
      assert.ok(Math.abs(HOOK.carry + drop - box.top) < 0.01, `${minutes} min: Stein ${index} in der Luft`);
    }
  }
});

test('die Last geht ueber die Pyramide hinweg und die Laufkatze bleibt am Ausleger', () => {
  for (const minutes of MINUTES) {
    const plan = pyramidPlan(durationMs(minutes));
    // In Fahrthoehe ist die Unterkante der Last hoeher als jede Reihe unter der Spitze.
    const underside = HOOK.carry + plan.stone;
    const belowTop = GROUND - (plan.rows - 1) * plan.stone;
    assert.ok(underside <= belowTop, `${minutes} min: die Last streift die Pyramide`);
    for (let index = 0; index < plan.total; index += 1) {
      const x = TROLLEY.x + reachFor(plan, index).reach;
      assert.ok(x - 3 >= JIB.tip && x + 3 <= TOWER.left, `${minutes} min: Laufkatze faehrt vom Ausleger`);
    }
  }
});

test('an der Palette sitzt der Haken auf dem wartenden Stein', () => {
  for (const minutes of MINUTES) {
    const plan = pyramidPlan(durationMs(minutes));
    const { pick } = reachFor(plan, 0);
    assert.ok(Math.abs(HOOK.carry + pick - palletTop(plan)) < 0.01);
    assert.ok(pick > 0, 'die Palette liegt ueber der Fahrthoehe');
  }
});

test('das Ziel wechselt nur, waehrend der Kran an der Palette steht', () => {
  /*
   * Im Stylesheet haengt die Stellung der Laufkatze und des Hakens am Ziel von
   * 84 % einer Ladung bis 12 % der naechsten (`crane-trolley`, `crane-hook`).
   * Dazwischen steht sie an der Achse, an der Palette oder am Haken der
   * Palette, und genau dort muss `carriedAt` den naechsten Stein nennen —
   * sonst springt sie mitten in der Fahrt an ein anderes Ziel. Und weil die
   * Anzeige auch einmal spaeter tickt, liegt der Wechsel in der Mitte dieser
   * Zeit und nicht an ihrem Rand: mindestens zwei Sekunden Luft nach beiden
   * Seiten.
   */
  assert.ok(SWITCH > 0.12 && SWITCH < 0.84);
  assert.ok((SWITCH - 0.12) * LOAD >= 2000 && (0.84 - SWITCH) * LOAD >= 2000, 'der Wechsel liegt zu dicht am Rand');
  const plan = pyramidPlan(durationMs(10));
  for (let load = 0; load < 5; load += 1) {
    const early = carriedAt(plan, load * LOAD + 0.2 * LOAD);
    const late = carriedAt(plan, load * LOAD + 0.8 * LOAD);
    assert.equal(late, early + 1);
    // Am Ende der Ladung sitzt genau der Stein, den der Kran getragen hat.
    assert.equal(laidAt(plan, (load + 1) * LOAD), late + 1);
  }
});

test('der ganze Kran passt ins Feld, auch nach rechts gerueckt und gedreht', () => {
  for (const shift of [0, FLAT_SHIFT]) {
    const box = craneBox(shift);
    assert.ok(box.left >= 0 && box.right <= FIELD.width, `um ${shift} gerueckt ragt er hinaus`);
    assert.ok(box.top >= FIELD.top && box.bottom <= FIELD.top + FIELD.height);
  }
});

test('in den flachen Bloecken bleibt links Platz fuer die Ziffern', () => {
  /*
   * Die Ziffern stehen dort oben links auf der Szene und sind rund ein Drittel
   * des Blocks breit. Die Spitze des Auslegers muss rechts davon liegen — in
   * jeder Stellung, auch mit dem Gegenausleger nach links.
   */
  assert.ok(craneBox(FLAT_SHIFT).left >= FIELD.width * 0.36);
});

/* ------------------------------- Die Drehung ------------------------------- */

test('die Steine reisen von rechts nach links', () => {
  /*
   * Palette rechts vom Turm, Pyramide links davon — und der Turm dazwischen.
   * Jeder Stein faehrt also von der Palette ueber die Achse zu seinem Platz.
   */
  assert.ok(PALLET.x - PALLET.width / 2 > TOWER.right, 'die Palette steht nicht rechts vom Turm');
  for (const minutes of MINUTES) {
    const plan = pyramidPlan(durationMs(minutes));
    for (let index = 0; index < plan.total; index += 1) {
      const box = stoneBox(plan, index);
      assert.ok(box.right <= TOWER.left, `${minutes} min: Stein ${index} liegt nicht links vom Turm`);
      assert.ok(box.right < PALLET.x, `${minutes} min: Stein ${index} liegt rechts der Palette`);
    }
  }
});

test('die Palette liegt in Reichweite des gedrehten Auslegers', () => {
  /*
   * Gedreht zeigt der Ausleger nach rechts, gespiegelt an der Achse. Die
   * Laufkatze muss dort bis ueber die Palette kommen, ohne vom Ausleger zu
   * fahren, und die Palette darf nicht unter dem Gegenausleger stehen, wenn der
   * Ausleger nach links zeigt.
   */
  const mirror = (x) => 2 * AXIS - x;
  const over = TROLLEY.x + TROLLEY.pallet;
  assert.equal(over, PALLET.x);
  assert.ok(over + 3 <= mirror(JIB.tip), 'die Laufkatze faehrt ueber der Palette vom Ausleger');
  assert.ok(over - 3 >= TOWER.right, 'die Laufkatze steht ueber dem Turm');
});

test('der Ausleger dreht in einem Abstand, in dem Last und Fuehrerhaus aneinander vorbeigehen', () => {
  /*
   * Beim Schwenken steht die Laufkatze `SLEW` von der Achse entfernt, auf der
   * Seite des Auslegers — das Fuehrerhaus sitzt auf derselben Seite, naeher an
   * der Achse. Die Laufkatze (6 breit) muss also ausserhalb davon bleiben, und
   * das Gegengewicht sitzt auf der anderen Seite und stoesst nie an sie.
   */
  assert.equal(TROLLEY.x, AXIS - SLEW);
  assert.equal(TROLLEY.turn, 2 * SLEW);
  assert.ok(SLEW - 3 > AXIS - CAB.left, 'die Laufkatze faehrt ins Fuehrerhaus');
  assert.ok(WEIGHT.left > TOWER.right, 'das Gegengewicht sitzt im Turm');
  // Die Palette ist weiter draussen als die Achse, an der gedreht wird.
  assert.ok(PALLET.x - AXIS > SLEW);
});

test('Anfang und Ende des Zyklus decken sich: die Last bleibt, bis der Stein liegt', () => {
  /*
   * Das Stylesheet haelt die Last von 54 % einer Ladung bis 8 % der naechsten
   * am Haken (`crane-cargo`), die Anzeige setzt den Stein bei 100 % in die
   * Pyramide. Dazwischen steht die Last genau auf ihrem Platz (94 %), und der
   * Spielraum, den ein verspaeteter Takt der Anzeige hat, ist die Zeit von
   * 94 % bis 108 %. Er soll mindestens zwei Sekunden betragen — der Takt der
   * Anzeige ist eine Viertelsekunde, und ein Pi unter Last ist langsamer.
   */
  const styles = readFileSync(new URL('../../../packages/shell/src/renderer/styles.css', import.meta.url), 'utf8');
  const block = styles.match(/@keyframes crane-cargo \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const hidden = block.match(/([\d.]+)%,\s*[\d.]+%\s*\{\s*opacity:\s*0/)?.[1];
  assert.ok(hidden, 'crane-cargo versteckt die Last nirgends');
  const landed = styles.match(/@keyframes crane-hook \{[\s\S]*?(\d+)%,\s*100%\s*\{\s*transform: translateY\(var\(--crane-drop\)\)/)?.[1];
  assert.ok(landed, 'crane-hook setzt nirgends auf');
  const spare = (100 - Number(landed) + Number(hidden)) * LOAD / 100;
  assert.ok(spare >= 2000, `nur ${spare} ms Spielraum zwischen Aufsetzen und Ausblenden der Last`);
});

test('Drehung und Laufkatze laufen im Gleichschritt', () => {
  /*
   * Waehrend der Oberwagen sich dreht, liegt die Laufkatze bei Achse minus
   * Spiegelung mal Abstand. Das stimmt nur, wenn beide dieselben Stuetzstellen
   * und dieselbe Kurve haben: der Oberwagen faengt dort an zu drehen, wo die
   * Laufkatze stehen bleibt, und umgekehrt.
   */
  const styles = readFileSync(new URL('../../../packages/shell/src/renderer/styles.css', import.meta.url), 'utf8');
  const stops = (name) => {
    const body = styles.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    return [...body.matchAll(/([\d.%,\s]+)\{\s*transform:\s*([^;]+);/g)].map((match) => ({
      at: match[1].split(',').map((value) => Number.parseFloat(value)),
      value: match[2].trim(),
    }));
  };
  const slew = stops('crane-slew');
  const trolley = stops('crane-trolley');
  assert.ok(slew.length >= 3 && trolley.length >= 5, 'die Keyframes sind nicht zu lesen');
  // Jede Stelle, an der der Oberwagen die Stellung wechselt, ist auch eine der Laufkatze.
  const trolleyStops = new Set(trolley.flatMap((frame) => frame.at));
  for (const frame of slew) {
    for (const at of frame.at) {
      assert.ok(trolleyStops.has(at), `die Laufkatze hat bei ${at} % keine Stuetzstelle`);
    }
  }
  // Und wo der Oberwagen spiegelt, ist die Laufkatze an der Achse (0) oder auf der anderen Seite.
  const mirrored = slew.filter((frame) => frame.value === 'scaleX(-1)').flatMap((frame) => frame.at);
  const upright = slew.filter((frame) => frame.value === 'scaleX(1)').flatMap((frame) => frame.at);
  const at = (percent) => trolley.find((frame) => frame.at.includes(percent))?.value;
  for (const percent of mirrored) {
    assert.ok(/--crane-(turn|pallet)/.test(at(percent) ?? ''), `bei ${percent} % gespiegelt, die Laufkatze nicht`);
  }
  for (const percent of upright) {
    assert.ok(/--crane-reach|translateX\(0\)/.test(at(percent) ?? ''), `bei ${percent} % aufrecht, die Laufkatze nicht`);
  }
});

test('quer zum Blick steht die Vorderansicht des Oberwagens, nicht nichts', () => {
  /*
   * Gespiegelt hat der Oberwagen genau in der Mitte jedes Schwenks keine Breite.
   * Die Vorderansicht (`crane-edge`) muss dort ihre volle Deckung haben und
   * davor und danach nicht — sonst fehlt dem Kran fuer einen Augenblick der Kopf.
   */
  const styles = readFileSync(new URL('../../../packages/shell/src/renderer/styles.css', import.meta.url), 'utf8');
  const body = styles.match(/@keyframes crane-edge \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const frames = [...body.matchAll(/([\d.%,\s]+)\{\s*opacity:\s*([\d.]+);/g)].map((match) => ({
    at: match[1].split(',').map((value) => Number.parseFloat(value)),
    opacity: Number(match[2]),
  }));
  const peaks = frames.filter((frame) => frame.opacity === 1).flatMap((frame) => frame.at);
  const slew = styles.match(/@keyframes crane-slew \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const stops = [...slew.matchAll(/([\d.%,\s]+)\{\s*transform:\s*scaleX\((-?1)\)/g)].map((match) => ({
    at: match[1].split(',').map((value) => Number.parseFloat(value)),
    side: Number(match[2]),
  }));
  // Jeder Schwenk geht von einer Stellung zur naechsten: von der letzten Stuetzstelle der einen zur ersten der naechsten.
  const middles = [];
  for (let index = 0; index + 1 < stops.length; index += 1) {
    middles.push((Math.max(...stops[index].at) + Math.min(...stops[index + 1].at)) / 2);
  }
  assert.deepEqual(peaks, middles, 'die Vorderansicht steht nicht in der Mitte der Schwenks');
});
