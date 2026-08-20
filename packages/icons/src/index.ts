import { svg, type SVGTemplateResult } from 'lit';
import { ICONS, type IconName, type IconNode } from './generated.js';

export { ICONS, type IconName, type IconNode };

export interface IconOptions {
  /** Kantenlaenge in CSS-Einheiten. Zahlen werden als Pixel gedeutet. */
  size?: number | string;
  /**
   * Strichstaerke, bezogen auf das 24er-Raster.
   *
   * Der Standard liegt unter Lucides 2, weil Symbole auf dem Spiegel sehr
   * gross dargestellt werden: bei 3 rem wirkt Strichstaerke 2 klobig und
   * leuchtet zu stark durch die Spiegelfolie.
   */
  strokeWidth?: number;
  class?: string;
  title?: string;
}

/**
 * Baut ein flaches Strichsymbol.
 *
 * Bewusst ohne Fuellung und in `currentColor`: so nimmt jedes Symbol die
 * Textfarbe seiner Umgebung an und passt automatisch zur Abdunklung des
 * Spiegels. Farbige Emoji-Glyphen, wie sie ein System sonst einsetzt, wuerden
 * hinter dem Halbspiegel unruhig und bunt wirken.
 */
export function icon(name: IconName, options: IconOptions = {}): SVGTemplateResult {
  const size = typeof options.size === 'number' ? `${options.size}px` : (options.size ?? '1em');
  const strokeWidth = options.strokeWidth ?? 1.75;
  const nodes = ICONS[name] as readonly IconNode[];

  return svg`<svg
    xmlns="http://www.w3.org/2000/svg"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    class=${options.class ?? 'icon'}
    role=${options.title ? 'img' : 'presentation'}
    aria-hidden=${options.title ? 'false' : 'true'}
  >${options.title ? svg`<title>${options.title}</title>` : ''}${nodes.map(renderNode)}</svg>`;
}

/**
 * Lit kann Elementnamen nicht dynamisch einsetzen, deshalb pro Tag ein
 * eigener Zweig. Die erzeugten Symbole nutzen nur diese vier.
 */
function renderNode(node: IconNode): SVGTemplateResult {
  const a = node.attrs;
  switch (node.tag) {
    case 'path':
      return svg`<path d=${a.d ?? ''} />`;
    case 'circle':
      return svg`<circle cx=${a.cx ?? '0'} cy=${a.cy ?? '0'} r=${a.r ?? '0'} />`;
    case 'rect':
      return svg`<rect x=${a.x ?? '0'} y=${a.y ?? '0'} width=${a.width ?? '0'} height=${a.height ?? '0'} rx=${a.rx ?? '0'} ry=${a.ry ?? a.rx ?? '0'} />`;
    case 'polyline':
      return svg`<polyline points=${a.points ?? ''} />`;
    default:
      // Nicht stillschweigend nichts zeichnen: sonst faellt ein neues Symbol
      // mit unbekanntem Element erst auf dem fertigen Spiegel auf.
      throw new Error(`Icon-Element "${node.tag}" wird nicht unterstuetzt`);
  }
}

export function hasIcon(name: string): name is IconName {
  return name in ICONS;
}
