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
 * Das Vorwaermen.
 *
 * Der Bildschirm ist von dem Augenblick an schwarz, in dem cage die
 * Grafikausgabe uebernimmt, bis Electron sein erstes Bild hat. Damit dieses
 * Fenster kurz bleibt, liest cage-session.sh die Anwendung vorher am Stueck in
 * den Dateisystem-Cache - und zwar *vor* dem Start von cage, weil bis dahin
 * noch das Wortzeichen von Plymouth steht.
 *
 * Genau diese Reihenfolge wird hier geprueft: passierte es
 * nachher, waere die Wartezeit dort, wo sie jetzt weg ist.
 */

/** Baut ein Verzeichnis nach, wie es der Updater auf dem Pi hinterlaesst. */
async function nachbau(dateien) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-cage-'));
  await cp(join(repoRoot, 'deploy'), join(dir, 'deploy'), { recursive: true });

  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  // Die Attrappe von cage meldet sich, damit sich die Reihenfolge ablesen laesst.
  await writeFile(join(bin, 'cage'), '#!/usr/bin/env bash\nprintf "cage gestartet\\n"\n');
  await chmod(join(bin, 'cage'), 0o755);

  const app = join(dir, 'shell');
  await mkdir(join(app, 'resources'), { recursive: true });
  await writeFile(join(app, 'smartmirror-shell'), Buffer.alloc(2 * 1024 * 1024, 7));
  await chmod(join(app, 'smartmirror-shell'), 0o755);
  for (const [name, groesse] of Object.entries(dateien)) {
    await writeFile(join(app, name), Buffer.alloc(groesse, 7));
  }

  const skript = join(dir, 'deploy/cage-session.sh');
  const quelle = await readFile(skript, 'utf8');
  await writeFile(
    skript,
    quelle.replace('APP="/opt/smartmirror/current/shell/smartmirror-shell"', `APP="${join(app, 'smartmirror-shell')}"`),
  );

  return {
    async lauf(env = {}) {
      const { stdout } = await run('bash', [skript], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      return stdout;
    },
  };
}

test('die Anwendung wird gelesen, bevor cage den Bildschirm nimmt', async () => {
  const { lauf } = await nachbau({
    'libffmpeg.so': 1024 * 1024,
    'icudtl.dat': 512 * 1024,
    'resources/app.asar': 256 * 1024,
  });

  const stdout = await lauf();

  const vorgewaermt = stdout.indexOf('Vorgewaermt:');
  const gestartet = stdout.indexOf('cage gestartet');
  assert.ok(vorgewaermt >= 0, 'keine Meldung ueber das Vorwaermen');
  assert.ok(gestartet >= 0, 'cage wurde nicht gestartet');
  assert.ok(vorgewaermt < gestartet, 'erst cage, dann vorgewaermt - genau falsch herum');

  // Alle vier Dateien: das Programm, die Bibliothek, die Tabelle, das Archiv.
  assert.match(stdout, /Vorgewaermt: 4 Dateien/);
});

test('die kleinen Dateien kommen vor dem grossen Programm', async () => {
  // Gemessen auf dem Geraet: das 169 MB grosse Programm allein braucht auf der
  // Karte 35 Sekunden. Stuende es vorn, waere die Frist um, bevor die kleinen
  // Dateien an der Reihe sind - und genau die braucht Electron vollstaendig.
  const { lauf } = await nachbau({ 'libffmpeg.so': 1024 * 1024 });

  // Budget so knapp wie die erste kleine Datei: was danach kaeme, faellt weg.
  // Stuende das 2 MB grosse Programm vorn, meldete die Zeile 2 MB.
  const knapp = await lauf({ MIRROR_PREWARM_BUDGET_MB: '1' });
  assert.match(knapp, /Vorgewaermt: 1 Dateien, 1 MB/);
  assert.match(knapp, /cage gestartet/);
});

test('das Vorwaermen laesst sich abschalten und haelt seine Frist ein', async () => {
  const { lauf } = await nachbau({ 'libffmpeg.so': 1024 * 1024 });

  const aus = await lauf({ MIRROR_PREWARM: '0' });
  assert.doesNotMatch(aus, /Vorgewaermt:/);
  assert.match(aus, /cage gestartet/, 'ohne Vorwaermen muss cage trotzdem starten');

  // Keine Frist heisst: gar nichts lesen - und trotzdem starten. Der
  // Startbildschirm ist eine Verschoenerung; die Anzeige ist der Zweck.
  const eilig = await lauf({ MIRROR_PREWARM_SECONDS: '0' });
  assert.match(eilig, /Vorgewaermt: 0 Dateien/);
  assert.match(eilig, /cage gestartet/);
});
