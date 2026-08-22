import type { IconName } from '@mirror/icons';

/**
 * Woraus die Wettersymbole des Moduls bestehen – ohne eine Zeile Zeichencode.
 *
 * Warum nicht die Bibliothek? Weil ein Wettersymbol auf diesem Spiegel kein
 * Symbol mehr ist. Es steht bei 155 px neben einer Zahl von 106 und ist die
 * Angabe, die man aus drei Metern zuerst erfasst – schneller als jede Zahl.
 * In dieser Groesse faellt auf, dass die Bibliotheksformen fuer 24 px gedacht
 * sind: "bedeckt" ist dort dieselbe einzelne Wolke wie "bewoelkt", und der
 * Blitz ein Haken, den man neben der Wolke kaum findet.
 *
 * Zwei Dinge sind an diesem Satz anders als an einem gewoehnlichen Symbolsatz,
 * und beide stehen hier, weil sie beim ersten Anlauf schiefgegangen sind:
 *
 *  1. Die Wolken werden aus Kreisen gerechnet und nicht aus Boegen geraten.
 *     SVG vergroessert einen zu kleinen Bogenradius stillschweigend, und die
 *     rechte Kuppe blaehte sich dadurch weiter auf als beabsichtigt – die
 *     Wolken standen ueber der Kante des Feldes und waren abgeschnitten,
 *     schon im Stillstand.
 *  2. Jede Form kennt ihren *Bewegungsraum*: die Zeichnung plus halbe
 *     Strichstaerke plus den groessten Ausschlag ihrer Animation. Ein Test
 *     haelt diesen Raum gegen das Feld, damit nie wieder etwas an den Rand
 *     stoesst, das sich bewegt.
 *
 * Bewegt wird immer nur ein Teil und nie das ganze Symbol: die Strahlen
 * drehen, die Wolke driftet, die Tropfen fallen. Was zu einer Wolke gehoert,
 * liegt dabei in *einer* Gruppe und zieht mit ihr – sonst wanderte die Wolke
 * davon und der Regen bliebe in der Luft haengen. Die Taktung steht im
 * Stylesheet; nachts und bei `prefers-reduced-motion` steht alles still.
 *
 * Warum diese Datei getrennt von icons.ts steht: dort wird mit lit gezeichnet,
 * und lit braucht ein Browserfenster. Hier steht nur Rechnung – und die laesst
 * sich in einem Test pruefen, ohne einen Browser zu starten.
 */

/* ------------------------------- Das Feld -------------------------------- */

/** Kantenlaenge des Zeichenfelds, wie bei der Bibliothek. */
export const FIELD = 24;

/** Abstand zum Rand, den jede Form auch in voller Bewegung haelt. */
export const SAFE_MARGIN = 0.3;

/** Strichstaerken. Der Blitz rechnet mit seiner dicksten Stufe. */
const STROKE = 1.5;
const BOLT_STROKE = 2.8;

/**
 * Groesster Ausschlag jeder Bewegung, in Feldeinheiten.
 *
 * Dieselben Zahlen stehen als Keyframes im Stylesheet der Anzeige. Sie doppelt
 * zu fuehren ist der Preis dafuer, dass hier ohne Browser gerechnet werden
 * kann – und eine Rechnung, die sich ihre Zahlen selbst gibt, waere keine
 * Pruefung.
 */
export const REACH = {
  /** Die Wolke zieht, und alles an ihr zieht mit. */
  drift: { x: 1.1, up: 0.25, down: 0.25 },
  /** Tropfen und Flocken fallen. */
  fall: { x: 0, up: 1.6, down: 2.4 },
  /** Nebelschwaden schieben sich zur Seite. */
  haze: { x: 1.8, up: 0, down: 0 },
} as const;

/** Wie stark der Atem skaliert – er wirkt um die Feldmitte. */
const PULSE_SCALE = 1.08;

