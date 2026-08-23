/*
 * Erzeugt den unsichtbaren Mauszeiger fuer den Compositor.
 *
 *   node scripts/generate-cursor.mjs
 *
 * Warum es den braucht: Zwischen dem Ende von Plymouth und dem ersten Bild von
 * Electron liegen ein paar Sekunden, in denen `cage` allein auf dem Bildschirm
 * ist. Es hat dann keine Fensterflaeche zu zeichnen - aber einen Mauszeiger,
 * den es aus dem Cursor-Thema des Systems laedt und mitten auf den schwarzen
 * Bildschirm setzt. Hinter halbdurchlaessigem Glas ist ein weisser Pfeil das
 * Auffaelligste, was dort passieren kann.
 *
 * Warum nicht per Schalter an cage: einen zum Ausblenden gibt es nicht, und
 * eine unbekannte Option laesst cage sofort beenden - auf einem Spiegel ohne
 * Tastatur heisst das schwarzer Bildschirm ohne Hinweis (siehe
 * deploy/cage-session.sh). Warum nicht per CSS: `cursor: none` in der Anzeige
 * greift erst, wenn es die Anzeige gibt, und genau vorher steht der Pfeil da.
 *
 * Also bekommt cage ein eigenes Thema untergeschoben, in dem jeder Zeiger aus
 * lauter durchsichtigen Bildpunkten besteht. Geladen wird es ueber XCURSOR_PATH
 * und XCURSOR_THEME, die deploy/cage-session.sh setzt.
 *
 * Das Format stammt von X11 (Xcursor) und ist so klein, dass es sich hier
 * hinschreiben laesst - ein Werkzeug wie xcursorgen waere eine Abhaengigkeit
 * mehr, nur um 2368 Bytes aus Nullen zu erzeugen.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const themeDir = join(root, 'deploy/cursor/default');

// 24 Bildpunkte im Quadrat: die uebliche Groesse. Ein 1x1 grosses Bild waere
// noch kleiner, aber Treiber, die den Zeiger in Hardware zeichnen, moegen
// entartete Groessen nicht immer - und ersparen tut es nichts.
const GROESSE = 24;

const TYP_BILD = 0xfffd0002;

function xcursor() {
  const bild = Buffer.alloc(36 + GROESSE * GROESSE * 4); // Rest bleibt 0: durchsichtig.
  bild.writeUInt32LE(36, 0); // Laenge dieses Kopfes
  bild.writeUInt32LE(TYP_BILD, 4);
  bild.writeUInt32LE(GROESSE, 8); // Untertyp ist bei Bildern die Nenngroesse
  bild.writeUInt32LE(1, 12); // Version des Abschnitts
  bild.writeUInt32LE(GROESSE, 16); // Breite
  bild.writeUInt32LE(GROESSE, 20); // Hoehe
  bild.writeUInt32LE(0, 24); // Heisser Punkt x
  bild.writeUInt32LE(0, 28); // Heisser Punkt y
  bild.writeUInt32LE(0, 32); // Standzeit in ms, nur fuer bewegte Zeiger

  const kopf = Buffer.alloc(16 + 12);
  kopf.write('Xcur', 0, 'ascii');
  kopf.writeUInt32LE(16, 4); // Laenge des Dateikopfes
  kopf.writeUInt32LE(0x00010000, 8); // Dateiversion 1.0
  kopf.writeUInt32LE(1, 12); // ein einziger Eintrag im Inhaltsverzeichnis
  kopf.writeUInt32LE(TYP_BILD, 16);
  kopf.writeUInt32LE(GROESSE, 20);
  kopf.writeUInt32LE(kopf.length, 24); // wo der Abschnitt anfaengt

  return Buffer.concat([kopf, bild]);
}

/*
 * Unter welchen Namen gefragt wird, haengt an der Version von wlroots: aeltere
 * fragen nach "left_ptr", neuere nach "default". Beide bekommen dieselbe Datei,
 * dazu die zwei Namen, die in der Praxis noch vorkommen. Kopien und keine
 * Verweise: was in einem Archiv landet und wieder ausgepackt wird, soll keine
 * Verweise enthalten, die ins Leere zeigen koennen.
 */
const NAMEN = ['default', 'left_ptr', 'arrow', 'top_left_arrow'];

const datei = xcursor();
await mkdir(join(themeDir, 'cursors'), { recursive: true });
for (const name of NAMEN) {
  await writeFile(join(themeDir, 'cursors', name), datei);
  console.log(`  · cursors/${name} (${datei.length} Bytes)`);
}

await writeFile(
  join(themeDir, 'index.theme'),
  ['[Icon Theme]', 'Name=Smartmirror', 'Comment=Ein Zeiger aus lauter Nichts', ''].join('\n'),
);
console.log('  · index.theme');
console.log('Unsichtbarer Mauszeiger erzeugt.');
