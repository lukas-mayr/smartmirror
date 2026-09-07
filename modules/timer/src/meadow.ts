/**
 * Die Seegraswiese, als Geometrie.
 *
 * Das zweite Motiv des Timers: eine Meeresschildkroete weidet eine Wiese ab.
 * Was hier steht, ist die Rechnung dazu — wo die Wiese liegt, wieviel von ihr
 * noch steht und wo die Schildkroete dabei schwimmt. Gezeichnet wird in
 * frontend.ts, bewegt wird im Stylesheet; derselbe Schnitt wie bei der
 * Baustelle, und aus demselben Grund: die Rechnung braucht keinen Browser, und
 * nur so laesst sie sich pruefen.
 *
 * Die Regel des Moduls gilt unveraendert: **gefressen wird immer gleich
 * schnell.** Ein Biss dauert `DIG.bucket`, ob der Timer auf drei Minuten oder
 * auf zwei Stunden steht. Was sich mit der Dauer aendert, ist die Wiese.
 *
 * Nur antwortet sie anders als der Berg. Ein Haufen Kies wird hoeher, wenn mehr
 * darin steckt; eine Wiese nicht — Seegras waechst nicht hoeher, weil laenger
 * daran gefressen wird. Es wird laenger. Deshalb traegt hier die **Laenge** die
 * Auskunft: ein langer Timer ist eine lange Wiese, jeder Biss nimmt gleich viel
 * Strecke, und was noch steht, ist die Restzeit. Aus drei Metern liest sich das
 * genau wie beim Berg — ein Stueck, das kleiner wird —, und aus der Naehe
 * stimmt beides mit dem, was man ueber die Sache weiss.
 *
 * Vier Dinge muessen dabei zusammenpassen:
 *
 *  1. Die Wiese muss *abgeweidet* aussehen und nicht ausgeblendet. Hinter der
 *     Fresskante bleibt Stoppel stehen — die Spur der Arbeit, so wie beim
 *     Bagger die Sohle der Grube.
 *  2. Die Kante wandert nach rechts, also schwimmt die Schildkroete ihr nach.
 *     Ihr Schnabel steht immer an der Kante; sonst frisst sie sichtbar
 *     daneben.
 *  3. Alle vier Bisse muss sie **atmen**. Sie steigt zur Oberflaeche, holt Luft
 *     und sinkt zurueck — an derselben Stelle im Takt, an der der Lastwagen
 *     abfaehrt und der naechste kommt.
 *  4. Beim Atmen muss die Nase die Oberflaeche *erreichen* und der Panzer
 *     darunter bleiben. Eine Schildkroete, die aus dem Wasser springt, ist ein
 *     Delfin; eine, die einen halben Meter darunter Luft holt, ist ertrunken.
 *
 * Alle Masse in Feldeinheiten des `viewBox`, der Grund bei `GROUND`.
 */

import { FIELD, GROUND, round, type Box, type Point } from './field.js';

export { FIELD, GROUND };
export type { Box, Point };

/* ------------------------------- Das Wasser -------------------------------- */

/**
 * Wo die Wasseroberflaeche liegt.
 *
 * Hoch genug, dass ueber der Wiese Wasser steht und nicht nur Luft — eine
 * Schildkroete, die zwei Handbreit ueber dem Grund schon oben ist, schwimmt in
 * einer Pfuetze. Tief genug, dass der Aufstieg in den Block passt: die Nase
 * muss die Linie erreichen, ohne dass der Panzer oben aus dem Feld stoesst.
 */
export const SURFACE = 16;

/* -------------------------------- Die Wiese -------------------------------- */

/**
 * Die Wiese in ihrer groessten Ausdehnung.
 *
 * `right` ist ihr rechtes Ende und steht fest: dort hoert die Zeit auf, und
 * zwar unabhaengig davon, wie lange sie laeuft. Gefressen wird von links nach
 * rechts, also waechst eine laengere Wiese nach *links* — der letzte Halm
 * steht bei jedem Timer an derselben Stelle.
 *
 * Die Hoehe ist keine Groesse, die etwas bedeutet: sie ist die Hoehe von
 * Seegras. Was die Dauer aendert, ist allein `width`.
 */
export const MEADOW = { right: 214, width: 122, height: 26 } as const;