type Move = keyof typeof REACH | 'pulse';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Ein Stueck Zeichnung samt allem, was es ueber sich selbst wissen muss.
 *
 * `moves` sind *alle* Bewegungen, die auf das Stueck wirken – die eigene und
 * die geerbte. Ein Tropfen in der Wolkengruppe faellt und driftet.
 */
export interface Piece {
  d: string;
  /** Klasse fuer das Stylesheet; leer heisst: bewegt sich nicht. */
  cls: string;
  moves: readonly Move[];
  stroke: number;
  /** Die Zeichnung selbst, ohne Strich und ohne Bewegung. */
  box: Box;
  /** Feste Verschiebung oder Verkleinerung, etwa fuer den kleinen Mond. */
  transform?: string;
  /**
   * Flocken taumeln beim Fallen und brauchen dafuer eine zweite Gruppe – samt
   * eigenem Drehpunkt: ohne ihn dreht SVG um den Ursprung des Feldes, und die
   * Flocke schwingt aus dem Bild.
   */
  tumble?: { x: number; y: number };
}

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});

const merge = (a: Box, b: Box): Box =>
  box(
    Math.min(a.left, b.left),
    Math.min(a.top, b.top),
    Math.max(a.right, b.right),
    Math.max(a.bottom, b.bottom),
  );

/** Der Platz, den ein Stueck braucht: Zeichnung, Strich und Bewegung. */
function reachOf(piece: Piece): Box {
  const half = piece.stroke / 2;
  let result = box(
    piece.box.left - half,
    piece.box.top - half,
    piece.box.right + half,
    piece.box.bottom + half,
  );
  for (const move of piece.moves) {
    if (move === 'pulse') {
      const mid = FIELD / 2;
      result = box(
        mid - (mid - result.left) * PULSE_SCALE,
        mid - (mid - result.top) * PULSE_SCALE,
        mid + (result.right - mid) * PULSE_SCALE,
        mid + (result.bottom - mid) * PULSE_SCALE,
      );
      continue;
    }
    const r = REACH[move];
    result = box(result.left - r.x, result.top - r.up, result.right + r.x, result.bottom + r.down);
  }
  return result;
}

/* -------------------------------- Wolken --------------------------------- */

interface Lobe {
  x: number;
  y: number;
  r: number;
}

/** Eine Wolke: drei Kuppen ueber einer Grundlinie. */
export interface CloudSpec {
  left: Lobe;
  top: Lobe;
  right: Lobe;
  base: number;
}

const round = (n: number): string => Number(n.toFixed(2)).toString();

interface Point {
  x: number;
  y: number;
}

/** Der obere der beiden Schnittpunkte zweier Kuppen. */
function meet(a: Lobe, b: Lobe): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const t = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(a.r * a.r - t * t);
  const mx = a.x + (t * dx) / d;
  const my = a.y + (t * dy) / d;
  const one = { x: mx + (h * dy) / d, y: my - (h * dx) / d };
  const two = { x: mx - (h * dy) / d, y: my + (h * dx) / d };
  return one.y < two.y ? one : two;
}

/**
 * Ein Bogen im Uhrzeigersinn.
 *
 * Ob er den langen oder den kurzen Weg nimmt, faellt aus dem ueberstrichenen
 * Winkel – geraten wird hier nichts mehr.
 *
 * Und der Radius wird notfalls aufgerundet: die Endpunkte stehen im Pfad mit
 * zwei Nachkommastellen, und dadurch kann die Sehne um ein Tausendstel laenger
 * werden als der Durchmesser. SVG vergroessert den Radius dann stillschweigend
 * selbst – genau die Stelle, an der der erste Symbolsatz aus dem Ruder lief.
 * Lieber eine Zahl im Pfad, die stimmt, als eine, die der Browser korrigiert.
 */
