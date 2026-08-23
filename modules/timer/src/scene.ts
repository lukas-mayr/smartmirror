/**
 * Die Baustelle, als Geometrie.
 *
 * Hier steht, wo etwas liegt und wie gross es ist — nicht, wie es gezeichnet
 * wird (das ist frontend.ts) und nicht, wann es sich bewegt (das ist das
 * Stylesheet). Der Schnitt ist derselbe wie bei den Wettersymbolen: die
 * Rechnung braucht keinen Browser, und nur deshalb laesst sie sich pruefen.
 *
 * Zu pruefen gibt es hier mehr als bei einem stehenden Bild, denn drei Dinge
 * muessen zusammenpassen, die unabhaengig voneinander entstanden sind:
 *
 *  1. Der Bagger muss den Berg *treffen*. Die Schaufel greift an einer festen
 *     Stelle, der Berg wird kleiner — steht er irgendwann neben der Schaufel,
 *     schaufelt der Bagger sichtbar in die Luft. Deshalb schrumpft der Berg
 *     auf seinen linken Fuss zu, und genau dort greift die Schaufel.
 *  2. Was der Bagger hebt, muss in die *Mulde* fallen. Der Oberwagen dreht
 *     sich (im Seitenriss: er kippt durch die Senkrechte und steht danach
 *     spiegelverkehrt), und wo die Schaufel danach haengt, ergibt sich aus
 *     Drehung und Spiegelung — nicht aus einer Zahl, die jemand geschaetzt hat.
 *  3. Nichts darf aus dem Feld stossen. Ein Berg, der oben abgeschnitten ist,
 *     sieht nicht nach einem grossen Berg aus, sondern nach einem Fehler.
 *
 * Alle Masse in Feldeinheiten des `viewBox`. Der Boden liegt bei `GROUND`,
 * gezaehlt wird wie in SVG von oben.
 */

/**
 * Der Ausschnitt, den das `viewBox` zeigt.
 *
 * `top` schneidet oben ab, was niemand braucht: gerechnet wird von einer Null
 * ganz oben, gezeichnet wird aber erst ab dem Gipfel des groessten Berges. Ohne
 * den Schnitt stuende ueber der Baustelle ein Streifen Leere, und weil sich das
 * Bild in seinen Platz einpasst, waere die Baustelle dadurch kleiner statt der
 * Streifen schmaler.
 *
 * Breit und flach: eine Baustelle ist eine Zeile.
 */
export const FIELD = { top: 26, width: 220, height: 58 } as const;

/** Wo der Boden liegt. Darunter bleibt Platz fuer Raeder und Raupen. */
export const GROUND = 80;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/* --------------------------------- Der Berg -------------------------------- */

/**
 * Der Berg an seiner groessten Stelle.
 *
 * `left` ist sein Fuss auf der Baggerseite und zugleich der Punkt, auf den er
 * beim Abtragen zusammenschrumpft. Dass die Schaufel genau dort greift, ist
 * keine Zierde, sondern die Bedingung dafuer, dass Bagger und Berg bis zum
 * letzten Eimer zusammengehoeren.
 */
export const MOUNTAIN = { left: 150, width: 60, height: 46 } as const;

/**
 * Das Profil eines Haufens, auf 1 x 1 normiert.
 *
 * Kein Dreieck: ein Dreieck ist ein Dach, kein Berg. Die linke Flanke steht
 * steil — sie ist die Wand, an der gegraben wird —, die rechte laeuft lang
 * aus, mit einer Schulter darin. Dieselbe Form in jeder Groesse: waere sie
 * zufaellig, aenderte sich der Berg bei jedem Zeichnen ein wenig und das Auge
 * saehe Flackern statt Abbau.
 */
export const PROFILE: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 0.1, y: 0.28 },
  { x: 0.22, y: 0.45 },
  { x: 0.34, y: 0.86 },
  { x: 0.42, y: 1 },
  { x: 0.52, y: 0.88 },
  { x: 0.62, y: 0.62 },
  { x: 0.74, y: 0.5 },
  { x: 0.86, y: 0.26 },
  { x: 1, y: 0 },
];

