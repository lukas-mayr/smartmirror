/**
 * Die Baustelle, als Geometrie.
 *
 * Hier steht, wo etwas liegt und wie gross es ist — nicht, wie es gezeichnet
 * wird (das ist frontend.ts) und nicht, wann es sich bewegt (das ist das
 * Stylesheet). Der Schnitt ist derselbe wie bei den Wettersymbolen: die
 * Rechnung braucht keinen Browser, und nur deshalb laesst sie sich pruefen.
 *
 * Vier Dinge muessen zusammenpassen, die unabhaengig voneinander entstanden
 * sind:
 *
 *  1. Der Berg muss *abgebaut* aussehen und nicht kleiner gezoomt. Er bekommt
 *     deshalb eine Abbaukante: eine gerade Boeschung, die sich in den Haufen
 *     hineinfrisst, und darueber eine Sohle, die tiefer wird. Genau so sieht
 *     eine Grube aus, und genau so verschwindet ein Haufen, an dem jemand von
 *     einer Seite graebt.
 *  2. Jeder Eimer muss *gleich viel* wegnehmen. Nicht gleich viel Hoehe oder
 *     gleich viel Breite — gleich viel Flaeche. Wieviel Kante und wieviel
 *     Sohle das ist, faellt aus der Rechnung und nicht aus einer Schaetzung.
 *  3. Der Bagger muss den Berg *treffen*. Die Kante wandert nach rechts, also
 *     muss er ihr nachfahren; die Schaufel greift immer zwei Einheiten hinter
 *     der Zehe der Kante.
 *  4. Was er hebt, muss in die *Mulde* fallen. Der Oberwagen dreht sich (im
 *     Seitenriss: er kippt durch die Senkrechte und steht danach
 *     spiegelverkehrt), und wo die Schaufel danach haengt, ergibt sich aus
 *     Drehung und Spiegelung — nicht aus einer Zahl, die jemand geschaetzt hat.
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
 * `left` ist sein Fuss auf der Baggerseite. Dort setzt die Abbaukante an, und
 * von dort wandert sie nach rechts durch den Haufen.
 */
export const MOUNTAIN = { left: 150, width: 50, height: 46 } as const;

/**
 * Das Profil eines Haufens, auf 1 x 1 normiert.
 *
 * Kein Dreieck: ein Dreieck ist ein Dach, kein Berg. Die linke Flanke steht
 * steil, die rechte laeuft lang aus, mit einer Schulter darin. Dieselbe Form in
 * jeder Groesse: waere sie zufaellig, aenderte sich der Berg bei jedem Zeichnen
 * ein wenig und das Auge saehe Flackern statt Abbau.
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
 * Neigung der Abbaukante: Hoehe je Breite.
 *
 * 1,6 sind gut 58 Grad — steiler als der Schuettwinkel von Kies (rund 34) und
 * flacher als eine Wand. Genau so steht die Wand, an der ein Bagger frisch
 * gegraben hat: sie haelt fuer den Moment und rutscht spaeter nach.
 *
 * Der Wert ist absolut und nicht auf die Berggroesse bezogen — und trotzdem
 * fuer jede Groesse richtig, weil Hoehe und Breite des Berges immer im selben
 * Verhaeltnis stehen. Die Kante braucht damit bei jedem Berg dieselbe halbe
 * Breite, um seine Hoehe zu erreichen.
 */
const FACE_SLOPE = 1.6;

/**
 * Wie weit die Kante in den Berg hineinwandert, als Anteil seiner Breite —
 * und zwar am Anfang langsam und am Ende schnell.
 *
 * Der Grund steht in der Sache selbst: jeder Eimer nimmt gleich viel Flaeche.
 * Am Anfang steht die Wand hoch, und ein Eimer kostet kaum Weg. Am Ende liegt
 * nur noch eine flache Lage, und fuer dieselbe Menge muss die Maschine eine
 * lange Strecke davon abziehen. Genau deshalb faehrt ein Bagger, der eine Grube
 * fertig macht, am Schluss viel weiter als am Anfang.
 *
 * Waere der Vorschub gleichmaessig, bliebe am Ende eine duenne Lage ueber die
 * ganze Breite stehen — kein Berg mehr, sondern ein Schmutzstreifen auf dem
 * Boden, der erst im letzten Moment verschwindet.
 */
const ADVANCE = { steady: 0.42, late: 0.55 } as const;

/** Der Weg der Kante bei `tau`, als Anteil der Bergbreite. */
function advanceAt(tau: number): number {
  return ADVANCE.steady * tau + ADVANCE.late * tau ** 3;
}