/**
 * Ein Halm des Musters.
 *
 * Drei Zahlen, weil drei Dinge einen Halm von einem Zacken unterscheiden: er
 * ist unterschiedlich hoch, unterschiedlich breit und er steht schief. Fehlt
 * eines davon, entsteht ein Kamm — und ein Kamm ist alles Moegliche, nur kein
 * Gras.
 */
export interface Blade {
  /** Hoehe der Spitze, als Anteil der vollen Hoehe. */
  height: number;
  /** Breite am Fuss. */
  width: number;
  /** Wie weit die Spitze aus der Mitte faellt. Positiv heisst nach rechts. */
  lean: number;
}

/**
 * Das Muster, das sich ueber die Wiese wiederholt.
 *
 * Fest und nicht zufaellig: waere es zufaellig, saehe die Wiese bei jedem
 * Zeichnen ein wenig anders aus, und das Auge saehe Flackern statt Wiese. Neun
 * Halme, damit sich das Muster nicht im Takt der Bisse wiederholt und die Wiese
 * gestreift aussieht.
 *
 * Die Neigungen wechseln die Richtung und heben sich ueber das Muster
 * ungefaehr auf. Alle in dieselbe Richtung waeren eine Stroemung, und eine
 * Stroemung, die immer steht, ist keine.
 */
export const BLADES: readonly Blade[] = [
  { height: 1, width: 11, lean: 2.4 },
  { height: 0.72, width: 7.5, lean: -1.8 },
  { height: 0.9, width: 12, lean: 3.2 },
  { height: 0.6, width: 7, lean: -2.6 },
  { height: 0.84, width: 9.5, lean: 1.4 },
  { height: 0.68, width: 8, lean: -3 },
  { height: 0.96, width: 12.5, lean: 2.2 },
  { height: 0.78, width: 8.5, lean: -1.2 },
  { height: 0.88, width: 10.5, lean: 2.8 },
];

/**
 * Wie tief es zwischen zwei Halmen hinuntergeht, als Anteil der kleineren
 * Spitze.
 *
 * Nicht bis auf den Grund: Seegras steht dicht, und zwischen zwei Halmen sieht
 * man den naechsten und nicht den Sand. Aber tief genug, dass einzelne Blaetter
 * zu erkennen sind — bei einer flachen Senke steht dort ein Kamm mit Zacken.
 */
const VALLEY = 0.16;

/**
 * Ueber welche Strecke die Wiese an ihren Enden auslaeuft.
 *
 * Eine Wiese hoert nicht an einer Kante auf, sie duennt aus. Das gilt fuer ihr
 * rechtes Ende immer und fuer ihr linkes so lange, bis dort gefressen wurde —
 * danach steht dort eine frische Kante, und die ist mit Absicht senkrecht: sie
 * ist die Stelle, an der eben noch ein Maul war.
 */
const EDGE = 7;

/**
 * Unter dieser Restlaenge ist die Wiese keine mehr.
 *
 * Ein Bueschel von zwei Einheiten liest sich nicht als "fast fertig", sondern
 * als Schmutz auf dem Spiegel — dieselbe Ueberlegung wie beim letzten Rest des
 * Berges.
 */
const VANISH = 3;

/** Der k-te Halm des Musters, vom rechten Ende der Wiese her gezaehlt. */
function bladeAt(index: number): Blade {
  const count = BLADES.length;
  return BLADES[((index % count) + count) % count] as Blade;
}

/**
 * Ein Halm an seinem Platz auf der Wiese.
 *
 * Gezaehlt wird vom rechten Ende her, weil dort die Wiese festliegt: so steht
 * bei jeder Dauer und in jedem Stand derselbe Halm an derselben Stelle, und die
 * Wiese flackert nicht, wenn ein Biss sie kuerzer macht.
 */
export interface Standing {
  left: number;
  right: number;
  /** Wo die Spitze steht, und wie hoch. */
  tip: Point;
}

export function standingBlade(index: number): Standing {
  let right = MEADOW.right;
  for (let step = 0; step < index; step += 1) right -= bladeAt(step).width;
  const blade = bladeAt(index);
  const left = right - blade.width;
  return {
    left,
    right,
    tip: { x: (left + right) / 2 + blade.lean, y: blade.height * MEADOW.height },
  };
}

