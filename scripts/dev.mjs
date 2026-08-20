#!/usr/bin/env node
/**
 * Startet die Entwicklungsumgebung: Core, Anzeige und Handy-App zusammen.
 *
 *   npm run dev
 *
 * Die Anzeige laeuft dabei im Fenster statt im Vollbild (MIRROR_WINDOWED=1),
 * damit man nebenher noch etwas anderes tun kann.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.MIRROR_PORT ?? '8080';

// Farbcodes als Escape-Sequenz statt als rohes Steuerzeichen: so bleibt die
// Datei in jedem Editor und in jedem Diff lesbar.
const COLORS = {
  core: '\u001b[36m',
  shell: '\u001b[35m',
  remote: '\u001b[32m',
  build: '\u001b[33m',
};
const RESET = '\u001b[0m';

const children = [];

/** Startet einen Teilprozess und stellt jeder Ausgabezeile seinen Namen voran. */
function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${COLORS[name] ?? ''}[${name}]${RESET}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      // Der letzte Teil ist meist eine angefangene Zeile – zurueckhalten,
      // sonst zerreisst die Ausgabe mitten im Wort.
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
    });
  }

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`${prefix} beendet mit Code ${code}`);
  });

  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Ohne gebaute Pakete startet nichts – lieber einmal warten als mit einer
// unverstaendlichen Fehlermeldung abbrechen.
if (!existsSync(resolve(root, 'packages/core/dist/index.js'))) {
  console.log(`${COLORS.build}[build]${RESET} Erster Durchlauf, baue alles ...`);
  const build = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  await new Promise((done) => build.on('exit', done));
}

console.log(`\n  Core        http://127.0.0.1:${PORT}`);
console.log('  Handy-App   http://127.0.0.1:5173  (mit Hot-Reload)');
console.log('  Anzeige     eigenes Fenster\n');

run('core', 'node', ['--watch', 'packages/core/dist/index.js'], { MIRROR_PORT: PORT });
run('remote', 'npm', ['run', 'dev', '--workspace', '@mirror/remote']);
run('shell', 'node', ['packages/shell/build.mjs', '--watch']);

// Electron erst starten, wenn der Core antwortet – sonst zeigt das Fenster
// beim Start unnoetig den Verbindungshinweis.
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1_000) });
    if (response.ok) break;
  } catch {
    // weiter warten
  }
  await new Promise((done) => setTimeout(done, 500));
}

run('shell', 'npx', ['electron', 'packages/shell'], {
  MIRROR_WINDOWED: '1',
  MIRROR_CORE_URL: `http://127.0.0.1:${PORT}`,
});