/**
 * Wo die Kante steht, bevor der erste Eimer weg ist, als Anteil der Breite —
 * links vom Fuss.
 *
 * Weit genug, dass sie den Haufen noch nirgends anschneidet: sonst faehrt der
 * Bagger den ersten Eimer in einen Berg, der schon abgetragen aussieht. Massgebend
 * ist dabei nicht der Gipfel, sondern die steilste Stelle der linken Flanke —
 * dort kommt die Boeschung dem Profil am naechsten. Ein Test rechnet das nach.
 */
const START_BACK = 0.17;

/**
 * Unter dieser Hoehe ist der Berg keiner mehr.
 *
 * Der letzte Eimer laesst rechnerisch einen Rest von wenigen Hundertsteln
 * stehen. Ein Strich von einer halben Einheit auf dem Boden liest sich aber
 * nicht als "fast fertig", sondern als Schmutz auf dem Spiegel.
 */
const VANISH = 1.2;

/** Die Hoehe des ungestoerten Profils an der Stelle u, als Anteil der Hoehe. */
function profileAt(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  let previous = PROFILE[0] as Point;
  for (const point of PROFILE.slice(1)) {
    if (u <= point.x) {
      const span = point.x - previous.x;
      const t = span === 0 ? 0 : (u - previous.x) / span;
      return previous.y + (point.y - previous.y) * t;
    }
    previous = point;
  }
  return 0;
}

/**
 * Der Stand des Abbaus: wo die Kante steht und wie tief die Sohle liegt.
 *
 * `tau` laeuft von 0 (unberuehrt) bis 1 (abgeraeumt) und ist *nicht* die
 * verstrichene Zeit — welches `tau` zu welchem Rest gehoert, rechnet
 * `tauForShare` aus der Flaeche aus.
 */
export interface Bench {
  /** Fuss und Breite des urspruenglichen Haufens. */
  left: number;
  width: number;
  height: number;
  /** Wo die Boeschung den Boden trifft. */
  cut: number;
  /** Hoehe der Sohle ueber dem Boden — hoeher liegt nichts mehr. */
  crest: number;
}

export function benchAt(size: number, tau: number): Bench {
  const scale = Math.min(1, Math.max(0, size));
  const width = MOUNTAIN.width * scale;
  const height = MOUNTAIN.height * scale;
  const t = Math.min(1, Math.max(0, tau));
  return {
    left: MOUNTAIN.left,
    width,
    height,
    cut: MOUNTAIN.left + (advanceAt(t) - START_BACK) * width,
    crest: height * (1 - t),
  };
}

/**
 * Wie hoch der Berg an der Stelle x noch steht.
 *
 * Das Kleinste von dreien: das urspruengliche Profil, die Sohle und die
 * Boeschung, die von der Zehe aus ansteigt. Mehr ist es nicht — und aus diesen
 * drei Geraden entsteht genau die Form, die eine angegrabene Halde hat.
 */
export function surfaceAt(bench: Bench, x: number): number {
  if (x <= bench.cut || x >= bench.left + bench.width) return 0;
  const profile = profileAt((x - bench.left) / bench.width) * bench.height;
  const face = (x - bench.cut) * FACE_SLOPE;
  return Math.max(0, Math.min(profile, bench.crest, face));
}

/** Die Flaeche, die vom Berg noch steht. Numerisch, mit festen Stuetzstellen. */
export function mountainArea(size: number, tau: number): number {
  const bench = benchAt(size, tau);
  if (bench.width <= 0) return 0;
  const steps = 240;
  const step = bench.width / steps;
  let sum = 0;
  for (let index = 0; index < steps; index += 1) {
    const x = bench.left + (index + 0.5) * step;
    sum += surfaceAt(bench, x);
  }
  return sum * step;
}

/*
 * Welches `tau` zu welchem Rest gehoert, haengt nicht von der Berggroesse ab:
 * Hoehe und Breite skalieren gemeinsam, die Flaeche also mit dem Quadrat, und
 * der *Anteil* bleibt derselbe. Einmal am Bezugsberg ausgerechnet, gilt die
 * Tabelle fuer jeden.
 */
const TAU_STEPS = 512;
const SHARE_TABLE: readonly number[] = (() => {
  const full = mountainArea(1, 0);
  return Array.from({ length: TAU_STEPS + 1 }, (_, index) =>
    full <= 0 ? 0 : mountainArea(1, index / TAU_STEPS) / full,
  );
})();

/**
 * Der Stand des Abbaus, bei dem noch `share` des Berges steht.
 *
 * Damit nimmt jeder Eimer gleich viel Flaeche weg — und nicht gleich viel
 * Hoehe. Der Unterschied ist genau der zwischen "es wird gegraben" und "es
 * wird verkleinert": am Anfang kostet ein Eimer viel Kante und wenig Sohle, am
 * Ende ist es umgekehrt.
 */
