import { svg, nothing, type SVGTemplateResult } from 'lit';
import type { IconName } from '@mirror/icons';

/**
 * Die Wettersymbole des Moduls – von Hand gezeichnet und in Bewegung.
 *
 * Warum nicht die Bibliothek? Weil ein Wettersymbol auf diesem Spiegel kein
 * Symbol mehr ist. Es steht bei 155 px neben einer Zahl von 106 und ist die
 * Angabe, die man aus drei Metern zuerst erfasst – schneller als jede Zahl.
 * In dieser Groesse faellt auf, dass die Bibliotheksformen fuer 24 px gedacht
 * sind: "bedeckt" ist dort dieselbe einzelne Wolke wie "bewoelkt", und der
 * Blitz ist ein Haken, den man neben der Wolke kaum findet.
 *
 * Also ein eigener Satz, gebaut aus zwei Teilen: einem Himmel (Sonne, Mond,
 * Wolke, zwei Wolken) und einem Niederschlag (Tropfen, Flocken, Blitz,
 * Schwaden). Dieselben dreizehn Namen wie in der Bibliothek, damit
 * describeWeather() unveraendert bleibt und der Rest des Moduls nichts von
 * dem Wechsel merkt.
 *
 * Bewegt wird immer nur ein Teil und nie das ganze Symbol: die Strahlen
 * drehen, die Wolke driftet, die Tropfen fallen. Die Taktung steht im
 * Stylesheet – nachts und bei `prefers-reduced-motion` steht alles still.
 */

/** Das 24er-Raster der Bibliothek, damit beide Saetze nebeneinander passen. */
const BOX = 24;

/* --------------------------------- Himmel --------------------------------- */

/**
 * Die Wolke, tief gesetzt: sie fuellt das Feld, weil unter ihr nichts kommt.
 */
const CLOUD_LOW =
  'M17.6 18.4H8.4A4.9 4.9 0 0 1 8.8 8.6a6.4 6.4 0 0 1 12 2.3 3.8 3.8 0 0 1-3.2 7.5Z';

/** Dieselbe Wolke, fuer "bedeckt" nach rechts unten geschoben. */
const CLOUD_FRONT =
  'M18.8 19.8h-8.6A4.4 4.4 0 0 1 10.6 11a5.8 5.8 0 0 1 10.8 2.1 3.5 3.5 0 0 1-2.6 6.7Z';

/**
 * Dieselbe Wolke, hoch gesetzt: darunter ist Platz fuer Tropfen, Flocken oder
 * einen Blitz. Eine zweite Form waere eine zweite Wolke – und dann saehe
 * "Regen" nach einem anderen Wetter aus als "bedeckt".
 */
const CLOUD_HIGH =
  'M17.6 14.2H8.4A4.4 4.4 0 0 1 8.8 5.4a5.8 5.8 0 0 1 10.9 2.1 3.5 3.5 0 0 1-2.1 6.7Z';

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
const CLOUD_BEHIND = 'M2.4 11.4A3.5 3.5 0 0 1 5.4 5.9a4.7 4.7 0 0 1 8.2-1.1';

