import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { currentLink, previousLink, releaseDir, releasesDir } from './paths.js';
import { compare } from './semver.js';

const run = promisify(execFile);

/** So viele alte Releases bleiben liegen – genug fuer Rueckfall und Diagnose. */
const KEEP_RELEASES = 3;

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Die .sha256-Datei folgt dem Format von sha256sum: "<hex>  <dateiname>".
 * Der Dateiname wird mitgeprueft, damit eine gueltige Pruefsumme nicht fuer
 * ein anderes Artefakt desselben Releases wiederverwendet werden kann.
 */
export function parseChecksumFile(content: string, expectedFileName: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match) continue;
    if (basename(match[2] as string) === expectedFileName) return (match[1] as string).toLowerCase();
  }
  throw new Error(`Keine Pruefsumme fuer "${expectedFileName}" gefunden`);
}

/**
 * Entpackt das Release in ein Verzeichnis, das erst danach seinen endgueltigen
 * Namen bekommt. Ein abgebrochenes Entpacken hinterlaesst damit kein
 * halbfertiges Release, das beim naechsten Start als gueltig gilt.
 */
export async function extractRelease(archive: Buffer, version: string): Promise<string> {
  const target = releaseDir(version);
  const staging = `${target}.tmp`;
  const archiveFile = join(releasesDir, `.download-${version}.tar.gz`);

  await mkdir(releasesDir, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(archiveFile, archive);

  try {
    await run('tar', ['-xzf', archiveFile, '-C', staging], { maxBuffer: 16 * 1024 * 1024 });
  } finally {
    await unlink(archiveFile).catch(() => {});
  }

  // Manche Archive bringen ein einzelnes Wurzelverzeichnis mit. Beides zulassen,
  // damit das Bundle-Skript nicht die einzige Fehlerquelle wird.
  const entries = await readdir(staging, { withFileTypes: true });
  let source = staging;
  if (entries.length === 1 && entries[0]?.isDirectory() && !existsSync(join(staging, 'VERSION'))) {
    source = join(staging, entries[0].name);
  }

  if (!existsSync(join(source, 'VERSION'))) {
    await rm(staging, { recursive: true, force: true });
    throw new Error('Release-Archiv enthaelt keine VERSION-Datei – vermutlich kein gueltiges Bundle');
  }

  await rm(target, { recursive: true, force: true });
  await rename(source, target);
  if (source !== staging) await rm(staging, { recursive: true, force: true });
  return target;
}

/** Ziel eines Symlinks, oder null wenn er nicht existiert. */
export async function linkTarget(link: string): Promise<string | null> {
  try {
    return await readlink(link);
  } catch {
    return null;
  }
}

/**
 * Setzt einen Symlink atomar um: erst einen neuen anlegen, dann per rename
 * ueber den alten schieben. Zwischen beiden Zustaenden gibt es keinen Moment,
 * in dem "current" fehlt – auch nicht bei Stromausfall.
 */
export async function swapLink(link: string, target: string): Promise<void> {
  const tmp = `${link}.new`;
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, link);
}

export async function activateRelease(version: string): Promise<{ previous: string | null }> {
  const previous = await linkTarget(currentLink);
  if (previous) await swapLink(previousLink, previous);
  await swapLink(currentLink, releaseDir(version));
  return { previous };
}

export async function rollback(): Promise<string | null> {
  const target = await linkTarget(previousLink);
  if (!target) return null;
  await swapLink(currentLink, target);
  return target;
}

export async function restartServices(): Promise<void> {
  await run('systemctl', ['restart', 'mirror-core.service', 'mirror-shell.service'], {
    timeout: 60_000,
  });
}

/** Raeumt alte Releases weg, laesst aber current und previous immer stehen. */
export async function pruneReleases(): Promise<string[]> {
  const keep = new Set<string>();
  for (const link of [currentLink, previousLink]) {
    const target = await linkTarget(link);
    if (target) keep.add(basename(target));
  }

  let entries: string[] = [];
  try {
    entries = (await readdir(releasesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const sorted = entries.sort((a, b) => compare(b, a));
  const removed: string[] = [];
  for (const [index, name] of sorted.entries()) {
    if (keep.has(name) || index < KEEP_RELEASES) continue;
    await rm(join(releasesDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
