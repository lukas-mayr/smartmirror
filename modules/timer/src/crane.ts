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
 * **Der Kran dreht sich.** Die Pyramide steht links vom Turm, die Palette mit
 * den Steinen rechts davon — und der Oberwagen (Ausleger, Gegenausleger,
 * Fuehrerhaus, Turmspitze) schwenkt auf dem Turm von der einen zur anderen. Die
 * Steine reisen also von rechts nach links. Im Seitenriss ist eine halbe
 * Umdrehung eine Spiegelung durch die Senkrechte; dazwischen steht der Ausleger
 * quer zum Blick und wird schmal.
 *
 * Vier Dinge muessen dabei zusammenpassen:
 *
 *  1. Jeder Stein landet genau auf seinem Platz. Der Kran rechnet nicht mit,
 *     er faehrt dorthin, wohin ihn diese Datei schickt — und dort setzt die
 *     Anzeige den Stein im selben Moment in die Pyramide.
 *  2. Der letzte Stein, die Spitze, sitzt genau dann, wenn die Zeit um ist.
 *     Nicht eine Ladung frueher und nicht eine spaeter.
 *  3. Was der Kran traegt, stoesst nirgends an: nicht an die Pyramide, nicht
 *     an den Turm und nicht oben aus dem Bild — auch nicht, wenn der Ausleger
 *     nach rechts zeigt und das Bild dort endet.
 *  4. Ein Stein verschwindet nie. Er wechselt zwischen Palette, Haken und
 *     Pyramide immer so, dass er in dem Moment an beiden Orten steht
 *     (`SWITCH`, und die Zeiten im Stylesheet).
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
 * Die Achse des Turms — die Senkrechte, um die sich der Oberwagen dreht.
 *
 * Sie steht zwischen Pyramide und Palette: links die Pyramide, rechts die
 * Palette. Der Ausleger zeigt einmal nach links und einmal nach rechts, und
 * alles, was er traegt, faehrt dabei ueber die Achse. Gezeichnet ist der Kran
 * mit dem Ausleger nach links (zur Pyramide); die andere Stellung ist dessen
 * Spiegelbild an dieser Senkrechten.
 */
export const AXIS = 112;

/** Der Turm. Er dreht sich nicht mit. */
export const TOWER = { left: AXIS - 3.5, right: AXIS + 3.5, apex: 11 } as const;

/**
 * Der Ausleger, auf dem die Laufkatze faehrt, und der Gegenausleger dahinter.
 *
 * Lang genug, dass die Last bis zum aeussersten Stein der untersten Reihe
 * reicht — auch bei der groessten Pyramide, deren Steine am kleinsten sind und
 * am weitesten aussen liegen. Hoch genug, dass sie ueber die fertige Pyramide
 * hinweggeht; tief genug, dass die Turmspitze darueber noch ins Feld passt.
 *
 * Gedreht zeigt der Ausleger nach rechts und der Gegenausleger nach links: die
 * Szene braucht deshalb auf beiden Seiten der Achse Platz, und zwar `tip` weit
 * (siehe `craneBox`).
 */
export const JIB = { tip: AXIS - 62, top: 18, bottom: 22, tail: AXIS + 30 } as const;

/** Das Gegengewicht am Ende des Gegenauslegers. Es dreht sich mit. */
export const WEIGHT = { left: AXIS + 19, right: AXIS + 29, top: 21, bottom: 29 } as const;

/** Das Fuehrerhaus, am Fuss des Auslegers. Es dreht sich mit. */
export const CAB = { left: AXIS - 10.5, right: AXIS - 3.5, top: 22, bottom: 28.5 } as const;

/**
 * Die Palette, von der die Steine kommen.
 *
 * Rechts vom Turm, wo sonst nichts steht: der Ausleger dreht sich zu ihr hin,
 * und die Steine reisen von dort ueber den Turm hinweg nach links zur Pyramide.
 * `x` ist die Mitte, und genau dort steht die Laufkatze beim Anschlagen.
 */
export const PALLET = { x: AXIS + 30, width: 14, height: 2 } as const;

/**
 * Laufkatze und Haken.
 *
 * `rope` ist das Ende der Laufkatze, an dem das Seil haengt, `block` der
 * Hakenblock, `carry` die Oberkante der Last. In dieser Hoehe faehrt die Last —
 * und das ist die Hoehe, die ueber die Pyramide hinweg muss.
 */
export const HOOK = { rope: 24.5, block: 27, carry: 31.5 } as const;

/**
 * Wo die Laufkatze dreht.
 *
 * Gedreht wird nur bei kurzem Ausleger: die Laufkatze faehrt erst bis `SLEW` an
 * die Achse heran, dann schwenkt der Oberwagen, dann faehrt sie wieder hinaus.
 * Das ist keine Vorsicht, sondern Rechnung: waehrend der Ausleger sich dreht,
 * liegt die Laufkatze bei `Achse - SLEW * Spiegelung`, und diese Spiegelung ist
 * dieselbe Zahl, mit der das Stylesheet den Oberwagen skaliert. Ein Kran, der
 * gleichzeitig dreht und faehrt, braeuchte das Produkt zweier Bewegungen — und
 * das kann ein Keyframe nicht.
 *
 * Der Abstand ist so gross, dass die Last am Haken dabei am Fuehrerhaus und am
 * Turm vorbeigeht und so klein, dass die Palette dahinter noch Platz hat.
 */
