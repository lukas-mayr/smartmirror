/**
 * Die Pyramide, als Geometrie.
 *
 * Das dritte Motiv des Timers: ein Turmdrehkran stapelt viereckige Steine zu
 * einer Pyramide. Was hier steht, ist die Rechnung dazu — wie gross die
 * Pyramide wird, wo jeder Stein hinkommt und wie weit der Kran dafuer fahren
 * muss. Gezeichnet wird in frontend.ts, bewegt wird im Stylesheet; derselbe
 * Schnitt wie bei Baustelle und Wiese, und aus demselben Grund: die Rechnung
 * braucht keinen Browser, und nur so laesst sie sich pruefen.
 *
 * Die Regel des Moduls gilt unveraendert: **gearbeitet wird immer gleich
 * schnell.** Ein Stein dauert eine Ladung (`DIG.bucket * DIG.perLoad`), ob der
 * Timer auf drei Minuten oder auf zwei Stunden steht. Was sich mit der Dauer
 * aendert, ist die Pyramide: ein langer Timer hat mehr Steine.
 *
 * Und das Bild antwortet andersherum als die beiden anderen. Berg und Wiese
 * werden kleiner, die Pyramide waechst — was steht, ist die vergangene Zeit,
 * und die Restzeit ist das, was bis zur Spitze noch fehlt. Ein Umriss der
 * fertigen Pyramide steht mit Absicht nicht da: das Bild zeigt, was gebaut
 * ist, und nicht einen Plan davon. Die genaue Restzeit sagen die Ziffern.
 *
 * Drei Dinge muessen dabei zusammenpassen:
 *
 *  1. Jeder Stein landet genau auf seinem Platz. Der Kran rechnet nicht mit,
 *     er faehrt dorthin, wohin ihn diese Datei schickt — und dort setzt die
 *     Anzeige den Stein im selben Moment in die Pyramide.
 *  2. Der letzte Stein, die Spitze, sitzt genau dann, wenn die Zeit um ist.
 *     Nicht eine Ladung frueher und nicht eine spaeter.
 *  3. Was der Kran traegt, stoesst nirgends an: nicht an die Pyramide, nicht
 *     an den Turm und nicht oben aus dem Bild.
 *
 * Alle Masse in Feldeinheiten des `viewBox`, der Grund bei `GROUND`.
 */

import { DIG } from '@mirror/sdk';
import { FIELD, GROUND, round, type Box, type Point } from './field.js';
import { loadCount } from './shared.js';

export { FIELD, GROUND };
export type { Box, Point };

/* -------------------------------- Der Kran --------------------------------- */

/**
 * Der Turm.
 *
 * Rechts im Bild und nicht links: in den flachen Bloecken stehen die Ziffern
 * oben links, und ein Turm, der hinter ihnen hochragt, waere das Einzige, was
 * man von ihm sieht. Rechts steht er frei, und der Ausleger reicht nach links
 * ueber die Pyramide.
 */
export const TOWER = { left: 146, right: 153, apex: 11 } as const;

/**
 * Der Ausleger, auf dem die Laufkatze faehrt, und der Gegenausleger dahinter.
 *
 * Hoch genug, dass die Last ueber die fertige Pyramide hinweggeht; tief genug,
 * dass die Turmspitze darueber noch ins Feld passt.
 */
export const JIB = { tip: 46, top: 18, bottom: 22, tail: 178 } as const;

/** Das Gegengewicht am Ende des Gegenauslegers. */
export const WEIGHT = { left: 167, right: 177, top: 21, bottom: 29 } as const;

/** Das Fuehrerhaus, am Fuss des Auslegers. */
export const CAB = { left: 139, right: 146, top: 22, bottom: 28.5 } as const;

/**
 * Die Palette, von der die Steine kommen.
 *
 * Zwischen Pyramide und Turm: so faehrt die Laufkatze nie ueber den Turm
 * hinaus, und der Weg zur Pyramide ist der kuerzeste. `x` ist die Mitte, und
 * genau dort steht die Laufkatze, wenn sie nicht faehrt.
 */
export const PALLET = { x: 128, width: 14, height: 2 } as const;

/**
 * Laufkatze und Haken, in Ruhestellung ueber der Palette.
 *
 * `rope` ist das Ende der Laufkatze, an dem das Seil haengt, `block` der
 * Hakenblock, `carry` die Oberkante der Last. In dieser Hoehe faehrt die Last —
 * und das ist die Hoehe, die ueber die Pyramide hinweg muss.
 */
