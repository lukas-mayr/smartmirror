import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Wurzel der Installation, standardmaessig /opt/smartmirror.
 *
 * Darunter:
 *   releases/<version>/   entpackte Releases
 *   current -> releases/x  Symlink, auf den alle systemd-Units zeigen
 *   previous -> releases/y Symlink auf den letzten funktionierenden Stand
 *   data/                 Konfiguration und Zustand, von Updates unberuehrt
 */
export const installRoot = resolve(process.env.MIRROR_INSTALL_ROOT ?? '/opt/smartmirror');

export const releasesDir = join(installRoot, 'releases');
export const currentLink = join(installRoot, 'current');
export const previousLink = join(installRoot, 'previous');
export const dataDir = resolve(process.env.MIRROR_DATA_DIR ?? join(installRoot, 'data'));

export const configFile = join(dataDir, 'config.json');
export const statusFile = join(dataDir, 'update-status.json');
export const requestFile = join(dataDir, 'update-request.json');
export const blocklistFile = join(dataDir, 'update-blocklist.json');
export const tokenFile = join(dataDir, 'github-token');

/** Oeffentlicher Signierschluessel, bei der Installation hinterlegt. */
export const publicKeyFile = resolve(
  process.env.MIRROR_PUBLIC_KEY ?? join(installRoot, 'minisign.pub'),
);

/** Fuer den Fall, dass der Updater ausserhalb einer Installation laeuft. */
export const updaterRoot = resolve(here, '../../..');

export function releaseDir(version: string): string {
  return join(releasesDir, version);
}