export const SLEW = 16;

/**
 * Die Laufkatze, wie sie gezeichnet ist: auf dem Ausleger nach links, `SLEW` von
 * der Achse entfernt. Von hier aus sind alle Wege gerechnet.
 *
 * `turn` ist der Weg nach rechts, auf die andere Seite der Achse (die Spiegelung
 * derselben Stelle), `pallet` der Weg bis ueber die Palette.
 */
export const TROLLEY = {
  x: AXIS - SLEW,
  turn: 2 * SLEW,
  pallet: PALLET.x - (AXIS - SLEW),
} as const;

/* ------------------------------ Die Pyramide ------------------------------- */

/**
 * Die Pyramide in ihrer groessten Ausdehnung.
 *
 * `center` ist ihre Mitte auf dem Grund. `height` die groesste Hoehe, die sie
 * erreichen darf: darueber faehrt die Last. `stone` die groesste Kantenlaenge
 * eines Steins — bis zu ihr bleiben die Steine gleich gross und die Pyramide
 * waechst; darueber werden sie kleiner, damit sie ins Bild passt.
 *
 * Links vom Turm, mit einer Handbreit Luft zu seinem Fundament.
 */
export const PYRAMID = { center: AXIS - 34, height: 44, stone: 6 } as const;

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
 * aeusseren Ende des Auslegers zum Turm hin. Jede Reihe ist um einen halben
 * Stein eingerueckt, so dass jeder Stein auf zweien liegt.
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
 * `reach` ist der Weg der Laufkatze von ihrer Zeichenstellung (`TROLLEY.x`) zur
 * Mitte des Platzes (negativ: nach links), `drop` der Weg der Last nach unten,
 * bis sie aufsitzt. `pick` ist derselbe Weg an der Palette. Die beiden
 * `…Scale` sagen, wie lang das Seil dabei wird, als Vielfaches seiner
 * Ruhelaenge.
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
  const pickScale = round((rope + pick) / rope);
  if (index < 0) {
    // Vor dem ersten Stein gibt es keinen Platz, von dem der Kran kommt: er
    // steht an der Stelle, an der er dreht, den Haken oben.
    return { reach: 0, drop: 0, pick: round(pick), dropScale: 1, pickScale };
  }
  const box = stoneBox(plan, index);
  const drop = box.top - HOOK.carry;
  return {
    reach: round((box.left + box.right) / 2 - TROLLEY.x),
    drop: round(drop),
    pick: round(pick),
    dropScale: round((rope + drop) / rope),
    pickScale,
  };
}

/**
 * Welchen Stein der Kran gerade bewegt, nach so viel Zeit — oder -1.
 *
 * Eine Ladung, in Prozent ihrer Dauer (so steht sie auch im Stylesheet):
 *
 *    0 –  8   absetzen: der Stein von eben sitzt, der Haken liegt noch auf
 *    8 – 16   leeren Haken hochziehen
 *   12 – 26   an die Achse heranfahren
 *   26 – 40   schwenken: der Ausleger dreht sich zur Palette
 *   40 – 48   hinaus bis ueber die Palette
 *   46 – 54   absenken
 *   54 – 59   anschlagen
 *   59 – 67   hochziehen
 *   66 – 72   an die Achse heranfahren
 *   72 – 84   schwenken: zurueck zur Pyramide
 *   84 – 91   hinaus bis ueber den Platz
 *   87 – 94   absenken; bei 94 sitzt der Stein, bei 100 gehoert er dazu
 *
 * Bis 50 % arbeitet der Kran also noch am Stein der vorigen Ladung, ab dort am
 * naechsten. Der Wechsel faellt in die Zeit, in der er an der Palette steht
 * (`SWITCH`): dort haengt keine Stellung an einem Ziel, und der neue Weg setzt
 * ohne Sprung ein. Ab 84 % und bis 12 % der naechsten Ladung dagegen *haengt*
 * sie am Ziel — dort darf nichts wechseln, und der Abstand zu beiden Seiten
 * ist gross genug, dass ein verspaeteter Takt im Browser nichts ausmacht.
 */
export const SWITCH = 0.5;

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
 * rechts, wie das Feld es zulaesst (der gedrehte Ausleger reicht ebenso weit
 * nach rechts, wie der Ausleger nach links), und links bleibt Himmel fuer die
 * Zeit. Kran, Palette und Pyramide ruecken zusammen: es ist *ein* Ort.
 */
export const FLAT_SHIFT = 38;

/**
 * Die ganze Szene in ihrer groessten Ausdehnung, um `shift` verschoben — fuer
 * den Test, dass sie ins Feld passt.
 *
 * Gross heisst: mit dem Ausleger in beiden Stellungen. Nach links reicht die
 * Spitze des Auslegers (oder, gedreht, das Ende des Gegenauslegers), nach
 * rechts dasselbe, an der Achse gespiegelt.
 */
export function craneBox(shift = 0): Box {
  const mirror = (x: number): number => 2 * AXIS - x;
  return {
    left: Math.min(JIB.tip, mirror(JIB.tail)) + shift,
    top: TOWER.apex,
    right: Math.max(JIB.tail, mirror(JIB.tip)) + shift,
    bottom: GROUND,
  };
}
