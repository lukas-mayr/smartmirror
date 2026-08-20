#!/usr/bin/env node
/**
 * Baut die drei Teile der Anzeige-App:
 *
 *   dist/main/index.cjs      Electron-Hauptprozess (CommonJS – am robustesten
 *                            ueber Electron-Versionen hinweg)
 *   dist/main/preload.cjs    Bruecke zwischen Haupt- und Renderprozess
 *   dist/renderer/*          Oberflaeche, ueber das app://-Schema geladen
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist/renderer'), { recursive: true });

const configs = [
  {
    entryPoints: [resolve(root, 'src/main/index.ts')],
    outfile: resolve(root, 'dist/main/index.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    entryPoints: [resolve(root, 'src/main/preload.ts')],
    outfile: resolve(root, 'dist/main/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    entryPoints: [resolve(root, 'src/renderer/main.ts')],
    outfile: resolve(root, 'dist/renderer/main.js'),
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  },
];

const shared = { bundle: true, sourcemap: true, logLevel: 'info' };

async function copyStatic() {
  for (const file of ['index.html', 'styles.css', 'fonts.css']) {
    await cp(resolve(root, 'src/renderer', file), resolve(root, 'dist/renderer', file));
  }
  // Die Schriftdateien werden mitgeliefert, nicht nachgeladen: der Spiegel muss
  // auch ohne Internet in der richtigen Schrift starten.
  await cp(resolve(root, 'src/renderer/fonts'), resolve(root, 'dist/renderer/fonts'), { recursive: true });
}

if (watch) {
  for (const config of configs) {
    const ctx = await context({ ...shared, ...config });
    await ctx.watch();
  }
  await copyStatic();
  console.log('Anzeige-App im Watch-Modus.');
} else {
  await Promise.all(configs.map((config) => build({ ...shared, ...config })));
  await copyStatic();
  console.log('Anzeige-App gebaut.');
}
