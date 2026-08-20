#!/usr/bin/env node
/**
 * Kopiert die woff2-Dateien der mitgelieferten Schriften in die Anzeige-App
 * und erzeugt daraus fonts.css sowie die Auswahlliste fuer das SDK.
 *
 * Ein Skript statt Handarbeit, damit Schriftliste, @font-face-Regeln und die
 * Auswahl in der Handy-App nicht auseinanderlaufen koennen.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FONT_ID, FONT_FALLBACK, FONT_FAMILIES } from './fonts.config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fontsDir = resolve(root, 'packages/shell/src/renderer/fonts');
await mkdir(fontsDir, { recursive: true });

const faces = [];
const licenses = [];

for (const family of FONT_FAMILIES) {
  const packageDir = resolve(root, 'node_modules', family.package);

  for (const weight of family.weights) {
    const file = `${family.id}-latin-${weight}-normal.woff2`;
    await copyFile(resolve(packageDir, 'files', file), resolve(fontsDir, file));
    faces.push(
      [
        '@font-face {',
        `  font-family: '${family.name}';`,
        "  font-style: normal;",
        `  font-weight: ${weight};`,
        // "block" statt "swap": ein kurzer unsichtbarer Moment ist auf einem
        // Spiegel weniger stoerend als ein sichtbarer Schriftwechsel.
        '  font-display: block;',
        `  src: url('./fonts/${file}') format('woff2');`,
        '}',
      ].join('\n'),
    );
  }

  // Familien mit nur einem Schnitt: leichtere Gewichte auf diesen abbilden,
  // damit der Browser die Schrift nicht kuenstlich verduennt.
  if (family.weights.length === 1) {
    const only = family.weights[0];
    const file = `${family.id}-latin-${only}-normal.woff2`;
    for (const alias of [300, 500].filter((weight) => weight !== only)) {
      faces.push(
        [
          '@font-face {',
          `  font-family: '${family.name}';`,
          "  font-style: normal;",
          `  font-weight: ${alias};`,
          '  font-display: block;',
          `  src: url('./fonts/${file}') format('woff2');`,
          '}',
        ].join('\n'),
      );
    }
  }

  const licenseText = await readFile(resolve(packageDir, 'LICENSE'), 'utf8').catch(() => null);
  licenses.push(`${family.name} (${family.package}) – SIL Open Font License 1.1${licenseText ? '' : ' [LICENSE-Datei nicht gefunden]'}`);
}

await writeFile(
  resolve(fontsDir, '../fonts.css'),
  `/* Automatisch erzeugt von scripts/collect-fonts.mjs – nicht von Hand aendern. */\n\n${faces.join('\n\n')}\n`,
  'utf8',
);

const stacks = FONT_FAMILIES.map(
  (family) => `  '${family.id}': "'${family.name}', ${FONT_FALLBACK}",`,
).join('\n');

await writeFile(
  resolve(root, 'packages/sdk/src/fonts.ts'),
  `/* Automatisch erzeugt von scripts/collect-fonts.mjs – nicht von Hand aendern. */

/** Kennung einer mitgelieferten Schriftfamilie. */
export type FontId = ${FONT_FAMILIES.map((family) => `'${family.id}'`).join(' | ')};

export interface FontOption {
  id: FontId;
  name: string;
  note: string;
}

export const FONT_OPTIONS: readonly FontOption[] = [
${FONT_FAMILIES.map((family) => `  { id: '${family.id}', name: '${family.name}', note: ${JSON.stringify(family.note)} },`).join('\n')}
];

/** Vollstaendige CSS-Fallback-Kette je Familie. */
export const FONT_STACKS: Record<FontId, string> = {
${stacks}
};

export const DEFAULT_FONT: FontId = '${DEFAULT_FONT_ID}';
`,
  'utf8',
);

console.log(`${faces.length} @font-face-Regeln erzeugt fuer ${FONT_FAMILIES.length} Familien.`);
console.log(licenses.map((line) => `  · ${line}`).join('\n'));
