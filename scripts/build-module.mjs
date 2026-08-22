#!/usr/bin/env node
/**
 * Baut ein Modul zu zwei in sich geschlossenen Dateien:
 *
 *   dist/backend.js   ESM fuer Node, laeuft im Core
 *   dist/frontend.js  ESM fuer den Browser, wird der Anzeige zur Laufzeit geliefert
 *
 * Beide werden gebuendelt, inklusive aller Abhaengigkeiten. Ein Modul ist damit
 * eine abgeschlossene Einheit ohne eigenes node_modules – das ist die
 * Voraussetzung dafuer, Module spaeter einzeln nachinstallieren zu koennen.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { build } from 'esbuild';

const moduleDir = process.cwd();
const name = basename(moduleDir);

const targets = [
  {
    entry: resolve(moduleDir, 'src/backend.ts'),
    outfile: resolve(moduleDir, 'dist/backend.js'),
    platform: 'node',
    target: 'node22',
  },
  {
    entry: resolve(moduleDir, 'src/frontend.ts'),
    outfile: resolve(moduleDir, 'dist/frontend.js'),
    platform: 'browser',
    target: 'es2022',
  },
  // Dazu jede weitere Datei aus src/ einzeln. Sie steckt in den beiden
  // Bundles oben ohnehin mit drin und waere von aussen nicht erreichbar – als
  // eigene Datei laesst sie sich pruefen. Das ist der einzige Grund dafuer:
  // ein Modul, dessen reine Rechnungen niemand testen kann, faellt erst auf
  // dem fertigen Spiegel auf.
  ...readdirSync(resolve(moduleDir, 'src'))
    .filter((file) => file.endsWith('.ts') && !['backend.ts', 'frontend.ts'].includes(file))
    .map((file) => ({
      entry: resolve(moduleDir, 'src', file),
      outfile: resolve(moduleDir, 'dist', file.replace(/\.ts$/, '.js')),
      platform: 'neutral',
      target: 'es2022',
    })),
];

let built = 0;
for (const target of targets) {
  if (!existsSync(target.entry)) continue;
  await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    format: 'esm',
    platform: target.platform,
    target: target.target,
    sourcemap: true,
    // Lesbar halten: der haeufigste Debug-Fall ist ein Modul, das auf dem Pi
    // anders laeuft als am Schreibtisch, und dann will man Stacktraces lesen.
    minify: false,
    logLevel: 'warning',
  });
  built += 1;
}

// Node muss wissen, dass die Bundles ESM sind. Ohne diese Markierung versucht
// es sie als CommonJS zu lesen und warnt bei jedem Modulstart.
await mkdir(resolve(moduleDir, 'dist'), { recursive: true });
await writeFile(resolve(moduleDir, 'dist/package.json'), '{ "type": "module" }\n', 'utf8');

if (built === 0) {
  console.error(`[${name}] Weder src/backend.ts noch src/frontend.ts gefunden.`);
  process.exit(1);
}
console.log(`[${name}] ${built} Bundle(s) gebaut.`);