export function tauForShare(share: number): number {
  const wanted = Math.min(1, Math.max(0, share));
  if (wanted >= 1) return 0;
  if (wanted <= 0) return 1;
  // Die Tabelle faellt monoton; gesucht ist die Stelle, an der sie `wanted`
  // unterschreitet, und dazwischen wird linear geteilt.
  let low = 0;
  let high = TAU_STEPS;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((SHARE_TABLE[mid] as number) > wanted) low = mid;
    else high = mid;
  }
  const above = SHARE_TABLE[low] as number;
  const below = SHARE_TABLE[high] as number;
  const span = above - below;
  const t = span <= 0 ? 0 : (above - wanted) / span;
  return (low + t) / TAU_STEPS;
}

/**
 * Der Umriss des Berges als Pfad, oder eine leere Zeichenkette, wenn nichts
 * mehr da ist.
 *
 * Abgetastet statt ausgerechnet: der Rand ist das Kleinste dreier Geraden, und
 * an den Stuetzstellen ist das Kleinste exakt richtig. Nur *wo* genau die
 * Knicke sitzen, verschiebt sich um weniger als eine halbe Einheit — unter der
 * Strichstaerke, und `stroke-linejoin: round` nimmt den Rest.
 *
 * Der Pfad beginnt an der Zehe der Kante, laeuft ueber Boeschung, Sohle und
 * Restflanke bis zum rechten Fuss und schliesst ueber den Boden zurueck.
 */
export function mountainPath(size: number, share: number): string {
  const bench = benchAt(size, tauForShare(share));
  if (bench.crest < VANISH || bench.width <= 0) return '';

  const start = Math.max(bench.left, bench.cut);
  const end = bench.left + bench.width;
  if (end - start < VANISH) return '';

  const steps = 64;
  const points: Point[] = [{ x: round(start), y: GROUND }];
  for (let index = 1; index <= steps; index += 1) {
    const x = start + ((end - start) * index) / steps;
    points.push({ x: round(x), y: round(GROUND - surfaceAt(bench, x)) });
  }

  const [first, ...rest] = points as [Point, ...Point[]];
  return `M${first.x} ${first.y}${rest.map((point) => `L${point.x} ${point.y}`).join('')}Z`;
}

/** Der Platz, den der Berg einnimmt. */
export function mountainBox(size: number, share: number): Box {
  const bench = benchAt(size, tauForShare(share));
  let top = GROUND;
  const steps = 120;
  for (let index = 0; index <= steps; index += 1) {
    const x = bench.left + (bench.width * index) / steps;
    top = Math.min(top, GROUND - surfaceAt(bench, x));
  }
  return {
    left: Math.max(bench.left, bench.cut),
    top,
    right: bench.left + bench.width,
    bottom: GROUND,
  };
}

/* ------------------------------ Der Vorschub ------------------------------- */

/**
 * Wie weit der Bagger der Kante nachgefahren ist.
 *
 * Ein Bagger steht nicht still, waehrend die Wand vor ihm nach hinten wandert —
 * er faehrt nach. Genau das macht den Abbau glaubwuerdig: die Maschine arbeitet
 * sich in den Berg hinein, statt ihn aus der Ferne schrumpfen zu lassen.
 *
 * Gemessen an der Zehe der Kante, damit die Schaufel immer dort greift, wo
 * gegraben wird. Solange die Kante noch links vom Fuss steht, steht auch der
 * Bagger still: sie schneidet dann ja noch nichts an.
 */
export function siteShift(size: number, share: number): number {
  const bench = benchAt(size, tauForShare(share));
  return Math.max(0, bench.cut - MOUNTAIN.left);
}

/* -------------------------------- Der Bagger ------------------------------- */

/**
 * Die Gelenke des Baggers, in Grabstellung.
 *
 * Vier Punkte, drei Glieder: Ausleger vom Fuss zum Knick, Stiel vom Knick zum
 * Bolzen, Schaufel vom Bolzen zum Zahn. Der Zahn steht zwei Einheiten rechts
 * vom Fuss des Berges — also genau in der Wand, an der gegraben wird.
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

export interface Pose {
  /** Hub des Auslegers. */
  boom: number;
  /** Nachziehen des Stiels. */
  stick: number;
  /** Einrollen der Schaufel. */
  bucket: number;
}

