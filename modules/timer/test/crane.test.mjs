import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIG } from '@mirror/sdk';
import {
  FIELD,
  FLAT_SHIFT,
  GROUND,
  HOOK,
  JIB,
  PALLET,
  PYRAMID,
  SWITCH,
  TOWER,
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
      assert.ok(box.left >= 0 && box.right <= PALLET.x - PALLET.width / 2, `${minutes} min: Stein ${index} neben der Pyramide`);
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
      assert.ok(Math.abs(PALLET.x + reach - (box.left + box.right) / 2) < 0.01, `${minutes} min: Stein ${index} daneben`);
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
      const x = PALLET.x + reachFor(plan, index).reach;
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

test('das Ziel wechselt nur, waehrend die Laufkatze ueber der Palette steht', () => {
  /*
   * Im Stylesheet steht die Laufkatze von 26 % bis 56 % einer Ladung ueber der
   * Palette. Genau dort muss `carriedAt` den naechsten Stein nennen — sonst
   * springt sie mitten in der Fahrt an ein anderes Ziel.
   */
  assert.ok(SWITCH > 0.26 && SWITCH < 0.56);
  const plan = pyramidPlan(durationMs(10));
  for (let load = 0; load < 5; load += 1) {
    const early = carriedAt(plan, load * LOAD + 0.2 * LOAD);
    const late = carriedAt(plan, load * LOAD + 0.6 * LOAD);
    assert.equal(late, early + 1);
    // Am Ende der Ladung sitzt genau der Stein, den der Kran getragen hat.
    assert.equal(laidAt(plan, (load + 1) * LOAD), late + 1);
  }
});

test('der ganze Kran passt ins Feld, auch nach rechts gerueckt', () => {
  for (const shift of [0, FLAT_SHIFT]) {
    const box = craneBox(shift);
    assert.ok(box.left >= 0 && box.right <= FIELD.width, `um ${shift} gerueckt ragt er hinaus`);
    assert.ok(box.top >= FIELD.top && box.bottom <= FIELD.top + FIELD.height);
  }
});

test('in den flachen Bloecken bleibt links Platz fuer die Ziffern', () => {
  /*
   * Die Ziffern stehen dort oben links auf der Szene und sind rund ein Drittel
   * des Blocks breit. Die Spitze des Auslegers muss rechts davon liegen.
   */
  assert.ok(craneBox(FLAT_SHIFT).left >= FIELD.width * 0.36);
});