export const HOOK = { rope: 24.5, block: 27, carry: 31.5 } as const;

/* ------------------------------ Die Pyramide ------------------------------- */

/**
 * Die Pyramide in ihrer groessten Ausdehnung.
 *
 * `center` ist ihre Mitte auf dem Grund. `height` die groesste Hoehe, die sie
 * erreichen darf: darueber faehrt die Last. `stone` die groesste Kantenlaenge
 * eines Steins — bis zu ihr bleiben die Steine gleich gross und die Pyramide
 * waechst; darueber werden sie kleiner, damit sie ins Bild passt.
 */
export const PYRAMID = { center: 80, height: 44, stone: 6 } as const;

/**
 * Die Pyramide eines Timers: wieviele Reihen, wie gross ein Stein, und wieviele
 * Steine schon liegen, bevor der Kran anfaengt.
 *
 * Eine Pyramide aus Reihen, in denen je ein Stein weniger liegt als darunter,
 * hat eine Dreieckszahl von Steinen — die Zahl der Ladungen ist aber selten
 * eine. Deshalb bekommt sie so viele Reihen, dass alle Ladungen Platz haben,
 * und was dann noch fehlt, liegt am Anfang schon da: ein paar Steine des
 * Fundaments. So setzt der Kran genau einen Stein je Ladung, und der letzte ist
 * die Spitze.
 */
export interface Plan {
  /** Zahl der Reihen, und damit die Zahl der Steine in der untersten. */
  rows: number;
  /** Kantenlaenge eines Steins. */
  stone: number;
  /** Steine, die schon liegen, bevor die Zeit laeuft. */
  laid: number;
  /** Steine insgesamt. */
  total: number;
}

export function pyramidPlan(totalMs: number): Plan {
  const loads = loadCount(totalMs);
  let rows = 1;
  while ((rows * (rows + 1)) / 2 < loads) rows += 1;
  const total = (rows * (rows + 1)) / 2;
  return {
    rows,
    stone: Math.min(PYRAMID.stone, PYRAMID.height / rows),
    laid: total - loads,
    total,
  };
}

/**
 * Wo der k-te Stein liegt, in der Reihenfolge, in der er gesetzt wird.
 *
 * Reihe um Reihe von unten, in jeder Reihe von links nach rechts — also vom
 * Kran weg zu ihm hin. Jede Reihe ist um einen halben Stein eingerueckt, so
 * dass jeder Stein auf zweien liegt.
 */
export function stoneBox(plan: Plan, index: number): Box {
  let row = 0;
  let rest = Math.max(0, Math.min(plan.total - 1, index));
  while (rest >= plan.rows - row) {
    rest -= plan.rows - row;
    row += 1;
  }
  const left = PYRAMID.center - ((plan.rows - row) * plan.stone) / 2 + rest * plan.stone;
  const bottom = GROUND - row * plan.stone;
  return { left, top: bottom - plan.stone, right: left + plan.stone, bottom };
}

/**
 * Wieviele Steine liegen, nach so viel Zeit.
 *
 * Ein Stein je Ladung, und zwar am *Ende* der Ladung: dort setzt ihn der Kran
 * ab. Nach der letzten Ladung liegen alle — genau dann, wenn die Zeit um ist.
 */
export function laidAt(plan: Plan, elapsedMs: number): number {
  const loadMs = DIG.bucket * DIG.perLoad;
  const done = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs / loadMs) : 0;
  return Math.min(plan.total, plan.laid + done);
}

/**
 * Die Umrandung eines Steins, etwas eingerueckt.
 *
 * Die Fuge ist der Grund, warum man Steine sieht und keine Treppe: ohne sie
 * verschmelzen die Umrisse zu einer einzigen Flaeche.
 */
function stoneRect(box: Box, stone: number): string {
  const inset = stone * 0.07;
  const size = round(stone - 2 * inset);
  return `M${round(box.left + inset)} ${round(box.top + inset)}h${size}v${size}h${-size}Z`;
}