/** Der Halm, in dem die Stelle x liegt. */
function bladeIndexAt(x: number): number {
  let right = MEADOW.right;
  for (let index = 0; index < 400; index += 1) {
    const width = bladeAt(index).width;
    if (x > right - width) return index;
    right -= width;
  }
  return 0;
}

/**
 * Der Fuss der Wiese: wo sie bei dieser Groesse anfaengt.
 *
 * `size` ist derselbe Wert wie beim Berg (`mountainSize`) — er kommt aus der
 * Dauer und nicht aus dem Rest. Eine laengere Wiese reicht weiter nach links.
 */
export function meadowLeft(size: number): number {
  const scale = Math.min(1, Math.max(0, size));
  return MEADOW.right - MEADOW.width * scale;
}

/**
 * Wo die Fresskante steht.
 *
 * Der ganze Unterschied zum Berg steht in dieser einen Zeile: der Rest ist eine
 * Strecke. Jeder Biss nimmt denselben Weg, und wieviel Halm darauf steht, ist
 * die Sache des Musters und nicht der Rechnung.
 */
export function grazeCut(size: number, share: number): number {
  const rest = Math.min(1, Math.max(0, share));
  return MEADOW.right - (MEADOW.right - meadowLeft(size)) * rest;
}

/**
 * Wie hoch das Gras an der Stelle x steht — die ungestoerte Wiese, ohne die
 * Frage, wo schon gefressen wurde.
 *
 * Zwischen zwei Spitzen wird geradlinig geteilt, und an beiden Enden laeuft die
 * Wiese aus.
 */
export function bladeHeightAt(size: number, x: number): number {
  const left = meadowLeft(size);
  if (x <= left || x >= MEADOW.right) return 0;

  const index = bladeIndexAt(x);
  const blade = standingBlade(index);
  // Die Senke richtet sich nach dem kleineren der beiden Nachbarn; am rechten
  // Ende der Wiese gibt es keinen, dort uebernimmt der Auslauf.
  const toTheLeft = standingBlade(index + 1).tip.y;
  const toTheRight = index === 0 ? blade.tip.y : standingBlade(index - 1).tip.y;
  const valleyLeft = VALLEY * Math.min(blade.tip.y, toTheLeft);
  const valleyRight = VALLEY * Math.min(blade.tip.y, toTheRight);

  const relative =
    x <= blade.tip.x
      ? valleyLeft + ((blade.tip.y - valleyLeft) * (x - blade.left)) / (blade.tip.x - blade.left)
      : blade.tip.y +
        ((valleyRight - blade.tip.y) * (x - blade.tip.x)) / (blade.right - blade.tip.x);

  const taper = Math.min(1, (x - left) / EDGE, (MEADOW.right - x) / EDGE);
  return Math.max(0, relative * Math.max(0, taper));
}

/** Wie hoch das Gras an der Stelle x noch steht. Links der Kante: gar nicht. */
export function meadowHeightAt(size: number, share: number, x: number): number {
  return x < grazeCut(size, share) ? 0 : bladeHeightAt(size, x);
}

/**
 * Der Umriss der stehenden Wiese als Pfad, oder eine leere Zeichenkette, wenn
 * nichts mehr steht.
 *
 * Gezeichnet wird von der Fresskante nach rechts: erst senkrecht die frische
 * Kante hinauf, dann ueber Spitzen und Senken bis zum rechten Ende, dann am
 * Grund zurueck. Die Stuetzstellen sitzen genau auf Spitzen und Senken — dort
 * ist die abschnittsweise Gerade exakt und nicht abgetastet.
 */
