#!/usr/bin/env node
/**
 * Erzeugt packages/icons/src/generated.ts aus lucide-static.
 *
 * Warum generieren statt lucide zur Laufzeit einzubinden: Module sollen keine
 * Icon-Bibliothek mitschleppen, und die Anzeige darf nichts aus dem Netz
 * nachladen. Hier landet nur die Geometrie der tatsaechlich benutzten Symbole
 * im Quelltext – flach, einfarbig, ohne Fuellung.
 *
 * Lucide steht unter der ISC-Lizenz (https://lucide.dev), die das Mitliefern
 * und Veraendern erlaubt.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = resolve(root, 'node_modules/lucide-static/icons');

/** Bewusst kuratiert: was die mitgelieferten Module brauchen, plus etwas Reserve. */
const WANTED = [
  // Wetter
  'sun', 'moon', 'cloud', 'cloudy', 'cloud-sun', 'cloud-moon', 'cloud-rain',
  'cloud-drizzle', 'cloud-snow', 'cloud-lightning', 'cloud-fog', 'cloud-hail',
  'wind', 'snowflake', 'droplets', 'thermometer', 'sunrise', 'sunset',
  // Musik
  'music', 'pause',
  // Verkehr. Die Abfahrtstafel zeigt das Fahrzeug als Symbol statt als Wort –
  // ob eine "10" ein Bus oder ein Tram ist, weiss sonst nur, wer die Stadt
  // kennt.
  'train-front', 'train-front-tunnel', 'tram-front', 'bus-front', 'ship',
  'cable-car', 'signpost',
  // Allgemein
  'clock', 'timer', 'calendar-days', 'bell', 'triangle-alert', 'wifi-off',
  'refresh-cw', 'octagon-x',
];

/** Zerlegt die Kindelemente eines Lucide-SVG in { tag, attrs }. */
function parseIcon(source) {
  const body = source.slice(source.indexOf('>', source.indexOf('<svg')) + 1, source.lastIndexOf('</svg>'));
  const nodes = [];
  const elementPattern = /<([a-zA-Z]+)\s([^>]*?)\/>/g;
  let match;
  while ((match = elementPattern.exec(body)) !== null) {
    const [, tag, rawAttrs] = match;
    const attrs = {};
    const attrPattern = /([a-zA-Z-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(rawAttrs)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    nodes.push({ tag, attrs });
  }
  if (nodes.length === 0) throw new Error('Keine zeichenbaren Elemente gefunden');
  return nodes;
}

const entries = [];
for (const name of WANTED) {
  const file = resolve(iconsDir, `${name}.svg`);
  const source = await readFile(file, 'utf8');
  entries.push([name, parseIcon(source)]);
}

const body = entries
  .map(([name, nodes]) => `  '${name}': ${JSON.stringify(nodes)},`)
  .join('\n');

await writeFile(
  resolve(root, 'packages/icons/src/generated.ts'),
  `/* Automatisch erzeugt von scripts/generate-icons.mjs – nicht von Hand aendern.
 * Quelle: lucide-static (ISC), https://lucide.dev
 */

export interface IconNode {
  tag: string;
  attrs: Record<string, string>;
}

export const ICONS = {
${body}
} as const satisfies Record<string, IconNode[]>;

export type IconName = keyof typeof ICONS;
`,
  'utf8',
);

console.log(`${entries.length} Icons erzeugt.`);
