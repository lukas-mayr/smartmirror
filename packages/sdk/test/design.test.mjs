import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEED,
  MIRROR_COLORS,
  MIRROR_RADIUS,
  MIRROR_RASTER,
  MIRROR_SURFACES,
  MIRROR_TYPE,
  MIRROR_WEIGHT,
  MOTION,
  PORTRAIT_GRID,
  PWA_COLORS,
  PWA_METRICS,
  PWA_RADIUS,
  PWA_TYPE,
  ZONE_SPECS,
  defaultGridForRotation,
  DEFAULT_GRID,
  isDefaultGrid,
  isZone,
  normalizeZone,
} from '../dist/index.js';

/*
 * Die Werte des Design-Systems stehen doppelt: als Konstante in design.ts und
 * als Custom Property in den beiden Stylesheets. Das ist Absicht – ein Modul
 * kann kein CSS lesen, und eine Schriftgroesse gehoert nicht in ein
 * JavaScript-Bundle, das der Spiegel ohnehin nur einmal braucht.
 *
 * Doppelt heisst aber: sie koennen auseinanderlaufen. Genau davor stehen die
 * Tests hier. Sie lesen die Stylesheets als Text, weil das die einzige Art
 * ist, an die Werte heranzukommen, ohne einen Browser zu starten – und die
 * Frage, um die es geht, ist ohnehin eine ueber Text: steht dort dieselbe Zahl?
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mirrorCss = readFileSync(resolve(root, 'packages/shell/src/renderer/styles.css'), 'utf8');
const pwaCss = readFileSync(resolve(root, 'packages/remote/src/styles.css'), 'utf8');

/**
 * Der Wert einer Custom Property aus dem `:root`-Block.
 *
 * Nur aus `:root`: die Nachtabsenkung definiert dieselben Namen noch einmal,
 * und die sollen hier gerade nicht verglichen werden.
 */
