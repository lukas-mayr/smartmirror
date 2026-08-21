import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampGridAxis,
  DEFAULT_GRID,
  findFreeSpot,
  GRID_MAX,
  GRID_MIN,
  normalizeGrid,
  normalizeWidgetSize,
  rectFor,
  rectsOverlap,
  sizeCells,
  WIDGET_SIZE_SPECS,
} from '../dist/layout.js';

test('begrenzt das Raster auf brauchbare Kantenlaengen', () => {
  assert.equal(clampGridAxis(0), GRID_MIN);
  assert.equal(clampGridAxis(99), GRID_MAX);
  assert.equal(clampGridAxis('4'), 4);
  assert.equal(clampGridAxis(4.6), 5);
  assert.deepEqual(normalizeGrid(null), DEFAULT_GRID);
  // Fehlt nur eine Achse, bleibt die andere auf dem Rueckfallwert.
  assert.deepEqual(normalizeGrid({ columns: 3 }), { columns: 3, rows: DEFAULT_GRID.rows });
});

test('kuerzt einen Block auf ein kleineres Raster', () => {
  // XL ist vier Spalten breit – auf drei Spalten gibt es die vierte nicht.
  assert.deepEqual(sizeCells('xl', { columns: 3, rows: 4 }), { columns: 3, rows: 2 });
  assert.deepEqual(sizeCells('l', DEFAULT_GRID), { columns: 2, rows: 2 });
});

test('schiebt einen Block so weit ins Raster, dass er hineinpasst', () => {
  // Ein M-Block an Spalte 5 von sechs wuerde rechts hinausragen.
  assert.deepEqual(rectFor({ x: 5, y: 0, size: 'm' }, DEFAULT_GRID), { x: 4, y: 0, columns: 2, rows: 1 });
  assert.deepEqual(rectFor({ x: -3, y: 99, size: 's' }, DEFAULT_GRID), { x: 0, y: 3, columns: 1, rows: 1 });
  // Unbrauchbare Werte aus einer von Hand editierten Datei landen oben links.
  assert.deepEqual(rectFor({ x: 'links', y: null, size: 's' }, DEFAULT_GRID), { x: 0, y: 0, columns: 1, rows: 1 });
});

test('erkennt Ueberschneidungen, aber keine Beruehrungen', () => {
  const block = { x: 0, y: 0, columns: 2, rows: 2 };
  assert.equal(rectsOverlap(block, { x: 1, y: 1, columns: 2, rows: 1 }), true);
  // Direkt daneben ist kein Konflikt – sonst bliebe zwischen Bloecken eine Zelle leer.
  assert.equal(rectsOverlap(block, { x: 2, y: 0, columns: 2, rows: 1 }), false);
  assert.equal(rectsOverlap(block, { x: 0, y: 2, columns: 2, rows: 1 }), false);
});

test('nimmt den Wunschplatz, wenn er frei ist', () => {
  assert.deepEqual(findFreeSpot([], DEFAULT_GRID, 'm', { x: 4, y: 2 }), { x: 4, y: 2 });
});

test('stapelt nach unten, wenn der Wunschplatz belegt ist', () => {
  // Zwei Module an dieselbe Stelle heisst "beide hierhin, untereinander" –
  // und nicht "das zweite irgendwohin, wo gerade Platz ist".
  const taken = [{ x: 2, y: 0, columns: 2, rows: 1 }];
  assert.deepEqual(findFreeSpot(taken, DEFAULT_GRID, 'm', { x: 2, y: 0 }), { x: 2, y: 1 });
});

test('faellt auf die erste freie Zelle zurueck und meldet ein volles Raster', () => {
  const grid = { columns: 2, rows: 2 };
  // Die ganze rechte Spalte belegt: darunter ist nichts mehr frei.
  const taken = [{ x: 1, y: 0, columns: 1, rows: 2 }];
  assert.deepEqual(findFreeSpot(taken, grid, 's', { x: 1, y: 0 }), { x: 0, y: 0 });

  const full = [{ x: 0, y: 0, columns: 2, rows: 2 }];
  assert.equal(findFreeSpot(full, grid, 's'), null);
});

test('unbekannte Groessen fallen auf den Standard zurueck', () => {
  assert.equal(normalizeWidgetSize('xxl'), 'm');
  assert.equal(normalizeWidgetSize(undefined, 'l'), 'l');
  assert.equal(normalizeWidgetSize('s'), 's');
});

test('jede Groesse ist ein Vielfaches der kleinsten', () => {
  // Nur so gehen Bloecke nebeneinander lueckenlos auf.
  for (const spec of Object.values(WIDGET_SIZE_SPECS)) {
    assert.ok(spec.columns >= 1 && spec.rows >= 1, `${spec.id} ist leer`);
    assert.equal(Number.isInteger(spec.columns) && Number.isInteger(spec.rows), true);
  }
});