export function meadowPath(size: number, share: number): string {
  const cut = grazeCut(size, share);
  if (MEADOW.right - cut < VANISH) return '';

  /*
   * Die Stuetzstellen sind die Halme selbst: Fuss, Spitze, Fuss. Nichts wird
   * abgetastet — was die Rechnung ueber einen Halm sagt, steht genau so im
   * Pfad.
   */
  const marks: number[] = [MEADOW.right];
  for (let index = 0; index < 200; index += 1) {
    const blade = standingBlade(index);
    if (blade.right <= cut) break;
    if (blade.tip.x > cut) marks.push(blade.tip.x);
    if (blade.left > cut) marks.push(blade.left);
    else break;
  }
  const points: Point[] = [cut, ...marks.reverse()].map((x) => ({
    x: round(x),
    y: round(GROUND - bladeHeightAt(size, x)),
  }));

  /*
   * Zwischen den Punkten wird gerundet und nicht gerade gezogen.
   *
   * Die Punkte selbst sind die Rechnung — Spitzen und Senken sitzen genau dort,
   * wo `bladeHeightAt` sie hat. Nur der Weg dazwischen ist ein Bogen, und zwar
   * weil ein Blatt keine Ecke hat: eine Spitze aus zwei Geraden ist ein Zahn,
   * eine aus zwei Boegen ein Halm. Der Kontrollpunkt liegt auf halber Strecke in
   * der Hoehe des Ziels, damit der Bogen die Spitze wirklich erreicht und sie
   * nicht abrundet.
   */
  const [first, ...rest] = points as [Point, ...Point[]];
  const curves = rest
    .map((point, index) => {
      const previous = (index === 0 ? first : rest[index - 1]) as Point;
      const middle = round((previous.x + point.x) / 2);
      return `Q${middle} ${point.y} ${point.x} ${point.y}`;
    })
    .join('');
  return `M${first.x} ${GROUND}L${first.x} ${first.y}${curves}L${MEADOW.right} ${GROUND}Z`;
}

/**
 * Die Stoppeln hinter der Kante: was von den abgefressenen Halmen uebrig ist.
 *
 * Sie sind der Grund, warum die Wiese abgeweidet aussieht und nicht
 * ausgeblendet. Beim Bagger uebernimmt das die Sohle der Grube; hier ist es
 * eine Reihe kurzer Stummel, die mit jedem Biss laenger wird — die Spur der
 * Arbeit, und aus drei Metern die zweite Haelfte der Auskunft: was rechts noch
 * steht, ist die Restzeit, was links liegt, die vergangene.
 */
export function stubblePath(size: number, share: number): string {
  const left = meadowLeft(size);
  const cut = grazeCut(size, share);
  const parts: string[] = [];
  for (let index = 0; index < 200; index += 1) {
    const blade = standingBlade(index);
    if (blade.right <= left) break;
    if (blade.tip.x >= cut || blade.tip.x <= left) continue;
    // Der Stummel steht dort, wo der Halm stand, und ist so schief wie er war.
    const height = 1.6 + 0.14 * blade.tip.y;
    parts.push(
      `M${round(blade.tip.x)} ${GROUND}L${round(blade.tip.x + height * 0.3)} ${round(GROUND - height)}`,
    );
  }
  return parts.join('');
}

/** Der Platz, den die stehende Wiese einnimmt. */
export function meadowBox(size: number, share: number): Box {
  const cut = grazeCut(size, share);
  let top = GROUND;
  const steps = 240;
  for (let index = 0; index <= steps; index += 1) {
    const x = cut + ((MEADOW.right - cut) * index) / steps;
    top = Math.min(top, GROUND - meadowHeightAt(size, share, x));
  }
  return { left: cut, top, right: MEADOW.right, bottom: GROUND };
}

/* ------------------------------ Der Vorschub ------------------------------- */

/**
 * Wie weit die Schildkroete der Fresskante nachgeschwommen ist.
 *
 * Gemessen an der Kante und nicht an der Zeit: ihr Schnabel steht dort, wo
 * gefressen wird, und die ganze Szene wandert mit. Bei der laengsten Wiese
 * faengt sie bei null an; bei einer kuerzeren steht sie von Anfang an weiter
 * rechts, weil die Wiese dort anfaengt.
 */
export function grazeShift(size: number, share: number): number {
  return grazeCut(size, share) - TURTLE.mouth.x;
}

/* ---------------------------- Die Schildkroete ----------------------------- */

/**
 * Die Punkte, an denen die Schildkroete haengt — in Weidestellung, mit dem
 * Schnabel an der laengsten Wiese.
 *
 * Ein Seitenriss wie bei der Maschine: Panzer, Hals, Kopf, Vorder- und
 * Hinterflosse. Die Drehpunkte stehen hier und nicht im Stylesheet, weil sie
 * zur Form gehoeren — dort waeren sie Zahlen, die zur Zeichnung passen muessen
 * und es irgendwann nicht mehr tun.
 */