function arc(lobe: Lobe, from: Point, to: Point): string {
  const angle = (p: Point): number => Math.atan2(p.y - lobe.y, p.x - lobe.x);
  let swept = angle(to) - angle(from);
  while (swept <= 0) swept += Math.PI * 2;
  const large = swept > Math.PI ? 1 : 0;
  const half = Math.hypot(to.x - from.x, to.y - from.y) / 2;
  const r = half > lobe.r ? Math.ceil(half * 100) / 100 : lobe.r;
  return `A${round(r)} ${round(r)} 0 ${large} 1 ${round(to.x)} ${round(to.y)}`;
}

/**
 * Die Kontur einer Wolke: am Boden nach links, dann ueber die drei Kuppen.
 *
 * Gerechnet wird mit den Punkten, die auch im Pfad stehen – also gerundet.
 * Sonst pruefte der Bogen oben eine Sehne, die es im fertigen Pfad gar nicht
 * gibt.
 */
export function cloudPath(spec: CloudSpec): string {
  const at = (p: Point): Point => ({ x: Number(round(p.x)), y: Number(round(p.y)) });
  const start = at({ x: spec.left.x, y: spec.base });
  const end = at({ x: spec.right.x, y: spec.base });
  const leftTop = at(meet(spec.left, spec.top));
  const topRight = at(meet(spec.top, spec.right));
  return [
    `M${round(end.x)} ${round(end.y)}`,
    `H${round(start.x)}`,
    arc(spec.left, start, leftTop),
    arc(spec.top, leftTop, topRight),
    arc(spec.right, topRight, end),
    'Z',
  ].join('');
}

/**
 * Der Platz, den eine Wolke belegt – grosszuegig gerechnet.
 *
 * Die Kreise sind eine Obergrenze fuer die Kontur: sie kann nie weiter nach
 * aussen reichen als ihre Kuppen. Fuer eine Sicherheitsrechnung ist die
 * Obergrenze genau das Richtige.
 */
export function cloudBox(spec: CloudSpec): Box {
  const lobes = [spec.left, spec.top, spec.right];
  return box(
    Math.min(...lobes.map((l) => l.x - l.r)),
    Math.min(...lobes.map((l) => l.y - l.r)),
    Math.max(...lobes.map((l) => l.x + l.r)),
    Math.max(spec.base, ...lobes.map((l) => l.y + l.r)),
  );
}

/**
 * Die vier Wolken des Satzes.
 *
 * Alle liegen so im Feld, dass Drift und Strichstaerke noch hineinpassen –
 * geprueft in modules/weather/test/icons.test.mjs.
 */
export const CLOUDS = {
  /** Volle Wolke, tief gesetzt: darunter kommt nichts. */
  low: {
    left: { x: 8.4, y: 12.9, r: 5.2 },
    top: { x: 13.4, y: 10.2, r: 4.2 },
    right: { x: 17.3, y: 15, r: 3.1 },
    base: 18.1,
  },
  /** Dieselbe Wolke, hoch gesetzt: darunter ist Platz fuer Niederschlag. */
  high: {
    left: { x: 8.6, y: 9.4, r: 4.6 },
    top: { x: 13, y: 7.2, r: 3.7 },
    right: { x: 16.6, y: 11.4, r: 2.7 },
    base: 14.1,
  },
  /** Kleiner und nach rechts unten geschoben: davor steht Sonne oder Mond. */
  small: {
    left: { x: 11.6, y: 15.4, r: 4 },
    top: { x: 15.2, y: 13.6, r: 3.1 },
    right: { x: 18, y: 16.5, r: 2.3 },
    base: 19.4,
  },
  /** Die vordere Wolke bei "bedeckt". */
  front: {
    left: { x: 10.6, y: 14.6, r: 4.4 },
    top: { x: 14.6, y: 12.4, r: 3.5 },
    right: { x: 17.9, y: 16, r: 2.6 },
    base: 19,
  },
} as const satisfies Record<string, CloudSpec>;

