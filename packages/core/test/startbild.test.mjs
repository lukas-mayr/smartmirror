import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const deploy = join(repoRoot, 'deploy');

/*
 * Der Startbildschirm unter cage.
 *
 * Zwischen dem Start des Compositors und dem ersten Bild der Anzeige gehoert
 * der Bildschirm cage, und cage hat nichts zu zeichnen - auf dem Geraet
 * gemessen rund acht Sekunden Schwarz. Bemalen kann diese Sekunden nur ein
 * Wayland-Client: deploy/cage-splash.py, gestartet von deploy/cage-app.sh.
 *
 * Was hier geprueft wird, ist nicht das Bild - dafuer braucht es einen
 * Compositor, und der laeuft in keiner CI. Geprueft wird die Kette drumherum:
 * dass die Bilder da sind, dass der Client sie lesen kann, dass die Atemkurve
 * dieselbe ist wie bei Plymouth und in der Anzeige - und vor allem, dass die
 * Anzeige startet, egal was am Startbildschirm scheitert. Er ist die
 * Verschoenerung von acht Sekunden; sie ist der Zweck des Geraets.
 */

const DREHUNGEN = [0, 90, 180, 270];
const EBENEN = ['mark', 'dot1', 'dot2', 'dot3'];

/** Ruft Python mit einem Schnipsel auf, das cage-splash.py als Modul laedt. */
async function python(schnipsel) {
  const quelle = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location('splash', ${JSON.stringify(join(deploy, 'cage-splash.py'))})`,
    'splash = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(splash)',
    schnipsel,
  ].join('\n');
  // -B: kein __pycache__ neben den Dateien, die ins Release wandern.
  const { stdout } = await run('python3', ['-B', '-c', quelle]);
  return stdout;
}

test('fuer jede Drehung liegen alle vier Ebenen bereit', async () => {
  for (const drehung of DREHUNGEN) {
    for (const ebene of EBENEN) {
      const datei = join(deploy, 'plymouth', `${ebene}-${drehung}.png`);
      assert.ok(existsSync(datei), `${ebene}-${drehung}.png fehlt`);
    }
  }
});

test('der Startbildschirm liest die Bilder, die im Release liegen', async () => {
  // Der Client bringt seinen eigenen PNG-Leser mit (auf einem Pi ist keine
  // Bildbibliothek vorinstalliert). Er versteht genau das Format, das
  // scripts/generate-splash.mjs erzeugt - aendert sich dort etwas, faellt es
  // hier auf und nicht am fertig aufgehaengten Spiegel.
  const ausgabe = await python(
    [
      'ergebnis = {}',
      `for drehung in ${JSON.stringify(DREHUNGEN)}:`,
      '    masse = set()',
      `    for ebene in ${JSON.stringify(EBENEN)}:`,
      `        w, h, pixel = splash.png_lesen(${JSON.stringify(join(deploy, 'plymouth'))} + f'/{ebene}-{drehung}.png')`,
      '        masse.add((w, h))',
      '        if ebene == "mark":',
      '            ergebnis[f"mark-{drehung}"] = splash.kasten(w, h, pixel)',
      '        else:',
      '            ergebnis[f"{ebene}-{drehung}"] = splash.kasten(w, h, pixel)',
      '    ergebnis[f"masse-{drehung}"] = sorted(masse)',
      'print(json.dumps(ergebnis))',
    ].join('\n'),
  );
  const gelesen = JSON.parse(ausgabe);

  for (const drehung of DREHUNGEN) {
    // Alle vier Ebenen sind so gross wie der ganze Block - nur so duerfen sie
    // ohne Koordinaten uebereinandergelegt werden.
    assert.equal(gelesen[`masse-${drehung}`].length, 1, `Drehung ${drehung}: Ebenen unterschiedlich gross`);

    const [, , markBreite, markHoehe] = gelesen[`mark-${drehung}`];
    assert.ok(markBreite > 20 && markHoehe > 5, `Drehung ${drehung}: Wortzeichen leer`);

    const punkte = ['dot1', 'dot2', 'dot3'].map((ebene) => gelesen[`${ebene}-${drehung}`]);
    for (const [, , breite, hoehe] of punkte) {
      assert.ok(breite > 0 && hoehe > 0, `Drehung ${drehung}: ein Punkt ist leer`);
    }
    // Drei Punkte, drei Stellen: laegen sie uebereinander, waere die
    // Animation ein einziges Blinken statt eines Laufs.
    const stellen = new Set(punkte.map(([x, y]) => `${x},${y}`));
    assert.equal(stellen.size, 3, `Drehung ${drehung}: die Punkte liegen nicht an drei Stellen`);
  }
});

test('die Punkte atmen im selben Takt wie bei Plymouth und in der Anzeige', async () => {
  // Dieselben Werte wie mirror-breathe im Stylesheet und wie smartmirror.script:
  // 1400 ms hin und zurueck, zwischen 30 % und voll. Laufen sie auseinander,
  // sieht man beim Uebergang genau das, was der Startbildschirm vermeiden soll.
  const ausgabe = await python(
    [
      'werte = [splash.deckkraft(t / 100) for t in range(0, 140)]',
      'print(json.dumps({',
      '  "kleinster": min(werte), "groesster": max(werte),',
      '  "dauer": splash.DAUER_S, "versatz": splash.VERSATZ_S,',
      '  "anfang": splash.deckkraft(0), "mitte": splash.deckkraft(0.7),',
      '  "periodisch": abs(splash.deckkraft(0.35) - splash.deckkraft(1.4 + 0.35)) < 1e-9,',
      '}))',
    ].join('\n'),
  );
  const kurve = JSON.parse(ausgabe);

  assert.equal(kurve.dauer, 1.4);
  assert.equal(kurve.versatz, 0.18);
  assert.ok(Math.abs(kurve.anfang - 0.3) < 1e-9, 'faengt nicht bei 30 % an');
  assert.ok(Math.abs(kurve.mitte - 1) < 1e-9, 'erreicht in der Mitte nicht voll');
  assert.ok(kurve.kleinster >= 0.3 - 1e-9 && kurve.groesster <= 1 + 1e-9, 'verlaesst den Bereich');
  assert.ok(kurve.periodisch, 'wiederholt sich nicht');
});

/** Legt ein Verzeichnis an, wie es der Updater auf dem Pi hinterlaesst. */
async function nachbau({ drehung, ohnePython = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mirror-startbild-'));
  await cp(deploy, join(dir, 'deploy'), { recursive: true });

  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });

  // Attrappe von cage: fuehrt aus, was ihr uebergeben wird - so laeuft
  // cage-app.sh im Test genau so, wie es unter cage liefe.
  await writeFile(join(bin, 'cage'), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
  await chmod(join(bin, 'cage'), 0o755);

  // Attrappe von python3: schreibt auf, womit der Startbildschirm gestartet
  // wuerde, statt einen Compositor zu suchen, den es im Test nicht gibt.
  if (!ohnePython) {
    await writeFile(join(bin, 'python3'), '#!/usr/bin/env bash\nprintf "STARTBILD: %s\\n" "$*"\n');
    await chmod(join(bin, 'python3'), 0o755);
  }

  const app = join(dir, 'shell');
  await mkdir(app, { recursive: true });
  await writeFile(
    join(app, 'smartmirror-shell'),
    '#!/usr/bin/env bash\n'
      + 'printf "ANZEIGE: %s\\n" "$*"\n'
      + 'printf "SPLASH_PID=%s\\n" "${MIRROR_SPLASH_PID:-keine}"\n',
  );
  await chmod(join(app, 'smartmirror-shell'), 0o755);

  await mkdir(join(dir, 'data'), { recursive: true });
  if (drehung !== undefined) {
    await writeFile(join(dir, 'data/config.json'), JSON.stringify({ display: { rotation: drehung } }));
  }

  const skript = join(dir, 'deploy/cage-session.sh');
  const quelle = await readFile(skript, 'utf8');
  await writeFile(
    skript,
    quelle.replace('APP="/opt/smartmirror/current/shell/smartmirror-shell"', `APP="${join(app, 'smartmirror-shell')}"`),
  );

  return {
    dir,
    bin,
    async lauf(env = {}) {
      const { stdout, stderr } = await run('bash', [skript], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MIRROR_DATA_DIR: join(dir, 'data'),
          ...env,
        },
      });
      return stdout + stderr;
    },
  };
}

test('cage bekommt die Anzeige ueber cage-app.sh und mit ihren Schaltern', async () => {
  const { lauf } = await nachbau();
  const ausgabe = await lauf();

  assert.match(ausgabe, /ANZEIGE: --ozone-platform=wayland/, 'die Schalter der Anzeige fehlen');
  assert.match(ausgabe, /--overscroll-history-navigation=0/, 'der letzte Schalter fehlt');
  assert.match(ausgabe, /SPLASH_PID=\d+/, 'die Anzeige erfaehrt die Nummer des Startbildschirms nicht');
});

test('die Drehung des Spiegels entscheidet, welches Bild gezeigt wird', async () => {
  for (const drehung of [0, 90, 270]) {
    const { lauf } = await nachbau({ drehung });
    const ausgabe = await lauf();

    assert.match(
      ausgabe,
      new RegExp(`STARTBILD: .*cage-splash\\.py .*plymouth ${drehung}\\b`),
      `Drehung ${drehung} kommt beim Startbildschirm nicht an`,
    );
  }
});

test('eine unsinnige Drehung wird zur queren', async () => {
  // Dieselbe Annahme wie ueberall sonst: ein quer haengender Spiegel ist der
  // Normalfall, und ein halb gedrehtes Wortzeichen waere schlimmer als ein
  // gerades.
  const { lauf } = await nachbau({ drehung: 45 });
  const ausgabe = await lauf();
  assert.match(ausgabe, /STARTBILD: .*plymouth 0\b/);
});

test('ohne python3 startet die Anzeige trotzdem', async () => {
  // Der haeufigste Grund, aus dem der Startbildschirm ausfallen koennte. Er
  // ist die Verschoenerung von acht Sekunden - die Anzeige ist der Zweck des
  // Geraets und darf daran nicht haengen.
  const { bin, lauf } = await nachbau({ ohnePython: true });

  // Ein Pfad, in dem es kein python3 gibt, aber alles, was die Skripte sonst
  // brauchen.
  const werkzeug = join(bin, 'werkzeug');
  await mkdir(werkzeug, { recursive: true });
  for (const name of ['env', 'bash', 'dirname']) {
    const { stdout } = await run('bash', ['-c', `command -v ${name}`]);
    await symlink(stdout.trim(), join(werkzeug, name));
  }

  const ausgabe = await lauf({ PATH: `${bin}:${werkzeug}` });
  assert.match(ausgabe, /ANZEIGE: --ozone-platform=wayland/, 'ohne Startbildschirm faehrt nichts mehr hoch');
  assert.doesNotMatch(ausgabe, /STARTBILD:/);
});

/*
 * Die einzige Luecke, die noch schwarz ist.
 *
 * Vom Aufruf von cage bis zu seinem ersten Client vergehen auf dem Geraet 5,4
 * Sekunden - davor haelt Plymouth das Bild, danach der Startbildschirm.
 * Headless und mit warmem Cache braucht cage 0,02 Sekunden; der Unterschied
 * ist die Grafik-Hardware und eine Karte mit knapp 5 MB/s. Deshalb schreibt
 * cage-app.sh auf, welche Dateien cage dafuer gebraucht hat, und
 * cage-session.sh liest sie beim naechsten Start vorher ein - waehrend das
 * Wortzeichen von Plymouth noch steht.
 *
 * Gelernt statt geraten: ein fest eingetragener Mesa-Pfad waere mit der
 * naechsten Version des Systems falsch.
 */

test('cage merkt sich, was es gelesen hat, und liest es beim naechsten Mal vorher', async () => {
  const { dir, lauf } = await nachbau();
  const liste = join(dir, 'data/cage-vorwaermliste');

  // Erster Start: es gibt noch keine Liste - also nichts vorzuwaermen.
  const erster = await lauf();
  assert.doesNotMatch(erster, /vorgewaermt/, 'ohne Liste darf nichts gelesen werden');
  assert.ok(existsSync(liste), 'cage-app.sh hat keine Liste hinterlassen');

  const inhalt = await readFile(liste, 'utf8');
  const zeilen = inhalt.split('\n').filter(Boolean);
  assert.ok(zeilen.length > 0, 'die Liste ist leer');
  assert.ok(zeilen.every((zeile) => zeile.startsWith('/')), 'die Liste enthaelt keine Pfade');
  assert.ok(
    zeilen.every((zeile) => !/^\/(dev|proc|sys|run)\//.test(zeile)),
    'Geraetedateien gehoeren nicht in die Liste - sie lassen sich nicht vorwaermen',
  );

  // Zweiter Start: jetzt liegt sie da und wird vor cage gelesen.
  const zweiter = await lauf();
  assert.match(zweiter, /cage vorgewaermt: \d+ Dateien, \d+ MB/);

  // Und zwar vor dem Start des Compositors - danach waere es zu spaet.
  assert.ok(
    zweiter.indexOf('cage vorgewaermt') < zweiter.indexOf('cage startet die Anzeige'),
    'vorgewaermt wird nach dem Start von cage - dann ist die Luecke schon vorbei',
  );
});

test('das Vorwaermen von cage laesst sich abschalten', async () => {
  const { lauf } = await nachbau();
  await lauf();
  const ausgabe = await lauf({ MIRROR_CAGE_PREWARM: '0' });
  assert.doesNotMatch(ausgabe, /vorgewaermt/);
  assert.match(ausgabe, /ANZEIGE: --ozone-platform=wayland/, 'die Anzeige muss trotzdem starten');
});
