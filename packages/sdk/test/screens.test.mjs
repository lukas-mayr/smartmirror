import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScreenDuration,
  createScreen,
  DEFAULT_SCREEN_DURATION,
  formatScreenDuration,
  nextScreenId,
  normalizeScreens,
  SCREEN_DURATION_MAX,
  SCREEN_DURATION_MIN,
} from '../dist/screens.js';

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