export const TURTLE = {
  /** Die Schnabelspitze. Der Punkt, der das Gras beruehrt. */
  mouth: { x: 92, y: 61 },
  /** Der Halsansatz am Panzer, Drehpunkt des Kopfes. */
  neck: { x: 80, y: 54 },
  /** Der Punkt, um den sie sich neigt: ungefaehr ihr Schwerpunkt. */
  pivot: { x: 66, y: 52 },
  /** Schulter, Drehpunkt der Vorderflosse. */
  shoulder: { x: 72, y: 54 },
  /** Die Spitze der Vorderflosse, im Abschlag. */
  flipper: { x: 83, y: 71 },
  /** Der hoechste Punkt des Panzers. */
  crest: { x: 66, y: 44 },
  /** Das hintere Ende des Panzers. */
  tail: { x: 44, y: 54 },
  /** Die Spitze der Hinterflosse. */
  hind: { x: 39, y: 63 },
} as const;

export interface Pose {
  /** Nicken des Kopfes beim Biss. */
  bite: number;
  /** Heben des Kopfes am Hals. */
  neck: number;
  /** Neigung des ganzen Tieres. */
  pitch: number;
  /** Wieviel sie gestiegen ist. */
  rise: number;
}

/**
 * Die Umkehrpunkte des Flossenschlags.
 *
 * Er steht nicht in den Stellungen unten, weil er nicht zur Runde gehoert: die
 * Flosse schlaegt im Takt des Bisses weiter, ob sie nun frisst oder steigt.
 * Zwei Zahlen genuegen — oben und unten —, und beide stehen so im Stylesheet.
 */
export const STROKE = { up: -30, down: 14 } as const;

/**
 * Die Stellungen im Lauf einer Runde: vier Bisse, dann Luft holen.
 *
 * Alles in Grad und so herum wie in SVG: negative Winkel heben Kopf und Nase.
 * Dieselben Zahlen stehen im Stylesheet als Keyframes — doppelt gefuehrt wie
 * beim Bagger, aus demselben Grund: hier laesst sich ohne Browser nachrechnen,
 * ob der Schnabel das Gras trifft und die Nase die Oberflaeche erreicht.
 */
export const SWIM: Readonly<Record<'glide' | 'bite' | 'climb' | 'breath' | 'sink', Pose>> = {
  /** Ueber der Kante stehend, den Kopf im Gras. */
  glide: { bite: 0, neck: 0, pitch: 0, rise: 0 },
  /** Der Biss: der Kopf taucht in die Halme. */
  bite: { bite: 13, neck: 0, pitch: 0, rise: 0 },
  /** Der Aufstieg, halb oben, Kopf schon gehoben. */
  climb: { bite: 0, neck: -30, pitch: -26, rise: 11 },
  /** Oben: die Nase an der Oberflaeche, der Panzer darunter. */
  breath: { bite: 0, neck: -55, pitch: -30, rise: 21 },
  /** Der Abstieg, die Nase wieder nach unten. */
  sink: { bite: 0, neck: -12, pitch: 14, rise: 8 },
};

/** Einen Punkt um einen anderen drehen. Grad, im Uhrzeigersinn wie in SVG. */
export function rotate(point: Point, origin: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/**
 * Wo ein Punkt des Rumpfes liegt: geneigt und gestiegen.
 *
 * Dieselbe Reihenfolge wie die ineinandergelegten Gruppen im SVG — erst die
 * Neigung um den Schwerpunkt, dann der Aufstieg.
 */
export function bodyAt(point: Point, pose: Pose): Point {
  const tilted = rotate(point, TURTLE.pivot, pose.pitch);
  return { x: tilted.x, y: tilted.y - pose.rise };
}

/** Wo ein Punkt des Kopfes liegt: erst das Nicken, dann der Hals, dann der Rumpf. */
export function headAt(point: Point, pose: Pose): Point {
  const nodded = rotate(point, TURTLE.neck, pose.bite);
  const lifted = rotate(nodded, TURTLE.neck, pose.neck);
  return bodyAt(lifted, pose);
}

/** Wo die Nase steht. */
export function noseAt(pose: Pose): Point {
  return headAt(TURTLE.mouth, pose);
}

/** Wo die Spitze der Vorderflosse steht: erst der Schlag, dann der Rumpf. */
export function flipperTipAt(pose: Pose, stroke = 0): Point {
  return bodyAt(rotate(TURTLE.flipper, TURTLE.shoulder, stroke), pose);
}
