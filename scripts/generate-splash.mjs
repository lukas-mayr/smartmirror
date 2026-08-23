/*
 * Erzeugt die Bilder fuer den Plymouth-Startbildschirm.
 *
 *   npm i --no-save playwright && node scripts/generate-splash.mjs
 *
 * Warum ueberhaupt Bilder: Plymouth laeuft, bevor irgendetwas von diesem
 * Projekt geladen ist – es hat keinen Zugriff auf die Schriften aus dem
 * Bundle. Ein Text, den Plymouth selbst setzt, kaeme in irgendeiner
 * System-Schrift heraus und saehe anders aus als der Startbildschirm der
 * Anzeige, der eine Sekunde spaeter darueber liegt. Also wird das Wortzeichen
 * hier einmal mit derselben Schrift und denselben Werten gesetzt wie dort und
 * als Bild mitgeliefert.
 *
 * Warum vier Bilder: Der Spiegel kann hochkant haengen. Plymouth kennt die
 * Konfiguration des Spiegels nicht und kann sie auch nicht lesen – der
 * Installer legt deshalb die passende Fassung an die Stelle, die das Thema
 * laedt. Fertig gedreht und nicht zur Laufzeit, weil eine Drehung um ein
 * Vielfaches von 90 Grad dann pixelgenau bleibt: kein Skalieren, keine weiche
 * Kante. Dieselbe Ueberlegung steht im Stylesheet der Anzeige.
 *
 * Das Skript laeuft von Hand und nicht in der CI: es braucht einen Browser,
 * und die vier Dateien aendern sich nur, wenn sich das Wortzeichen aendert.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fontsDir = join(root, 'packages/shell/dist/renderer');
const outDir = join(root, 'deploy/plymouth');

const { chromium } = await import('playwright');

/*
 * Dieselben Werte wie in .boot / .boot__mark / .boot__pulse im Stylesheet der
 * Anzeige. Stehen sie hier anders, springt das Bild beim Uebergang von
 * Plymouth auf die Anzeige – und genau dieser Uebergang soll unsichtbar sein.
 */
const MARK_SIZE = 40;
const MARK_TRACKING = '0.16em';
const MARK_COLOR = '#9a9a9a';
const DOT_SIZE = 8;
const DOT_GAP = 12;
const DOT_COLOR = '#707070';
const STACK_GAP = 32;

const page$ = `<!doctype html>
<meta charset="utf-8" />
<link rel="stylesheet" href="/fonts.css" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #mark {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: ${STACK_GAP}px;
    font-family: 'Nunito', sans-serif;
    /* Die Zeile bekommt links denselben Ausgleich wie in der Anzeige: das
       letter-spacing haengt sonst als Leerraum hinten dran und das Wort
       stuende nicht mittig. */
    padding-left: ${MARK_TRACKING};
  }
  #mark p { margin: 0; }
  #word {
    font-size: ${MARK_SIZE}px;
    font-weight: 300;
    letter-spacing: ${MARK_TRACKING};
    color: ${MARK_COLOR};
    white-space: nowrap;
    line-height: 1.2;
  }
  #dots { display: flex; gap: ${DOT_GAP}px; }
  #dots span {
    width: ${DOT_SIZE}px;
    height: ${DOT_SIZE}px;
    border-radius: 999px;
    background: ${DOT_COLOR};
  }
</style>
<div id="mark">
  <p id="word">Smartmirror</p>
  <p id="dots"><span></span><span></span><span></span></p>
</div>`;

const TYPES = { '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page$);
    return;
  }
  try {
    const body = await readFile(join(fontsDir, request.url.replace(/^\/+/, '')));
    response.writeHead(200, { 'content-type': TYPES[extname(request.url)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
await page.goto(`http://127.0.0.1:${port}/`);
await page.evaluate(() => document.fonts.ready);

const box = await page.evaluate(() => {
  const { width, height } = document.querySelector('#mark').getBoundingClientRect();
  // Auf ganze Pixel aufrunden: ein halber Pixel Rand waere im Bild eine
  // graue Kante, und die faellt hinter dem Glas als Schleier auf.
  return { width: Math.ceil(width), height: Math.ceil(height) };
});

await mkdir(outDir, { recursive: true });

for (const rotation of [0, 90, 180, 270]) {
  const quer = rotation % 180 === 0;
  const width = quer ? box.width : box.height;
  const height = quer ? box.height : box.width;

  await page.setViewportSize({ width, height });
  await page.evaluate(
    ([grad, w, h, markW, markH]) => {
      const mark = document.querySelector('#mark');
      Object.assign(document.body.style, { width: `${w}px`, height: `${h}px`, position: 'relative' });
      Object.assign(mark.style, {
        position: 'absolute',
        left: `${(w - markW) / 2}px`,
        top: `${(h - markH) / 2}px`,
        width: `${markW}px`,
        height: `${markH}px`,
        transformOrigin: 'center center',
        transform: `rotate(${grad}deg)`,
      });
    },
    [rotation, width, height, box.width, box.height],
  );

  const png = await page.screenshot({ omitBackground: true });
  const file = join(outDir, `splash-${rotation}.png`);
  await writeFile(file, png);
  console.log(`  · splash-${rotation}.png (${width}x${height}, ${png.length} Bytes)`);
}

await browser.close();
server.close();
console.log('Startbildschirm-Bilder erzeugt.');