/** Die gesetzten Steine als ein Pfad, oder eine leere Zeichenkette. */
export function stonesPath(plan: Plan, laid: number): string {
  const parts: string[] = [];
  for (let index = 0; index < Math.min(laid, plan.total); index += 1) {
    parts.push(stoneRect(stoneBox(plan, index), plan.stone));
  }
  return parts.join('');
}

/* ------------------------------- Die Fahrt --------------------------------- */

/**
 * Wie weit der Kran fahren muss, um einen Stein zu setzen.
 *
 * `reach` ist der Weg der Laufkatze von der Palette zur Mitte des Platzes
 * (negativ: nach links), `drop` der Weg der Last nach unten, bis sie aufsitzt.
 * `pick` ist derselbe Weg an der Palette. Die beiden `…Scale` sagen, wie lang
 * das Seil dabei wird, als Vielfaches seiner Ruhelaenge.
 *
 * Alle fuenf Zahlen gehen als Variablen ins Stylesheet: die Keyframes kennen
 * den Ablauf, diese Zahlen kennen den Ort.
 */
export interface Reach {
  reach: number;
  drop: number;
  pick: number;
  dropScale: number;
  pickScale: number;
}

/** Die Oberkante des Steins, der auf der Palette wartet. */
export function palletTop(plan: Plan): number {
  return GROUND - PALLET.height - 2 * plan.stone;
}

export function reachFor(plan: Plan, index: number): Reach {
  const rope = HOOK.block - HOOK.rope;
  const pick = palletTop(plan) - HOOK.carry;
  if (index < 0) {
    // Vor dem ersten Stein gibt es keinen Platz, von dem der Kran kommt: er
    // steht ueber der Palette.
    return { reach: 0, drop: pick, pick, dropScale: (rope + pick) / rope, pickScale: (rope + pick) / rope };
  }
  const box = stoneBox(plan, index);
  const drop = box.top - HOOK.carry;
  return {
    reach: round((box.left + box.right) / 2 - PALLET.x),
    drop: round(drop),
    pick: round(pick),
    dropScale: round((rope + drop) / rope),
    pickScale: round((rope + pick) / rope),
  };
}

/**
 * Welchen Stein der Kran gerade bewegt, nach so viel Zeit — oder -1.
 *
 * Eine Ladung, in Prozent ihrer Dauer (so steht sie auch im Stylesheet):
 *
 *    0 – 4    absetzen: der Stein von eben sitzt, der Haken liegt noch auf
 *    4 – 12   leeren Haken hochziehen
 *   12 – 26   zurueck zur Palette
 *   26 – 36   absenken
 *   36 – 44   anschlagen
 *   44 – 56   hochziehen
 *   56 – 80   hinueber zur Pyramide
 *   80 – 86   auspendeln
 *   86 – 98   absenken; bei 98 sitzt der Stein, bei 100 gehoert er dazu
 *
 * Bis 26 % arbeitet der Kran also noch am Stein der vorigen Ladung, ab dort am
 * naechsten. Der Wechsel faellt in die Zeit, in der die Laufkatze ueber der
 * Palette steht (`SWITCH`) — dort haengt ihre Stellung an keinem Ziel, und der
 * neue Weg setzt ohne Sprung ein.
 */
export const SWITCH = 0.4;

export function carriedAt(plan: Plan, elapsedMs: number): number {
  const loadMs = DIG.bucket * DIG.perLoad;
  const time = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const cycle = Math.floor(time / loadMs - SWITCH);
  return Math.min(plan.total - 1, plan.laid + cycle);
}

/**
 * Wie weit die ganze Szene in den flachen Bloecken nach rechts rueckt.
 *
 * Dort stehen die Ziffern *auf* der Szene, oben links — und genau dort laege
 * sonst die Spitze des Auslegers. Der quadratische Block hat die Ziffern
 * darueber und behaelt die Mitte; in den flachen rueckt der Kran so weit nach
 * rechts, wie das Feld es zulaesst, und links bleibt Himmel fuer die Zeit.
 * Kran, Palette und Pyramide ruecken zusammen: es ist *ein* Ort.
 */
export const FLAT_SHIFT = 38;

/**
 * Die ganze Szene in ihrer groessten Ausdehnung, um `shift` verschoben — fuer
 * den Test, dass sie ins Feld passt.
 */
export function craneBox(shift = 0): Box {
  return { left: JIB.tip + shift, top: TOWER.apex, right: JIB.tail + shift, bottom: GROUND };
}