/**
 * Die zweite Wolke hinter der ersten – der ganze Unterschied zwischen
 * "bewoelkt" und "bedeckt".
 *
 * Als offener Bogen und nicht als geschlossene Form: eine zweite volle Wolke
 * verdeckte die erste zur Haelfte, und weil hier nichts gefuellt ist (eine
 * Flaeche wuerde hinter dem Glas leuchten), gaebe das ein Knaeuel aus Linien.
 * Ein Bogen, der oben links hervorschaut, liest sich dagegen sofort als
 * "da ist noch mehr Himmel zu".
 */
const BEHIND = {
  d: 'M2.9 11.8A3.6 3.6 0 0 1 6 6.2a4.8 4.8 0 0 1 8.2-1',
  box: box(2.9, 3.7, 14.2, 11.8),
};

/* ------------------------------ Niederschlag ------------------------------ */

/** Die drei Plaetze, an denen etwas aus der Wolke faellt. */
const COLUMNS = [8.6, 12, 15.4] as const;

/** Und die drei Plaetze der Blitze – etwas enger, weil sie breiter sind. */
const BOLT_COLUMNS = [8.8, 12.2, 15.6] as const;

/** Oberkante des Niederschlags, knapp unter der Wolke. */
const FALL_TOP = 16.2;

function drops(length: number): Piece[] {
  return COLUMNS.map((x) => ({
    d: `M${x} ${FALL_TOP}v${length}`,
    cls: 'weather__fall',
    moves: ['drift', 'fall'] as const,
    stroke: STROKE,
    box: box(x, FALL_TOP, x, FALL_TOP + length),
  }));
}

/**
 * Drei Flocken, sechsstrahlig und auf zwei Hoehen.
 *
 * Sechs Arme statt acht, weil acht bei drei Flocken nebeneinander zu einem
 * Knaeuel verschmelzen. Und versetzt statt in einer Reihe: drei Flocken auf
 * einer Linie sind eine Perlenkette, drei auf zwei Hoehen sind Schneefall.
 */
function flakes(): Piece[] {
  const r = 1.3;
  const rows = [17.6, 19, 17.6];
  return COLUMNS.map((x, index) => {
    const y = rows[index] as number;
    return {
      d:
        `M${x} ${round(y - r)}v${round(2 * r)}` +
        `M${round(x - 0.87 * r)} ${round(y - 0.5 * r)}l${round(1.74 * r)} ${r}` +
        `M${round(x + 0.87 * r)} ${round(y - 0.5 * r)}l${round(-1.74 * r)} ${r}`,
      cls: 'weather__fall',
      moves: ['drift', 'fall'] as const,
      stroke: STROKE,
      box: box(x - r, y - r, x + r, y + r),
      tumble: { x, y },
    };
  });
}

/**
 * Drei kleine Blitze statt eines grossen.
 *
 * Sie sind nur da, wenn sie schlagen. Damit die Wolke trotzdem als
 * Gewitterwolke lesbar bleibt, hat jeder eine eigene Dauer; weil die drei
 * keinen gemeinsamen Takt haben, wiederholt sich das Muster erst nach Minuten,
 * und fast immer zuckt irgendwo einer. Das ist so nah an Zufall, wie CSS
 * kommt – und naeher, als man im Vorbeigehen unterscheiden koennte.
 */
function bolts(): Piece[] {
  const top = 15;
  const middle = 17.9;
  const bottom = 20.8;
  return BOLT_COLUMNS.map((x) => ({
    d: `M${round(x + 1)} ${top}L${round(x - 0.9)} ${middle}H${round(x + 0.7)}L${round(x - 1)} ${bottom}`,
    cls: 'weather__bolt',
    moves: ['drift'] as const,
    stroke: BOLT_STROKE,
    box: box(x - 1, top, x + 1, bottom),
  }));
}

