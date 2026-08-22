import { svg, nothing, type SVGTemplateResult } from 'lit';
import type { IconName } from '@mirror/icons';
import { FIELD, cloudPath, glyphOf, type CloudSpec, type Piece } from './glyphs.js';

/**
 * Die Wettersymbole, gezeichnet.
 *
 * Woraus sie bestehen, steht in glyphs.ts – hier wird daraus SVG. Der Schnitt
 * laeuft entlang der Frage, wer einen Browser braucht: die Rechnung nicht, das
 * Zeichnen schon, und nur so laesst sich die Rechnung pruefen.
 */

/** Strichstaerke des Satzes; dickere Stuecke bringen ihre eigene mit. */
const STROKE = 1.5;

/* -------------------------------- Zeichnen -------------------------------- */

/**
 * Fortlaufende Nummer fuer die Schablonen.
 *
 * Zwei Symbole derselben Art koennen gleichzeitig auf dem Spiegel stehen – mit
 * derselben Kennung griffe die zweite Schablone auf die erste zu, und weil die
 * Schablone mit *ihrer* Wolke driftet, saesse sie an der falschen Stelle.
 */
let maskSeq = 0;

function draw(piece: Piece): SVGTemplateResult {
  const path = svg`<path
    class=${piece.tumble ? nothing : piece.cls || nothing}
    d=${piece.d}
    transform=${piece.transform ?? nothing}
    stroke-width=${piece.stroke === STROKE ? nothing : piece.stroke}
  />`;
  if (!piece.tumble) return path;
  /*
   * Zwei Gruppen: die aeussere faellt, die innere dreht sich. Beide auf einer
   * Gruppe waeren zwei Animationen auf derselben Eigenschaft. Der Drehpunkt
   * steht am Element, weil ihn nur die Form kennt – im Stylesheet waere er
   * eine Zahl, die zur Flocke passen muss und es irgendwann nicht mehr tut.
   */
  return svg`<g class=${piece.cls}>
    <g class="weather__tumble" style=${`transform-origin:${piece.tumble.x}px ${piece.tumble.y}px`}>
      ${path}
    </g>
  </g>`;
}

/**
 * Was hinter der Wolke liegt, ist hinter der Wolke.
 *
 * Die Symbole sind ungefuellte Striche – eine Flaeche waere hinter dem Glas ein
 * Leuchtfeld. Also scheinen Sonne und Mond durch die Wolke hindurch, und aus
 * "teilweise bewoelkt" wird ein Knaeuel. Eine Schablone loest das ohne
 * Fuellung: sie ist kein Farbauftrag, sondern eine Maske, und die
 * Wolkensilhouette steht darin auf "hier nicht zeichnen".
 *
 * Ihr Strich ist doppelt so dick wie der sichtbare, damit zwischen Strahl und
 * Wolkenkante ein schmaler Spalt bleibt statt einer verschmolzenen Linie. Und
 * sie traegt dieselbe Klasse wie die sichtbare Wolke – sonst driftete die Wolke
 * davon und die Sonne kaeme an ihrem Rand wieder hervor.
 */
function occlude(pieces: readonly Piece[], spec: CloudSpec): SVGTemplateResult {
  maskSeq += 1;
  const id = `weather-mask-${maskSeq}`;
  return svg`<defs>
      <mask id=${id} maskUnits="userSpaceOnUse" x="0" y="0" width=${FIELD} height=${FIELD}>
        <rect x="0" y="0" width=${FIELD} height=${FIELD} fill="#fff" />
        <path
          class="weather__sky"
          d=${cloudPath(spec)}
          fill="#000"
          stroke="#000"
          stroke-width=${STROKE * 2}
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </mask>
    </defs>
    <g mask=${`url(#${id})`}>${pieces.map(draw)}</g>`;
}

function render(name: IconName): SVGTemplateResult[] {
  const glyph = glyphOf(name);
  const out: SVGTemplateResult[] = [];

  if (glyph.behind) {
    out.push(
      glyph.sky ? occlude(glyph.behind, glyph.sky.spec) : svg`${glyph.behind.map(draw)}`,
    );
  }

  if (glyph.sky) {
    /* Wolke und Niederschlag in einer Gruppe: sonst driftete die Wolke davon
       und die Tropfen blieben in der Luft haengen. */
    out.push(svg`<g class="weather__sky">
      <path d=${cloudPath(glyph.sky.spec)} />
      ${(glyph.sky.fallout ?? []).map(draw)}
    </g>`);
  }

  out.push(...(glyph.loose ?? []).map(draw));
  return out;
}

export interface GlyphOptions {
  size?: number | string;
  strokeWidth?: number;
  /**
   * Bewegung. Aus fuer die kleinen Symbole der Vorschau: eine Reihe aus vier
   * driftenden Wolken in Fussnotengroesse ist Flimmern, keine Auskunft.
   */
  animated?: boolean;
  title?: string;
}

/**
 * Ein Wettersymbol.
 *
 * `currentColor` und keine Fuellung – wie bei jedem anderen Symbol der Anzeige,
 * damit es die Farbe seiner Umgebung annimmt und nachts mit abgedunkelt wird.
 */
export function weatherGlyph(name: IconName, options: GlyphOptions = {}): SVGTemplateResult {
  const size = typeof options.size === 'number' ? `${options.size}px` : (options.size ?? '1em');
  const classes = `icon weather__glyph${options.animated === false ? '' : ' is-alive'}`;

  return svg`<svg
    xmlns="http://www.w3.org/2000/svg"
    width=${size}
    height=${size}
    viewBox=${`0 0 ${FIELD} ${FIELD}`}
    fill="none"
    stroke="currentColor"
    stroke-width=${options.strokeWidth ?? STROKE}
    stroke-linecap="round"
    stroke-linejoin="round"
    class=${classes}
    role=${options.title ? 'img' : 'presentation'}
    aria-hidden=${options.title ? 'false' : 'true'}
  >${options.title ? svg`<title>${options.title}</title>` : nothing}${render(name)}</svg>`;
}