function tokens(css) {
  const start = css.indexOf(':root {');
  assert.notEqual(start, -1, 'kein :root-Block gefunden');
  const block = css.slice(start, css.indexOf('\n}', start));
  const found = new Map();
  for (const match of block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

const mirror = tokens(mirrorCss);
const pwa = tokens(pwaCss);

/* --------------------------------- Anzeige -------------------------------- */

test('die Farben der Anzeige stehen in beiden Quellen gleich', () => {
  const pairs = {
    '--mirror-bg': MIRROR_COLORS.bg,
    '--mirror-fg': MIRROR_COLORS.fg,
    '--mirror-fg-dim': MIRROR_COLORS.fgDim,
    '--mirror-fg-mute': MIRROR_COLORS.fgMute,
    '--mirror-accent': MIRROR_COLORS.accent,
    '--mirror-accent-warm': MIRROR_COLORS.accentWarm,
    '--mirror-on-accent': MIRROR_COLORS.onAccent,
    '--mirror-on-accent-warm': MIRROR_COLORS.onAccentWarm,
    '--mirror-danger': MIRROR_COLORS.danger,
    '--mirror-danger-fg': MIRROR_COLORS.dangerFg,
    '--mirror-box': MIRROR_SURFACES.box,
  };
  for (const [name, value] of Object.entries(pairs)) {
    assert.equal(mirror.get(name), value, `${name} laeuft auseinander`);
  }
});

test('die Groessenstufen der Anzeige stehen in beiden Quellen gleich', () => {
  const pairs = {
    '--mirror-text-mega': MIRROR_TYPE.mega,
    '--mirror-text-hero': MIRROR_TYPE.hero,
    '--mirror-text-xl': MIRROR_TYPE.xl,
    '--mirror-text-l': MIRROR_TYPE.l,
    '--mirror-text-m': MIRROR_TYPE.m,
    '--mirror-text-label': MIRROR_TYPE.label,
    '--mirror-text-min': MIRROR_TYPE.min,
  };
  for (const [name, value] of Object.entries(pairs)) {
    assert.equal(mirror.get(name), `${value}px`, `${name} laeuft auseinander`);
  }
});

test('die Schnitte der Anzeige stehen in beiden Quellen gleich', () => {
  assert.equal(mirror.get('--mirror-weight-value'), String(MIRROR_WEIGHT.value));
  assert.equal(mirror.get('--mirror-weight-label'), String(MIRROR_WEIGHT.label));
  assert.equal(mirror.get('--mirror-weight-label-soft'), String(MIRROR_WEIGHT.labelSoft));
});

test('die Radien der Anzeige stehen in beiden Quellen gleich', () => {
  assert.equal(mirror.get('--mirror-radius-s'), `${MIRROR_RADIUS.s}px`);
  assert.equal(mirror.get('--mirror-radius-l'), `${MIRROR_RADIUS.l}px`);
  assert.equal(mirror.get('--mirror-radius-xl'), `${MIRROR_RADIUS.xl}px`);
  assert.equal(mirror.get('--mirror-radius-pill'), `${MIRROR_RADIUS.pill}px`);
  assert.equal(mirror.get('--mirror-box-pad'), `${MIRROR_RASTER.boxPadding}px`);
});

test('die Taktung der Bewegung steht in beiden Quellen gleich', () => {
  assert.equal(mirror.get('--motion-swap-duration'), `${MOTION.swap}ms`);
  assert.equal(mirror.get('--motion-tick'), `${MOTION.tick}ms linear`);
  assert.equal(mirror.get('--motion-breathe'), `${MOTION.breathe}ms ease-in-out infinite`);
  assert.equal(mirror.get('--motion-screen'), `${MOTION.screen}ms`);
});

test('die Masse des Feeds stehen in beiden Quellen gleich', () => {
  assert.equal(mirror.get('--feed-item-h'), `${FEED.itemHeight}px`);
  assert.equal(mirror.get('--feed-item-h-rest'), `${FEED.itemHeightRest}px`);
  assert.equal(mirror.get('--feed-title'), `${FEED.titleSize}px`);
  assert.equal(mirror.get('--feed-title-rest'), `${FEED.titleSizeRest}px`);
  assert.equal(mirror.get('--feed-dim-1'), String(FEED.dim1));
  assert.equal(mirror.get('--feed-dim-2'), String(FEED.dim2));
});

test('die Baender teilen die Hoehe so auf wie das Design-System', () => {
  assert.equal(mirror.get('--zone-head'), `${ZONE_SPECS.head.share}%`);
  assert.equal(mirror.get('--zone-foot'), `${ZONE_SPECS.foot.share}%`);
  // Kopf, Mitte und Fuss ergeben zusammen die ganze Wand – sonst bliebe ein
  // Streifen uebrig, der niemandem gehoert.
  const total = ZONE_SPECS.head.share + ZONE_SPECS.main.share + ZONE_SPECS.foot.share;
  assert.equal(total, 100);
});

/* ----------------------------------- PWA ---------------------------------- */

test('die Farben der PWA stehen in beiden Quellen gleich', () => {
  const pairs = {
    '--bg': PWA_COLORS.bg,
    '--surface': PWA_COLORS.surface,
    '--surface-raised': PWA_COLORS.surfaceRaised,
    '--line': PWA_COLORS.line,
    '--text': PWA_COLORS.text,
    '--text-dim': PWA_COLORS.textDim,
    '--accent': PWA_COLORS.accent,
    '--accent-warm': PWA_COLORS.accentWarm,
    '--danger': PWA_COLORS.danger,
    '--danger-fg': PWA_COLORS.dangerFg,
    '--success': PWA_COLORS.success,
    '--on-accent': PWA_COLORS.onAccent,
  };
  for (const [name, value] of Object.entries(pairs)) {
    assert.equal(pwa.get(name), value, `${name} laeuft auseinander`);
  }
});

test('die Groessen und Masse der PWA stehen in beiden Quellen gleich', () => {
  assert.equal(pwa.get('--text-title'), `${PWA_TYPE.title}px`);
  assert.equal(pwa.get('--text-heading'), `${PWA_TYPE.heading}px`);
  assert.equal(pwa.get('--text-body'), `${PWA_TYPE.body}px`);
  assert.equal(pwa.get('--text-sm'), `${PWA_TYPE.sm}px`);
  assert.equal(pwa.get('--text-label'), `${PWA_TYPE.label}px`);
  assert.equal(pwa.get('--radius-field'), `${PWA_RADIUS.field}px`);
  assert.equal(pwa.get('--radius-card'), `${PWA_RADIUS.card}px`);
  assert.equal(pwa.get('--radius-sheet'), `${PWA_RADIUS.sheet}px`);
  assert.equal(pwa.get('--tap'), `${PWA_METRICS.tap}px`);
  assert.equal(pwa.get('--field'), `${PWA_METRICS.field}px`);
  assert.equal(pwa.get('--segment'), `${PWA_METRICS.segment}px`);
});

test('beide Oberflaechen teilen sich dieselben zwei Akzente', () => {
  // Sonst hiesse Salbei am Handy etwas anderes als am Spiegel, und die Farbe
  // waere wieder Dekoration statt Bedeutung.
  assert.equal(PWA_COLORS.accent, MIRROR_COLORS.accent);
  assert.equal(PWA_COLORS.accentWarm, MIRROR_COLORS.accentWarm);
});

/* --------------------------------- Rechnung -------------------------------- */

test('das Raster geht in der Breite bis auf zwei Pixel auf', () => {
  const { width, marginX, columns, gap, cellWidth } = MIRROR_RASTER;
  // 1080 minus zweimal 43 ergibt 994 px Inhaltsbreite; davon drei Abstaende
  // abgezogen bleiben 898 px fuer vier Spalten.
  const content = width - 2 * marginX;
  assert.equal(content, 994);
  assert.equal(content - (columns - 1) * gap, 898);

  // 898 / 4 sind 224,5 – die 224 des Design-Systems sind abgerundet. Der Rest
  // von zwei Pixeln ist der Grund, warum das Raster in der Anzeige mit `1fr`
  // gerechnet wird und nicht mit dieser Zahl: der Browser verteilt die zwei
  // Pixel, eine feste Spaltenbreite liesse sie am rechten Rand liegen.
  assert.equal(cellWidth, Math.floor((content - (columns - 1) * gap) / columns));
  assert.ok(content - (columns * cellWidth + (columns - 1) * gap) <= 2);
});

test('das Raster passt in die Hoehe', () => {
  const { height, marginY, rows, gap, cellHeight } = MIRROR_RASTER;
  assert.equal(rows * cellHeight + (rows - 1) * gap + 2 * marginY, height);
});

test('das hochkante Raster ist das des Design-Systems', () => {
  assert.deepEqual(PORTRAIT_GRID, { columns: MIRROR_RASTER.columns, rows: MIRROR_RASTER.rows });
  // Quer bleibt es bei sechs mal vier, hochkant gilt das Design-System.
  assert.deepEqual(defaultGridForRotation(0), DEFAULT_GRID);
  assert.deepEqual(defaultGridForRotation(180), DEFAULT_GRID);
  assert.deepEqual(defaultGridForRotation(90), PORTRAIT_GRID);
  assert.deepEqual(defaultGridForRotation(270), PORTRAIT_GRID);
});

test('erkennt ein von Hand eingestelltes Raster', () => {
  // Wer sein Raster selbst gesetzt hat, soll es beim Drehen behalten.
  assert.equal(isDefaultGrid(DEFAULT_GRID), true);
  assert.equal(isDefaultGrid(PORTRAIT_GRID), true);
  assert.equal(isDefaultGrid({ columns: 5, rows: 7 }), false);
});

test('faellt bei einem unbekannten Band auf die Hauptzone zurueck', () => {
  assert.equal(isZone('main'), true);
  assert.equal(isZone('mitte'), false);
  assert.equal(normalizeZone('foot'), 'foot');
  assert.equal(normalizeZone(undefined), 'main');
  assert.equal(normalizeZone('unsinn', 'head'), 'head');
});