/**
 * Unter dieser Groesse ist der Berg keiner mehr.
 *
 * Der letzte Eimer laesst rechnerisch einen Rest von wenigen Hundertsteln
 * stehen. Ein Strich von einer halben Einheit auf dem Boden liest sich aber
 * nicht als "fast fertig", sondern als Schmutz auf dem Spiegel — also ist er
 * ab hier weg.
 */
const VANISH = 1.2;

/**
 * Wie stark der Berg in die Breite und in die Hoehe schrumpft.
 *
 * Zusammen ergeben die beiden Exponenten ungefaehr eins: die Flaeche nimmt
 * also linear mit den Eimern ab, und ein Eimer ist ueber die ganze Dauer
 * gleich viel Berg. Dass die Hoehe staerker nachgibt als die Breite, ist der
 * Unterschied zwischen einem Haufen, der abgetragen wird, und einem, der
 * einfach kleiner gezoomt wird: gegraben wird von der Seite, und was bleibt,
 * ist flacher und nicht bloss kleiner.
 */
const SHRINK = { height: 0.65, width: 0.35 } as const;

/** Die Masse des Berges: `size` ist die Groesse zu Beginn, `share` was noch steht. */
export function mountainSpan(size: number, share: number): { width: number; height: number } {
  const clampedSize = Math.min(1, Math.max(0, size));
  const left = Math.min(1, Math.max(0, share));
  if (left === 0) return { width: 0, height: 0 };
  return {
    width: MOUNTAIN.width * clampedSize * left ** SHRINK.width,
    height: MOUNTAIN.height * clampedSize * left ** SHRINK.height,
  };
}

/**
 * Der Umriss des Berges als Pfad, oder eine leere Zeichenkette, wenn nichts
 * mehr da ist.
 *
 * Der Pfad beginnt und endet auf dem Boden und ist geschlossen: der Berg
 * bekommt eine sehr schwach getoente Flaeche, und eine offene Kontur liesse
 * sie unten auslaufen. Zwischen den Stuetzpunkten wird gerade verbunden — bei
 * zehn Punkten auf 46 Einheiten liegt der Knick unter der Strichstaerke, und
 * `stroke-linejoin: round` nimmt ihm den Rest.
 */
export function mountainPath(size: number, share: number): string {
  const span = mountainSpan(size, share);
  if (span.width < VANISH || span.height < VANISH) return '';

  const points = PROFILE.map((point) => ({
    x: round(MOUNTAIN.left + point.x * span.width),
    y: round(GROUND - point.y * span.height),
  }));

  const [first, ...rest] = points as [Point, ...Point[]];
  return `M${first.x} ${first.y}${rest.map((point) => `L${point.x} ${point.y}`).join('')}Z`;
}

/** Der Platz, den der Berg einnimmt. Leer heisst: eine Flaeche ohne Ausdehnung. */
export function mountainBox(size: number, share: number): Box {
  const span = mountainSpan(size, share);
  return {
    left: MOUNTAIN.left,
    top: GROUND - span.height,
    right: MOUNTAIN.left + span.width,
    bottom: GROUND,
  };
}

/**
 * Die Hoehe des Berges an einer Stelle x.
 *
 * Gebraucht wird sie nicht zum Zeichnen, sondern zum Pruefen: die Schaufel
 * soll den Berg treffen und nicht daneben greifen.
 */
export function mountainHeightAt(size: number, share: number, x: number): number {
  const span = mountainSpan(size, share);
  if (span.width <= 0) return 0;
  const u = (x - MOUNTAIN.left) / span.width;
  if (u < 0 || u > 1) return 0;

  let previous = PROFILE[0] as Point;
  for (const point of PROFILE.slice(1)) {
    if (u <= point.x) {
      const t = point.x === previous.x ? 0 : (u - previous.x) / (point.x - previous.x);
      return (previous.y + (point.y - previous.y) * t) * span.height;
    }
    previous = point;
  }
  return 0;
}

/* -------------------------------- Der Bagger ------------------------------- */

