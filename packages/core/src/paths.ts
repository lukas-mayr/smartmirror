import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verzeichnis-Aufloesung fuer beide Betriebsarten.
 *
 * Auf dem Pi liegt der Code unter /opt/smartmirror/current – einem Symlink,
 * den der Updater umbiegt – und die Daten daneben unter /opt/smartmirror/data,
 * ausserhalb des Release-Verzeichnisses, damit ein Update sie nie beruehrt.
 * In der Entwicklung landet alles unter .data/ im Repo.
 *
 * Die Wurzel wird gesucht statt fest verdrahtet, weil der Core im Repo als
 * packages/core/dist/index.js liegt und im Release als core/index.mjs – eine
 * feste Anzahl von Ebenen nach oben waere in genau einem der beiden Faelle falsch.
 */

const here = dirname(fileURLToPath(import.meta.url));

function findAppRoot(): string {
  const fromEnv = process.env.MIRROR_APP_ROOT;
  if (fromEnv) return resolve(fromEnv);

  let candidate = here;
  for (let depth = 0; depth < 6; depth += 1) {
    // Ein Release erkennt man an VERSION, das Repo an der Modulsammlung.
    if (existsSync(join(candidate, 'VERSION')) || existsSync(join(candidate, 'modules'))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return resolve(here, '..');
}

export const appRoot = findAppRoot();

export const isProduction =
  process.env.NODE_ENV === 'production' || existsSync(join(appRoot, 'VERSION'));

export const dataDir = resolve(
  process.env.MIRROR_DATA_DIR ?? (isProduction ? '/opt/smartmirror/data' : join(appRoot, '.data')),
);

export const modulesDir = resolve(process.env.MIRROR_MODULES_DIR ?? join(appRoot, 'modules'));

/**
 * Gebautes PWA-Bundle. Im Release liegt es unter remote/, im Repo unter
 * packages/remote/dist. Fehlt es, laeuft der Server trotzdem – nur ohne
 * Oberflaeche, was besser ist als ein Spiegel, der gar nicht erst startet.
 */
export const remoteDistDir = resolve(
  process.env.MIRROR_REMOTE_DIR ??
    [join(appRoot, 'remote'), join(appRoot, 'packages/remote/dist')].find((candidate) =>
      existsSync(join(candidate, 'index.html')),
    ) ??
    join(appRoot, 'remote'),
);

export const configFile = join(dataDir, 'config.json');
export const secretsFile = join(dataDir, 'secrets.json');
export const authFile = join(dataDir, 'auth.json');
export const keyFile = join(dataDir, 'device.key');
/** Der Updater legt hier seinen Zustand ab; der Core liest ihn nur. */
export const updateStatusFile = join(dataDir, 'update-status.json');
export const updateRequestFile = join(dataDir, 'update-request.json');
/**
 * Auftrag an den Root-Dienst, der Dienste neu startet oder das Geraet bootet.
 * Der Core schreibt nur; gelesen und geloescht wird die Datei von
 * deploy/mirror-system.sh.
 */
export const systemRequestFile = join(dataDir, 'system-request.json');
/**
 * Bericht von deploy/mirror-bootlook.sh: wie der Spiegel beim Booten aussieht
 * und ob dafuer noch ein Neustart aussteht. Der Core liest nur.
 */
export const bootLookStatusFile = join(dataDir, 'bootlook-status.json');

export function appVersion(): string {
  for (const file of [join(appRoot, 'VERSION'), join(appRoot, 'package.json')]) {
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf8');
      if (file.endsWith('VERSION')) return raw.trim();
      return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
    } catch {
      // naechster Kandidat
    }
  }
  return process.env.MIRROR_VERSION ?? '0.0.0';
}
