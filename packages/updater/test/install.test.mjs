import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Der Installations-Teil des Updaters liest seine Pfade beim Import aus der
 * Umgebung. Deshalb wird MIRROR_INSTALL_ROOT gesetzt, bevor das Modul geladen
 * wird – ein spaeteres Setzen haette keine Wirkung mehr.
 */
let root;
let install;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'mirror-install-'));
  process.env.MIRROR_INSTALL_ROOT = root;
  install = await import('../dist/install.js');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Legt ein Release-Verzeichnis an, wie es der Updater nach dem Entpacken hat. */
async function makeRelease(version) {
  const dir = join(root, 'releases', version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'VERSION'), `${version}\n`, 'utf8');
  return dir;
}

beforeEach(async () => {
  await rm(join(root, 'releases'), { recursive: true, force: true });
  for (const link of ['current', 'previous']) {
    await rm(join(root, link), { recursive: true, force: true });
  }
});

test('aktiviert ein Release und merkt sich den Vorgaenger', async () => {
  await makeRelease('1.0.0');
  await makeRelease('1.1.0');
  await install.swapLink(join(root, 'current'), join(root, 'releases', '1.0.0'));

  const { previous } = await install.activateRelease('1.1.0');

  assert.ok(previous?.endsWith('1.0.0'), 'previous zeigt auf die alte Version');
  assert.ok((await install.linkTarget(join(root, 'current'))).endsWith('1.1.0'));
  assert.ok((await install.linkTarget(join(root, 'previous'))).endsWith('1.0.0'));
});

test('rollt auf den Vorgaenger zurueck', async () => {
  await makeRelease('1.0.0');
  await makeRelease('1.1.0');
  await install.swapLink(join(root, 'current'), join(root, 'releases', '1.0.0'));
  await install.activateRelease('1.1.0');

  const restored = await install.rollback();

  assert.ok(restored?.endsWith('1.0.0'));
  assert.ok((await install.linkTarget(join(root, 'current'))).endsWith('1.0.0'));
});

test('meldet, wenn es nichts gibt, worauf zurueckgerollt werden koennte', async () => {
  // Erstinstallation: es existiert kein previous. Der Updater muss das
  // erkennen, statt current auf einen toten Pfad zu setzen.
  await makeRelease('1.0.0');
  await install.activateRelease('1.0.0');
  assert.equal(await install.rollback(), null);
});

test('swapLink ersetzt einen bestehenden Symlink', async () => {
  await makeRelease('1.0.0');
  await makeRelease('2.0.0');
  const link = join(root, 'current');
  await install.swapLink(link, join(root, 'releases', '1.0.0'));
  await install.swapLink(link, join(root, 'releases', '2.0.0'));
  assert.ok((await install.linkTarget(link)).endsWith('2.0.0'));
});

test('behaelt beim Aufraeumen current und previous, auch wenn sie alt sind', async () => {
  for (const version of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0']) {
    await makeRelease(version);
  }
  // Bewusst die aeltesten beiden verlinken: sie duerfen trotzdem nicht
  // weggeraeumt werden, sonst zerstoert das Aufraeumen den Rueckfallweg.
  await install.swapLink(join(root, 'current'), join(root, 'releases', '0.1.0'));
  await install.swapLink(join(root, 'previous'), join(root, 'releases', '0.2.0'));

  const removed = await install.pruneReleases();

  const remaining = (await readdir(join(root, 'releases'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.ok(remaining.includes('0.1.0'), 'current bleibt erhalten');
  assert.ok(remaining.includes('0.2.0'), 'previous bleibt erhalten');
  // Die drei neuesten bleiben ebenfalls stehen.
  assert.ok(remaining.includes('0.6.0'));
  assert.ok(removed.length > 0, 'es wurde tatsaechlich etwas entfernt');
});

test('liest die Pruefsumme zum passenden Dateinamen', async () => {
  const hash = 'a'.repeat(64);
  const content = `${'b'.repeat(64)}  anderes-artefakt.tar.gz\n${hash}  smartmirror-1.0.0-arm64.tar.gz\n`;
  assert.equal(install.parseChecksumFile(content, 'smartmirror-1.0.0-arm64.tar.gz'), hash);
});

test('lehnt eine Pruefsummendatei ohne passenden Eintrag ab', () => {
  // Sonst liesse sich eine gueltige Pruefsumme eines anderen Artefakts
  // desselben Releases wiederverwenden.
  const content = `${'b'.repeat(64)}  ganz-anderes.tar.gz\n`;
  assert.throws(
    () => install.parseChecksumFile(content, 'smartmirror-1.0.0-arm64.tar.gz'),
    /Keine Pruefsumme/,
  );
});

test('lehnt ein Archiv ohne VERSION-Datei ab', async () => {
  // tar wird echt aufgerufen; das Archiv enthaelt absichtlich nur eine
  // harmlose Datei und kein VERSION.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const source = join(root, 'kaputtes-archiv');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'liesmich.txt'), 'kein release\n', 'utf8');
  const archivePath = join(root, 'kaputt.tar.gz');
  await run('tar', ['-czf', archivePath, '-C', source, '.']);

  const { readFile } = await import('node:fs/promises');
  const archive = await readFile(archivePath);

  await assert.rejects(() => install.extractRelease(archive, '9.9.9'), /keine VERSION-Datei/);
});