/**
 * Die Stellungen, die der Arm im Lauf eines Eimers einnimmt.
 *
 * Alles in Grad und so herum wie in SVG: positiv dreht nach unten bzw. zieht
 * die Schaufel zur Maschine hin.
 *
 * Fuenf Stellungen und keine Zwischenwerte — dazwischen blendet das Stylesheet
 * ueber. Dieselben Zahlen stehen dort als Keyframes. Sie doppelt zu fuehren ist
 * derselbe Preis wie bei den Wettersymbolen: nur so laesst sich hier ohne
 * Browser nachrechnen, ob der Zahn den Berg trifft und die Ladung in die Mulde
 * faellt.
 */
export const POSE: Readonly<Record<'reach' | 'cut' | 'full' | 'raised' | 'tipped', Pose>> = {
  /** Ausgestreckt, der Zahn an der Wand. */
  reach: { boom: 0, stick: 0, bucket: 0 },
  /** Durchgezogen: unten am Fuss der Wand, die Schaufel noch offen. */
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
export const TRACK = { left: 96, right: 142, top: 66 } as const;

/**
 * Die Achse, um die sich der Oberwagen dreht.
 *
 * Mitte der Raupe. Ein Bagger laedt nicht, indem er den Arm ueber sich
 * hinwegwirft, sondern indem der ganze Oberwagen sich dreht — Kabine, Ausleger
 * und Kontergewicht zusammen. Im Seitenriss ist diese Drehung eine Spiegelung
 * an genau dieser Senkrechten, und dazwischen steht der Oberwagen quer zum
 * Blick und wird schmal. Genau das zeigt die Bewegung im Stylesheet, und genau
 * deshalb ist sie kein Trick, sondern die richtige Ansicht.
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
 * Erst die Schaufel um ihren Bolzen, dann der Stiel um den Knick, dann der
 * ganze Arm um seinen Fuss, zuletzt die Spiegelung, falls der Oberwagen
 * gedreht ist — dieselbe Reihenfolge wie die ineinandergelegten Gruppen im
 * SVG.
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
 * Der Kipper.
 *
 * Das Fahrerhaus steht links, weil der Wagen nach links abfaehrt: ein
 * Lastwagen, der rueckwaerts aus dem Bild rollt, sieht nicht nach Abtransport
 * aus. Die Mulde liegt damit auf der Baggerseite, und der Weg der Schaufel
 * wird kurz.
 *
 * Die Bordwand steht deutlich niedriger als das Dach des Fahrerhauses. Auf
 * gleicher Hoehe wurde aus beiden ein einziger langer Kasten, und der sah nach
 * Anhaenger aus statt nach Kipper.
 */
export const TRUCK = {
  /** Linke und rechte Kante der Mulde. */
  bed: { left: 36, right: 88 },
  /** Oberkante der Bordwand und Boden der Mulde. */
  rim: 48,
  floor: 62,
  /**
   * Oberkante der Stirnwand.
   *
   * Sie steht hoeher als die Seitenwand und niedriger als das Dach des
   * Fahrerhauses — in dieser Reihenfolge, sonst sieht der Wagen aus, als
   * schoebe er eine Kiste vor sich her.
   */
  headboard: 44,
  /** Oberkante des Rahmens, auf dem die Mulde sitzt. */
  frame: 64,
  /** Wie weit der volle Wagen aus dem Bild faehrt. */
  exit: -180,
} as const;

/**
 * Der Haufen auf der Mulde, als Pfad — und zwar nur der Teil, den man sieht.
 *
 * Von der Seite schaut niemand in eine Mulde hinein. Sichtbar wird eine Ladung
 * erst, wenn sie ueber die Bordwand steht, und genau dort setzt dieser Haufen
 * an: seine Grundlinie *ist* die Bordwand. Was darunter liegt, ist im Wagen und
 * geht die Zeichnung nichts an.
 *
 * Deshalb steht hier auch keine Fuellmenge: das Stylesheet laesst den Haufen
 * erst bei den letzten beiden Eimern aufsteigen — vorher ist die Mulde tief
 * genug, dass man nichts sieht.
 */
export function cargoPath(): string {
  const left = TRUCK.bed.left + 3;
  const right = TRUCK.bed.right - 3;
  const width = right - left;
  const top = TRUCK.rim - 8;
  return (
    `M${left} ${TRUCK.rim}` +
    `Q${round(left + width * 0.22)} ${round(top + 2)} ${round(left + width * 0.44)} ${top}` +
    `Q${round(left + width * 0.7)} ${round(top + 3)} ${right} ${TRUCK.rim}` +
    `Z`
  );
}

/* --------------------------------- Werkzeug -------------------------------- */

/** Zwei Nachkommastellen. Mehr Stellen sind im Pfad nur laengerer Text. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