function haze(): Piece[] {
  const lines: readonly (readonly [number, number, number])[] = [
    [5.4, 18.6, 17.6],
    [7.8, 16.2, 20.4],
    [4.6, 6.4, 20.4],
  ];
  return lines.map(([from, to, y]) => ({
    d: `M${from} ${y}H${to}`,
    cls: 'weather__haze',
    moves: ['drift', 'haze'] as const,
    stroke: STROKE,
    box: box(from, y, to, y),
  }));
}

/* --------------------------- Sonne, Mond, Wolke --------------------------- */

/** Acht Strahlen um einen Mittelpunkt. */
function rays(cx: number, cy: number, from: number, to: number): Piece {
  let d = '';
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    d +=
      `M${round(cx + Math.cos(angle) * from)} ${round(cy + Math.sin(angle) * from)}` +
      `L${round(cx + Math.cos(angle) * to)} ${round(cy + Math.sin(angle) * to)}`;
  }
  return {
    d,
    cls: 'weather__rays',
    /* Die Drehung geht um den eigenen Mittelpunkt und braucht keinen Platz. */
    moves: [],
    stroke: STROKE,
    box: box(cx - to, cy - to, cx + to, cy + to),
  };
}

/** Ein Kreis als Pfad – damit jedes Stueck des Satzes dieselbe Form hat. */
function disc(cx: number, cy: number, r: number, cls = '', moves: readonly Move[] = []): Piece {
  return {
    d: `M${round(cx - r)} ${cy}a${r} ${r} 0 1 0 ${round(2 * r)} 0a${r} ${r} 0 1 0 ${round(-2 * r)} 0Z`,
    cls,
    moves,
    stroke: STROKE,
    box: box(cx - r, cy - r, cx + r, cy + r),
  };
}

/**
 * Der Mond als Sichel aus zwei Boegen.
 *
 * Der aeussere Bogen liegt im Kreis um (12.08, 11.92) mit Radius 8.8 – daraus
 * faellt sein Platzbedarf, ohne dass jemand die Sichel ausmessen muesste.
 */
const MOON_D = 'M20.4 14.8A8.8 8.8 0 1 1 9.2 3.6a7 7 0 0 0 11.2 11.2Z';
const MOON_BOX = box(3.28, 3.12, 20.88, 20.72);

/** Derselbe Mond, klein und nach oben links geschoben – hinter der Wolke. */
const MOON_SMALL = { scale: 0.55, dx: 2.4, dy: 0.6 };

const scaled = (b: Box, s: number, dx: number, dy: number): Box =>
  box(b.left * s + dx, b.top * s + dy, b.right * s + dx, b.bottom * s + dy);

/* --------------------------------- Symbole -------------------------------- */

/**
 * Woraus ein Symbol besteht.
 *
 * `sky` ist die Wolke samt allem, was aus ihr faellt – sie stehen in einer
 * Gruppe und ziehen gemeinsam. `behind` liegt dahinter und wird von der Wolke
 * ausgestanzt, `loose` steht fuer sich.
 */
export interface Glyph {
  sky?: { spec: CloudSpec; fallout?: Piece[] };
  behind?: Piece[];
  loose?: Piece[];
}

