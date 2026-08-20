#!/usr/bin/env node
/**
 * Schnuert das Release-Paket, das der Updater spaeter auf dem Pi auspackt.
 *
 * Ergebnis (dist/bundle/):
 *   VERSION            Versionsnummer, an der der Updater und der Healthcheck haengen
 *   core/index.mjs     Server, gebuendelt – kein node_modules noetig
 *   updater/index.mjs  OTA-Agent, ebenfalls gebuendelt
 *   remote/            gebaute Handy-App
 *   modules/<id>/      Manifest und die beiden Bundles je Modul
 *   shell/             entpackte Electron-Anwendung (nur wenn vorher gebaut)
 *   deploy/            Startskript des Compositors, von der systemd-Unit aufgerufen
 *
 * Warum alles buendeln: ein Release ohne node_modules ist ein Bruchteil so
 * gross, entpackt schneller auf einer SD-Karte und hat keine halb
 * installierten Abhaengigkeiten als Fehlerquelle.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/bundle');

const version =
  process.env.MIRROR_VERSION?.replace(/^v/, '') ??
  JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/* --------------------------- Server und Updater --------------------------- */

// Der Banner ruestet `require` in der ESM-Ausgabe nach. Ohne ihn scheitern
// Abhaengigkeiten wie fastify, die intern noch CommonJS laden.
const REQUIRE_SHIM = "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);";

for (const target of [
  { name: 'core', entry: 'packages/core/dist/index.js' },
  { name: 'updater', entry: 'packages/updater/dist/index.js' },
]) {
  await build({
    entryPoints: [resolve(root, target.entry)],
    outfile: join(out, target.name, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: REQUIRE_SHIM },
    sourcemap: true,
    logLevel: 'warning',
  });
  console.log(`  · ${target.name} gebuendelt`);
}

/* --------------------------------- Module --------------------------------- */

const modulesSource = resolve(root, 'modules');
const moduleNames = (await readdir(modulesSource, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const name of moduleNames) {
  const source = join(modulesSource, name);
  if (!existsSync(join(source, 'module.json'))) continue;
  if (!existsSync(join(source, 'dist'))) {
    throw new Error(`Modul "${name}" wurde nicht gebaut – bitte zuerst "npm run build" ausfuehren.`);
  }
  const target = join(out, 'modules', name);
  await mkdir(target, { recursive: true });
  await cp(join(source, 'module.json'), join(target, 'module.json'));
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
}
console.log(`  · ${moduleNames.length} Module uebernommen`);

/* -------------------------------- Handy-App -------------------------------- */

const remoteDist = resolve(root, 'packages/remote/dist');
if (!existsSync(join(remoteDist, 'index.html'))) {
  throw new Error('Die Handy-App wurde nicht gebaut – bitte zuerst "npm run build" ausfuehren.');
}
await cp(remoteDist, join(out, 'remote'), { recursive: true });
console.log('  · Handy-App uebernommen');

/* --------------------------------- Anzeige --------------------------------- */

// Die Electron-Anwendung wird von electron-builder erzeugt und liegt je nach
// Zielarchitektur in einem eigenen Ordner. Fehlt sie, entsteht trotzdem ein
// Bundle – nuetzlich, um Server und Module ohne Electron-Build zu testen.
const shellCandidates = ['release/linux-arm64-unpacked', 'release/linux-unpacked'].map((candidate) =>
  resolve(root, 'packages/shell', candidate),
);
const shellDir = shellCandidates.find((candidate) => existsSync(candidate));
if (shellDir) {
  await cp(shellDir, join(out, 'shell'), { recursive: true });
  console.log('  · Anzeige-Anwendung uebernommen');
} else {
  console.warn('  ! Anzeige-Anwendung fehlt (electron-builder nicht gelaufen) – Bundle ist unvollstaendig');
}

/* --------------------------- Betriebssystem-Teile --------------------------- */

// Das cage-Startskript liegt im Release, nicht im System: so wird es beim
// Update mitgetauscht und passt immer zur mitgelieferten Anwendung.
await cp(resolve(root, 'deploy'), join(out, 'deploy'), { recursive: true });
console.log('  · deploy/ uebernommen');

/* -------------------------------- Beiwerk --------------------------------- */

await writeFile(join(out, 'VERSION'), `${version}\n`, 'utf8');
await cp(resolve(root, 'LICENSES.md'), join(out, 'LICENSES.md')).catch(() => {});

console.log(`\nBundle fuer Version ${version} liegt in dist/bundle/`);
