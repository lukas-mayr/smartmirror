import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScreenDuration,
  createScreen,
  DEFAULT_SCREEN_DURATION,
  formatScreenDuration,
  gridDecidesPlacement,
  nextScreenId,
  normalizeScreens,
  SCREEN_DURATION_MAX,
  SCREEN_DURATION_MIN,
} from '../dist/screens.js';
import { findFreeSpot, rectFor } from '../dist/layout.js';

test('begrenzt die Standzeit und rundet auf die Schrittweite', () => {
  assert.equal(clampScreenDuration(1), SCREEN_DURATION_MIN);
  assert.equal(clampScreenDuration(99999), SCREEN_DURATION_MAX);
  assert.equal(clampScreenDuration(22), 20);
  assert.equal(clampScreenDuration('krumm'), DEFAULT_SCREEN_DURATION);
});

test('es gibt immer mindestens einen Screen', () => {
  // Ohne Screen gaebe es keine Flaeche: schwarzer Spiegel ohne jeden Hinweis.
  assert.equal(normalizeScreens([]).length, 1);
  assert.equal(normalizeScreens(null).length, 1);
  assert.equal(normalizeScreens('kaputt')[0].id, 'screen-1');
});

test('wirft doppelte Ids weg und repariert unbrauchbare Eintraege', () => {
  const screens = normalizeScreens([
    { id: 'screen-1', name: 'Morgens', durationSeconds: 30 },
    { id: 'screen-1', name: 'Doppelt' },
    { name: 'Ohne Id' },
  ]);
  assert.deepEqual(screens.map((screen) => screen.name), ['Morgens', 'Ohne Id']);
  assert.equal(screens[0].durationSeconds, 30);
  assert.equal(screens[1].durationSeconds, DEFAULT_SCREEN_DURATION);
  assert.notEqual(screens[1].id, screens[0].id);
});

test('vergibt die naechste freie Id', () => {
  assert.equal(nextScreenId([]), 'screen-1');
  assert.equal(nextScreenId(['screen-1', 'screen-3']), 'screen-2');
});

test('schreibt die Standzeit lesbar', () => {
  assert.equal(formatScreenDuration(20), '20 s');
  assert.equal(formatScreenDuration(60), '1 min');
  assert.equal(formatScreenDuration(90), '1:30 min');
  assert.equal(createScreen('screen-2', 'Abends').durationSeconds, DEFAULT_SCREEN_DURATION);
});

test('ueber den Platz entscheidet nur im Raster das Raster', () => {
  assert.equal(gridDecidesPlacement('grid'), true);
  assert.equal(gridDecidesPlacement('zones'), false);
});

test('eine Szene laesst XL zu, auch wenn das Raster dahinter voll ist', () => {
  /*
   * Der Fall, an dem es scheiterte: eine Szene mit der Uhr im Kopf und einem
   * XL-Block in der Hauptzone. Im Raster dahinter bleibt kein 4 x 2 grosses
   * Loch mehr — und deshalb liess sich der Timer im Fussband nicht auf XL
   * stellen. Auf dem Spiegel ist von dieser Enge nichts zu sehen, und der
   * einzige Rat dazu ("verschiebe zuerst einen anderen Block") geht in einer
   * Szene ins Leere: dort wird nichts verschoben.
   */
  const grid = { columns: 6, rows: 4 };
  const occupied = [
    { x: 2, y: 0, size: 'l' },
    { x: 0, y: 2, size: 'xl' },
  ].map((entry) => rectFor(entry, grid));

  const spot = findFreeSpot(occupied, grid, 'xl', { x: 0, y: 0 });
  assert.equal(spot, null);

  // So entscheidet die Handy-App, ob ein fehlender Rasterplatz eine Absage ist.
  const refused = (layout) => spot === null && gridDecidesPlacement(layout);
  assert.equal(refused('grid'), true);
  assert.equal(refused('zones'), false);
});