/** Acht Strahlen um einen Mittelpunkt. */
function rays(cx: number, cy: number, from: number, to: number): string {
  let d = '';
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(angle) * from;
    const y1 = cy + Math.sin(angle) * from;
    const x2 = cx + Math.cos(angle) * to;
    const y2 = cy + Math.sin(angle) * to;
    d += `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return d;
}

/* ------------------------------ Niederschlag ------------------------------ */

/**
 * Fallende Striche unter der Wolke.
 *
 * Jeder bekommt seine eigene Gruppe, damit das Stylesheet sie ueber
 * `nth-of-type` versetzt starten lassen kann – drei Tropfen im Gleichschritt
 * waeren ein Vorhang und kein Regen.
 */
function drops(length: number, xs: readonly number[]): SVGTemplateResult[] {
  return xs.map(
    (x) => svg`<path class="weather__fall" d=${`M${x} 16.4v${length}`} />`,
  );
}

/**
 * Drei Flocken, sechsstrahlig und auf zwei Hoehen.
 *
 * Sechs Arme statt acht, weil acht bei drei Flocken nebeneinander zu einem
 * Knaeuel verschmelzen. Und versetzt statt in einer Reihe: drei Flocken auf
 * einer Linie sind eine Perlenkette, drei auf zwei Hoehen sind Schneefall.
 */
function flakes(points: readonly (readonly [number, number])[]): SVGTemplateResult[] {
  const r = 1.3;
  const arm = ([x, y]: readonly [number, number]): string =>
    `M${x} ${(y - r).toFixed(2)}v${(2 * r).toFixed(2)}` +
    `M${(x - 0.87 * r).toFixed(2)} ${(y - 0.5 * r).toFixed(2)}l${(1.74 * r).toFixed(2)} ${r}` +
    `M${(x + 0.87 * r).toFixed(2)} ${(y - 0.5 * r).toFixed(2)}l${(-1.74 * r).toFixed(2)} ${r}`;
  return points.map((point) => svg`<g class="weather__fall"><path d=${arm(point)} /></g>`);
}

/* --------------------------------- Symbole -------------------------------- */

/**
 * Die Teile eines Symbols. `flash` markiert die Symbole, deren Wolke beim
 * Blitz kurz mitleuchtet.
 */
function parts(name: IconName): SVGTemplateResult[] {
  switch (name) {
    case 'sun':
      return [
        svg`<g class="weather__rays"><path d=${rays(12, 12, 6.4, 9.4)} /></g>`,
        svg`<circle class="weather__pulse" cx="12" cy="12" r="4.2" />`,
      ];

    case 'moon':
      return [
        svg`<path class="weather__pulse" d="M20.4 14.8A8.8 8.8 0 1 1 9.2 3.6a7 7 0 0 0 11.2 11.2Z" />`,
      ];

    case 'cloud-sun':
      return [
        svg`<g class="weather__rays" style="transform-origin:8.4px 8.2px"><path d=${rays(8.4, 8.2, 4.4, 6.8)} /></g>`,
        svg`<circle cx="8.4" cy="8.2" r="2.7" />`,
        svg`<g class="weather__sky"><path d="M18.4 19.4h-7.8a4.3 4.3 0 0 1 .3-8.6 5.2 5.2 0 0 1 9.1 2.1 3.3 3.3 0 0 1-1.6 6.5Z" /></g>`,
      ];

    case 'cloud-moon':
      return [
        svg`<g transform="translate(2.4 0.6) scale(0.55)" stroke-width="2.7"><path
          d="M20.4 14.8A8.8 8.8 0 1 1 9.2 3.6a7 7 0 0 0 11.2 11.2Z"
        /></g>`,
        svg`<g class="weather__sky"><path d="M18.4 19.4h-7.8a4.3 4.3 0 0 1 .3-8.6 5.2 5.2 0 0 1 9.1 2.1 3.3 3.3 0 0 1-1.6 6.5Z" /></g>`,
      ];

    /* Bedeckt: zwei Wolken. Sonst waere es dasselbe Bild wie "bewoelkt". */
    case 'cloudy':
      return [
        svg`<path class="weather__behind" d=${CLOUD_BEHIND} />`,
        svg`<g class="weather__sky"><path d=${CLOUD_FRONT} /></g>`,
      ];

    case 'cloud':
      return [svg`<g class="weather__sky"><path d=${CLOUD_LOW} /></g>`];

    case 'cloud-fog':
      return [
        svg`<g class="weather__sky"><path d=${CLOUD_HIGH} /></g>`,
        svg`<path class="weather__haze" d="M4.6 17.8h14.8" />`,
        svg`<path class="weather__haze" d="M7.2 20.8h9.6" />`,
        svg`<path class="weather__haze" d="M3.4 20.8h1.8" />`,
      ];

    case 'cloud-drizzle':
      return [
        svg`<g class="weather__sky"><path d=${CLOUD_HIGH} /></g>`,
        ...drops(2, [8.4, 12, 15.6]),
      ];

    case 'cloud-rain':
      return [
        svg`<g class="weather__sky"><path d=${CLOUD_HIGH} /></g>`,
        ...drops(4.4, [8.4, 12, 15.6]),
      ];

    case 'cloud-hail':
      return [
        svg`<g class="weather__sky"><path d=${CLOUD_HIGH} /></g>`,
        svg`<path class="weather__fall" d="M8.4 16.4v3.4" />`,
        svg`<circle class="weather__fall" cx="12" cy="19" r="1.1" />`,
        svg`<path class="weather__fall" d="M15.6 16.4v3.4" />`,
      ];

    case 'cloud-snow':
      return [
        svg`<g class="weather__sky"><path d=${CLOUD_HIGH} /></g>`,
        ...flakes([
          [8, 18.4],
          [12, 20.2],
          [16, 18.4],
        ]),
      ];

    case 'snowflake':
      return [
        svg`<g class="weather__rays"><path
          d="M12 2.6v18.8M4 7.2l16 9.6M20 7.2 4 16.8M12 6.4 9.4 4M12 6.4 14.6 4M12 17.6 9.4 20M12 17.6l2.6 2.4"
        /></g>`,
      ];

    /*
     * Gewitter: der Blitz ist die Aussage, nicht die Wolke.
     *
     * Er ist deshalb laenger und dicker als alles andere im Satz und faengt
     * schon in der Wolke an. Ein Haken neben der Wolke, wie ihn die Bibliothek
     * zeichnet, verschwindet auf einem Spiegel im Vorbeigehen.
     */
    case 'cloud-lightning':
      return [
        svg`<g class="weather__sky"><path d=${CLOUD_HIGH} /></g>`,
        svg`<path class="weather__bolt" d="M13.8 14.6 9.6 19.4h3l-2 3.2" stroke-width="2.2" />`,
      ];

    default:
      return [svg`<g class="weather__sky"><path d=${CLOUD_LOW} /></g>`];
  }
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
 * `currentColor` und keine Fuellung – wie bei jedem anderen Symbol der
 * Anzeige, damit es die Farbe seiner Umgebung annimmt und nachts mit
 * abgedunkelt wird.
 */
export function weatherGlyph(name: IconName, options: GlyphOptions = {}): SVGTemplateResult {
  const size = typeof options.size === 'number' ? `${options.size}px` : (options.size ?? '1em');
  const classes = `icon weather__glyph${options.animated === false ? '' : ' is-alive'}`;

  return svg`<svg
    xmlns="http://www.w3.org/2000/svg"
    width=${size}
    height=${size}
    viewBox=${`0 0 ${BOX} ${BOX}`}
    fill="none"
    stroke="currentColor"
    stroke-width=${options.strokeWidth ?? 1.5}
    stroke-linecap="round"
    stroke-linejoin="round"
    class=${classes}
    role=${options.title ? 'img' : 'presentation'}
    aria-hidden=${options.title ? 'false' : 'true'}
  >${options.title ? svg`<title>${options.title}</title>` : nothing}${parts(name)}</svg>`;
}
