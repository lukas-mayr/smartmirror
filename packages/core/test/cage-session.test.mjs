import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/*
 * Der Mauszeiger, den es nicht geben darf.
 *
 * Zwischen dem Ende von Plymouth und dem ersten Bild von Electron ist cage
 * allein auf dem Bildschirm und setzt einen Zeiger aus dem Cursor-Thema des
 * Systems mitten auf das Schwarz. Dagegen liegt in deploy/cursor ein Thema aus
 * lauter durchsichtigen Bildpunkten. Es besteht aus erzeugten Dateien, die
 * niemand liest - genau die Sorte, die bei einem Umbau still verschwindet und
 * erst am fertig aufgehaengten Spiegel auffaellt.
 */

test('das Zeiger-Thema ist ein gueltiges Xcursor-Thema aus lauter Nichts', async () => {
  // Unter welchem Namen gefragt wird, haengt an der Version von wlroots.
  for (const name of ['default', 'left_ptr', 'arrow', 'top_left_arrow']) {
    const datei = await readFile(join(repoRoot, 'deploy/cursor/default/cursors', name));

    assert.equal(datei.toString('ascii', 0, 4), 'Xcur', `${name}: kein Xcursor-Kopf`);
    assert.equal(datei.readUInt32LE(4), 16, `${name}: unerwartete Kopflaenge`);
    assert.equal(datei.readUInt32LE(12), 1, `${name}: genau ein Bild erwartet`);

    const anfang = datei.readUInt32LE(24);
    const breite = datei.readUInt32LE(anfang + 16);
    const hoehe = datei.readUInt32LE(anfang + 20);
    assert.equal(datei.readUInt32LE(anfang + 4), 0xfffd0002, `${name}: kein Bildabschnitt`);
    assert.equal(anfang + 36 + breite * hoehe * 4, datei.length, `${name}: Laenge passt nicht zum Bild`);

    // Worauf es ankommt: kein einziger Bildpunkt ist zu sehen.
    assert.ok(
      datei.subarray(anfang + 36).every((byte) => byte === 0),
      `${name}: der Zeiger ist nicht durchsichtig`,
    );
  }
});

test('cage bekommt das Thema untergeschoben', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-cage-'));
  await cp(join(repoRoot, 'deploy'), join(dir, 'deploy'), { recursive: true });

  // Attrappen: weder cage noch die Anzeige duerfen in einem Test wirklich
  // starten. Was cage vorfindet, schreibt es stattdessen auf.
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'cage'),
    '#!/usr/bin/env bash\nprintf "XCURSOR_PATH=%s\\nXCURSOR_THEME=%s\\n" "$XCURSOR_PATH" "$XCURSOR_THEME"\n',
  );
  await chmod(join(bin, 'cage'), 0o755);

  const app = join(dir, 'shell');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'smartmirror-shell'), '#!/usr/bin/env bash\nexit 0\n');
  await chmod(join(app, 'smartmirror-shell'), 0o755);

  const skript = join(dir, 'deploy/cage-session.sh');
  const quelle = await readFile(skript, 'utf8');
  await writeFile(
    skript,
    quelle.replace('APP="/opt/smartmirror/current/shell/smartmirror-shell"', `APP="${join(app, 'smartmirror-shell')}"`),
  );

  const { stdout } = await run('bash', [skript], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.match(stdout, new RegExp(`XCURSOR_PATH=${join(dir, 'deploy/cursor')}\\n`));
  assert.match(stdout, /XCURSOR_THEME=default\n/);
});

/*
 * Die Meldung, an der sich das schwarze Fenster messen laesst.
 *
 * Zwischen dem Start von cage und dem ersten Bild von Electron ist der
 * Bildschirm schwarz. Wie lange, sagt nur das Geraet selbst - und zwar aus dem
 * Abstand dieser Zeile zu "[shell] erstes Bild nach ... s". Faellt sie bei
 * einem Umbau weg, faellt die einzige Messung mit, die es dazu gibt.
 */

test('vor cage steht eine Zeile im Journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-cage-'));
  await cp(join(repoRoot, 'deploy'), join(dir, 'deploy'), { recursive: true });

  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'cage'), '#!/usr/bin/env bash\nprintf "cage gestartet\\n"\n');
  await chmod(join(bin, 'cage'), 0o755);

  const app = join(dir, 'shell');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'smartmirror-shell'), '#!/usr/bin/env bash\nexit 0\n');
  await chmod(join(app, 'smartmirror-shell'), 0o755);

  const skript = join(dir, 'deploy/cage-session.sh');
  const quelle = await readFile(skript, 'utf8');
  await writeFile(
    skript,
    quelle.replace('APP="/opt/smartmirror/current/shell/smartmirror-shell"', `APP="${join(app, 'smartmirror-shell')}"`),
  );

  const { stdout } = await run('bash', [skript], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  const gemeldet = stdout.indexOf('cage startet die Anzeige.');
  const gestartet = stdout.indexOf('cage gestartet');
  assert.ok(gemeldet >= 0, 'keine Meldung vor dem Start des Compositors');
  assert.ok(gemeldet < gestartet, 'die Meldung kommt nach cage - dann misst sie nichts mehr');
});