/**
 * Die Gelenke des Baggers, in Grabstellung.
 *
 * Vier Punkte, drei Glieder: Ausleger vom Fuss zum Knick, Stiel vom Knick zum
 * Bolzen, Schaufel vom Bolzen zur Spitze. Die Spitze steht auf `MOUNTAIN.left`
 * — das ist Punkt 1 aus der Ueberschrift und der Grund, warum diese Zahl nicht
 * frei gewaehlt ist.
 *
 * Die Schaufel zeigt nach unten *links*, also zur Maschine hin: ein Bagger
 * zieht die Schaufel zu sich heran, er schiebt sie nicht von sich weg. Das ist
 * der Unterschied zwischen einem Bagger und einem Radlader, und man sieht ihn
 * sofort, wenn er falsch herum steht.
 */
export const ARM = {
  /** Drehpunkt des Auslegers am Oberwagen. */
  foot: { x: 128, y: 58 },
  /** Knick zwischen Ausleger und Stiel. */
  knuckle: { x: 148, y: 36 },
  /** Bolzen, an dem die Schaufel haengt. */
  pin: { x: 156, y: 60 },
  /** Zahn der Schaufel — der Punkt, der den Berg beruehrt. */
  tip: { x: 152, y: 74 },
} as const;

/**
 * Die Stellungen, die der Arm im Lauf eines Eimers einnimmt.
 *
 * `boom` ist der Hub des Auslegers, `bucket` das Einrollen der Schaufel, beides
 * in Grad und beides so herum wie in SVG: positiv dreht nach unten bzw. zieht
 * die Schaufel zur Maschine hin.
 *
 * Fuenf Stellungen und keine Zwischenwerte — dazwischen blendet das Stylesheet
 * ueber. Dieselben Zahlen stehen dort als Keyframes. Sie doppelt zu fuehren ist
 * derselbe Preis wie bei den Wettersymbolen: nur so laesst sich hier ohne
 * Browser nachrechnen, ob der Zahn den Berg trifft und die Ladung in die Mulde
 * faellt — und eine Rechnung, die sich ihre Zahlen selbst gibt, waere keine
 * Pruefung.
 */
export interface Pose {
  /** Hub des Auslegers. */
  boom: number;
  /** Nachziehen des Stiels. */
  stick: number;
  /** Einrollen der Schaufel. */
  bucket: number;
}

export const POSE: Readonly<Record<'reach' | 'cut' | 'full' | 'raised' | 'tipped', Pose>> = {
  /** Ausgestreckt, der Zahn an der Flanke. */
  reach: { boom: 0, stick: 0, bucket: 0 },
  /** Durchgezogen: unten am Fuss des Berges, die Schaufel noch offen. */
  cut: { boom: 13, stick: -8, bucket: 12 },
  /** Zugezogen und voll — die Schaufel steht neben der Raupe, nicht darauf. */
  full: { boom: 7, stick: 0, bucket: 34 },
  /** Gehoben. In dieser Stellung dreht der Oberwagen. */
  raised: { boom: -74, stick: 0, bucket: 34 },
  /** Gekippt, ueber der Mulde. */
  tipped: { boom: -74, stick: 0, bucket: -25 },
};

/**
 * Die Raupe, auf der der Oberwagen sitzt.
 *
 * Sie steht still, wenn er sich dreht — genau daran erkennt man, dass sich der
 * Oberwagen dreht und nicht die ganze Maschine kippt. Ihre Kanten stehen hier,
 * weil die eingezogene Schaufel neben ihr landen muss und nicht auf ihr: eine
 * Schaufel, die durch das eigene Fahrwerk faehrt, faellt sofort auf.
 */
export const TRACK = { left: 96, right: 142, top: 68 } as const;

/**
 * Die Achse, um die sich der Oberwagen dreht.
 *
 * Mitte der Raupe. Ein Bagger laedt nicht, indem er den Arm ueber sich
 * hinwegwirft, sondern indem der ganze Oberwagen sich dreht — Kabine, Ausleger
 * und Kontergewicht zusammen. Im Seitenriss ist diese Drehung eine Spiegelung
 * an genau dieser Senkrechten, und dazwischen steht der Oberwagen quer zum
 * Blick und wird schmal. Genau das zeigt die Bewegung im Stylesheet, und
 * genau deshalb ist sie kein Trick, sondern die richtige Ansicht.
 */
export const SLEW_X = 119;