export function glyphOf(name: IconName): Glyph {
  switch (name) {
    case 'sun':
      return { loose: [rays(12, 12, 6.4, 9.4), disc(12, 12, 4.2, 'weather__pulse', ['pulse'])] };

    case 'moon':
      return {
        loose: [
          { d: MOON_D, cls: 'weather__pulse', moves: ['pulse'], stroke: STROKE, box: MOON_BOX },
        ],
      };

    case 'cloud-sun':
      return {
        sky: { spec: CLOUDS.small },
        behind: [rays(8.4, 8.2, 4.4, 6.8), disc(8.4, 8.2, 2.7)],
      };

    case 'cloud-moon':
      return {
        sky: { spec: CLOUDS.small },
        behind: [
          {
            d: MOON_D,
            cls: '',
            moves: [],
            /* Im verkleinerten Mond wuerde der Strich mitschrumpfen. */
            stroke: STROKE / MOON_SMALL.scale,
            transform: `translate(${MOON_SMALL.dx} ${MOON_SMALL.dy}) scale(${MOON_SMALL.scale})`,
            box: scaled(MOON_BOX, MOON_SMALL.scale, MOON_SMALL.dx, MOON_SMALL.dy),
          },
        ],
      };

    /* Bedeckt: zwei Wolken. Sonst waere es dasselbe Bild wie "bewoelkt". */
    case 'cloudy':
      return {
        sky: { spec: CLOUDS.front },
        behind: [
          { d: BEHIND.d, cls: 'weather__behind', moves: ['drift'], stroke: STROKE, box: BEHIND.box },
        ],
      };

    case 'cloud-fog':
      return { sky: { spec: CLOUDS.high, fallout: haze() } };

    case 'cloud-drizzle':
      return { sky: { spec: CLOUDS.high, fallout: drops(1.8) } };

    case 'cloud-rain':
      return { sky: { spec: CLOUDS.high, fallout: drops(3.6) } };

    case 'cloud-hail':
      return {
        sky: {
          spec: CLOUDS.high,
          fallout: [
            {
              d: `M${COLUMNS[0]} ${FALL_TOP}v2.8`,
              cls: 'weather__fall',
              moves: ['drift', 'fall'],
              stroke: STROKE,
              box: box(COLUMNS[0], FALL_TOP, COLUMNS[0], FALL_TOP + 2.8),
            },
            disc(COLUMNS[1], 18.8, 1.1, 'weather__fall', ['drift', 'fall']),
            {
              d: `M${COLUMNS[2]} ${FALL_TOP}v2.8`,
              cls: 'weather__fall',
              moves: ['drift', 'fall'],
              stroke: STROKE,
              box: box(COLUMNS[2], FALL_TOP, COLUMNS[2], FALL_TOP + 2.8),
            },
          ],
        },
      };

    case 'cloud-snow':
      return { sky: { spec: CLOUDS.high, fallout: flakes() } };

    case 'snowflake':
      return {
        loose: [
          {
            d:
              'M12 3.4v17.2M4.9 7.5l14.2 8.6M19.1 7.5 4.9 16.1' +
              'M12 6.9 9.6 4.7M12 6.9l2.4-2.2M12 17.1l-2.4 2.2M12 17.1l2.4 2.2',
            cls: 'weather__rays',
            moves: [],
            stroke: STROKE,
            box: box(4.9, 3.4, 19.1, 20.6),
          },
        ],
      };

    case 'cloud-lightning':
      return { sky: { spec: CLOUDS.high, fallout: bolts() } };

    /* Unbekannter Code heisst nicht "kein Wetter": lieber eine Wolke als eine
       Luecke im Layout. */
    default:
      return { sky: { spec: CLOUDS.low } };
  }
}

/**
 * Der Platz, den ein Symbol in voller Bewegung braucht.
 *
 * Gebraucht vom Test, der ihn gegen das Feld haelt. Genau diese Rechnung hat
 * beim ersten Satz gefehlt: die Wolken standen ueber der Kante, und aufgefallen
 * ist es erst, als die Bewegung staerker wurde.
 */
export function glyphBox(name: IconName): Box {
  const glyph = glyphOf(name);
  const cloudPiece: Piece[] = glyph.sky
    ? [
        {
          d: '',
          cls: 'weather__sky',
          moves: ['drift'],
          stroke: STROKE,
          box: cloudBox(glyph.sky.spec),
        },
      ]
    : [];
  const pieces = [
    ...(glyph.behind ?? []),
    ...cloudPiece,
    ...(glyph.sky?.fallout ?? []),
    ...(glyph.loose ?? []),
  ];
  return pieces.map(reachOf).reduce(merge);
}

