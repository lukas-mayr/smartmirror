/**
 * Raster und Blockgroessen der Anzeige.
 *
 * Der Spiegel ist eine Flaeche ohne Eingabegeraet: was darauf liegt, wird am
 * Handy angeordnet. Freie Pixelpositionen waeren dafuer die schlechteste aller
 * Loesungen – auf einem Vier-Zoll-Bildschirm trifft niemand mit dem Daumen
 * eine Pixelkante, und zwei Module haetten nie denselben Abstand zueinander.
 *
 * Deshalb ein Raster und Bloecke in festen Groessen, wie bei den Widgets auf
 * einem Telefon: ein Block rastet ein, Abstaende stimmen von selbst, und eine
 * Anordnung laesst sich in einem Satz beschreiben ("Uhr oben links, gross").
 */

export interface GridSize {
  columns: number;
  rows: number;
}

/**
 * Quer aufgehaengt. Sechs mal vier ergibt auf 16:9 nahezu quadratische Zellen –
 * ein Block wirkt dadurch in jeder Groesse gleich proportioniert.
 */
export const DEFAULT_GRID: GridSize = { columns: 6, rows: 4 };

/** Unter zwei Spalten ist es kein Raster mehr, ueber zwoelf keine Flaeche fuer Inhalt. */
export const GRID_MIN = 2;
export const GRID_MAX = 12;

export function clampGridAxis(value: unknown): number {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return GRID_MIN;
  return Math.min(GRID_MAX, Math.max(GRID_MIN, num));
}

export function normalizeGrid(value: unknown, fallback: GridSize = DEFAULT_GRID): GridSize {
  if (typeof value !== 'object' || value === null) return { ...fallback };
  const source = value as Partial<Record<keyof GridSize, unknown>>;
  return {
    columns: source.columns === undefined ? fallback.columns : clampGridAxis(source.columns),
    rows: source.rows === undefined ? fallback.rows : clampGridAxis(source.rows),
  };
}

export function gridEqual(a: GridSize, b: GridSize): boolean {
  return a.columns === b.columns && a.rows === b.rows;
}

/* ------------------------------- Blockgroessen ------------------------------ */

export const WIDGET_SIZES = ['s', 'm', 'l', 'xl'] as const;

export type WidgetSize = (typeof WIDGET_SIZES)[number];

export const DEFAULT_WIDGET_SIZE: WidgetSize = 'm';

export interface WidgetSizeSpec {
  id: WidgetSize;
  /** Kuerzel fuer die Auswahl am Handy. */
  label: string;
  name: string;
  /** Kantenlaengen in Rasterzellen. */
  columns: number;
  rows: number;
}

/**
 * Vier Groessen, keine krummen Zwischenschritte. Jede belegt ein Vielfaches der
 * kleinsten – nur so gehen Bloecke nebeneinander lueckenlos auf.
 */
export const WIDGET_SIZE_SPECS: Record<WidgetSize, WidgetSizeSpec> = {
  s: { id: 's', label: 'S', name: 'Klein', columns: 1, rows: 1 },
  m: { id: 'm', label: 'M', name: 'Mittel', columns: 2, rows: 1 },
  l: { id: 'l', label: 'L', name: 'Gross', columns: 2, rows: 2 },
  xl: { id: 'xl', label: 'XL', name: 'Breit', columns: 4, rows: 2 },
};

export const WIDGET_SIZE_OPTIONS: readonly WidgetSizeSpec[] = WIDGET_SIZES.map(
  (size) => WIDGET_SIZE_SPECS[size],
);

export function isWidgetSize(value: unknown): value is WidgetSize {
  return typeof value === 'string' && (WIDGET_SIZES as readonly string[]).includes(value);
}

export function normalizeWidgetSize(value: unknown, fallback: WidgetSize = DEFAULT_WIDGET_SIZE): WidgetSize {
  return isWidgetSize(value) ? value : fallback;
}

/* ------------------------------ Platzierungen ------------------------------ */

/** Ein Rechteck im Raster. `x`/`y` sind nullbasierte Zellenkoordinaten. */
export interface GridRect {
  x: number;
  y: number;
  columns: number;
  rows: number;
}

export interface Placement {
  x: number;
  y: number;
  size: WidgetSize;
}

/**
 * Kantenlaengen einer Blockgroesse, auf das Raster begrenzt.
 *
 * Ein XL-Block ist vier Spalten breit – auf einem Raster mit drei Spalten gibt
 * es die vierte nicht. Statt den Block dann abzulehnen, wird er schmaler: die
 * Anordnung bleibt erhalten, wenn jemand das Raster nachtraeglich verkleinert.
 */
export function sizeCells(size: WidgetSize, grid: GridSize): { columns: number; rows: number } {
  const spec = WIDGET_SIZE_SPECS[size] ?? WIDGET_SIZE_SPECS[DEFAULT_WIDGET_SIZE];
  return {
    columns: Math.min(spec.columns, grid.columns),
    rows: Math.min(spec.rows, grid.rows),
  };
}

/** Rechteck einer Platzierung, so weit ins Raster geschoben, dass es hineinpasst. */
export function rectFor(placement: Placement, grid: GridSize): GridRect {
  const { columns, rows } = sizeCells(placement.size, grid);
  return {
    x: clampCell(placement.x, grid.columns - columns),
    y: clampCell(placement.y, grid.rows - rows),
    columns,
    rows,
  };
}

function clampCell(value: unknown, max: number): number {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return 0;
  return Math.min(Math.max(0, max), Math.max(0, num));
}

export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return (
    a.x < b.x + b.columns && b.x < a.x + a.columns && a.y < b.y + b.rows && b.y < a.y + a.rows
  );
}

/**
 * Freier Platz fuer einen Block.
 *
 * In drei Stufen: der Wunschplatz, dann direkt darunter, dann zeilenweise von
 * oben links. Die mittlere Stufe ist der eigentliche Punkt – wer zwei Module
 * an dieselbe Stelle legt, meint "beide hierhin, untereinander" und nicht
 * "irgendwohin". Die letzte Stufe laeuft zeilenweise, weil ein Spiegel von
 * oben nach unten gelesen wird.
 *
 * Ist nichts frei, gibt die Funktion `null` zurueck – der Aufrufer entscheidet,
 * ob er ablehnt oder ueberlappen laesst.
 */
export function findFreeSpot(
  occupied: readonly GridRect[],
  grid: GridSize,
  size: WidgetSize,
  preferred?: { x: number; y: number },
): { x: number; y: number } | null {
  const { columns, rows } = sizeCells(size, grid);
  const free = (x: number, y: number): boolean =>
    !occupied.some((rect) => rectsOverlap(rect, { x, y, columns, rows }));

  if (preferred) {
    const candidate = rectFor({ ...preferred, size }, grid);
    for (let y = candidate.y; y <= grid.rows - rows; y += 1) {
      if (free(candidate.x, y)) return { x: candidate.x, y };
    }
  }

  for (let y = 0; y <= grid.rows - rows; y += 1) {
    for (let x = 0; x <= grid.columns - columns; x += 1) {
      if (free(x, y)) return { x, y };
    }
  }
  return null;
}

/** Lesereihenfolge: erst die Zeile, dann die Spalte. */
export function comparePlacement(a: Placement, b: Placement): number {
  return a.y - b.y || a.x - b.x;
}