/** Einen Punkt um einen anderen drehen. Grad, im Uhrzeigersinn wie in SVG. */
export function rotate(point: Point, origin: Point, degrees: number): Point {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

/** Einen Punkt an einer Senkrechten spiegeln — die halbe Drehung des Oberwagens. */
export function mirror(point: Point, axis: number = SLEW_X): Point {
  return { x: 2 * axis - point.x, y: point.y };
}

/**
 * Wo der Zahn der Schaufel steht.
 *
 * Erst die Schaufel um ihren Bolzen, dann der ganze Arm um seinen Fuss, zuletzt
 * die Spiegelung, falls der Oberwagen gedreht ist — dieselbe Reihenfolge wie
 * die ineinandergelegten Gruppen im SVG. Damit beantwortet diese Funktion die
 * beiden Fragen, an denen die Szene haengt: trifft der Zahn den Berg, und
 * faellt die Ladung in die Mulde?
 */
export function toothAt(pose: Pose, slewed = false): Point {
  const curled = rotate(ARM.tip, ARM.pin, pose.bucket);
  const pulled = rotate(curled, ARM.knuckle, pose.stick);
  const lifted = rotate(pulled, ARM.foot, pose.boom);
  return slewed ? mirror(lifted) : lifted;
}

/** Wo der Bolzen steht, an dem die Schaufel haengt. Fuer die Reichweitenprobe. */
export function pinAt(pose: Pose, slewed = false): Point {
  const pulled = rotate(ARM.pin, ARM.knuckle, pose.stick);
  const lifted = rotate(pulled, ARM.foot, pose.boom);
  return slewed ? mirror(lifted) : lifted;
}

/** Wo der Knick zwischen Ausleger und Stiel steht. */
export function knuckleAt(pose: Pose, slewed = false): Point {
  const lifted = rotate(ARM.knuckle, ARM.foot, pose.boom);
  return slewed ? mirror(lifted) : lifted;
}

/* ------------------------------- Der Lastwagen ------------------------------ */

/**
 * Die Mulde des Lastwagens, in die geschuettet wird.
 *
 * Das Fahrerhaus steht links, weil der Wagen nach links abfaehrt: ein
 * Lastwagen, der rueckwaerts aus dem Bild rollt, sieht nicht nach Abtransport
 * aus. Die Mulde liegt damit auf der Baggerseite, und der Weg der Schaufel
 * wird kurz.
 *
 * Die Bordwand steht deutlich niedriger als das Dach des Fahrerhauses. Auf
 * gleicher Hoehe wurde aus beiden ein einziger langer Kasten, und der sah nach
 * Anhaenger aus statt nach Kipper — dabei ist die offene Mulde das, was den
 * Wagen ueberhaupt zu einem Ziel fuer die Schaufel macht.
 */
export const TRUCK = {
  /** Linke und rechte Kante der Mulde. */
  bed: { left: 40, right: 90 },
  /** Oberkante der Bordwand und Boden der Mulde. */
  rim: 48,
  floor: 62,
  /** Wie weit der volle Wagen aus dem Bild faehrt. */
  exit: -140,
} as const;

/**
 * Der Haufen auf der Mulde, als Pfad.
 *
 * Er sitzt immer gleich da und wird nur in der Hoehe gestaucht — das
 * Stylesheet macht daraus vier Stufen, eine je Eimer. Deshalb steht hier keine
 * Fuellmenge: die Ladung ist eine Bewegung und kein Zustand, den jemand
 * ausrechnen muesste.
 */
export function cargoPath(): string {
  const left = TRUCK.bed.left + 2;
  const right = TRUCK.bed.right - 2;
  const width = right - left;
  const top = TRUCK.rim - 6;
  return (
    `M${left} ${TRUCK.floor}` +
    `L${round(left + width * 0.18)} ${round(top + 4)}` +
    `L${round(left + width * 0.42)} ${top}` +
    `L${round(left + width * 0.68)} ${round(top + 5)}` +
    `L${right} ${TRUCK.floor}Z`
  );
}

/* --------------------------------- Werkzeug -------------------------------- */

/** Zwei Nachkommastellen. Mehr Stellen sind im Pfad nur laengerer Text. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
