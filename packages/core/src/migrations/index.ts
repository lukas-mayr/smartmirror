import {
  CONFIG_SCHEMA_VERSION,
  createScreen,
  DEFAULT_GRID,
  findFreeSpot,
  normalizeInsets,
  normalizeRotation,
  rectFor,
  sizeCells,
  type GridRect,
  type GridSize,
  type WidgetSize,
} from '@mirror/sdk';

/**
 * Eine Migration hebt die Config von `from` auf `from + 1`.
 *
 * Regeln: nie eine bestehende Migration nachtraeglich aendern (Geraete koennen
 * beliebig alte Staende haben), immer eine neue anhaengen. Der Config-Store
 * legt vor dem Lauf eine Sicherung an.
 */
export interface Migration {
  from: number;
  describe: string;
  migrate(config: Record<string, unknown>): Record<string, unknown>;
}

export const migrations: readonly Migration[] = [
  {
    from: 1,
    describe: 'display.rotation ergaenzt',
    migrate: (config) => {
      const display = (config.display ?? {}) as Record<string, unknown>;
      // Einen vorhandenen Wert nicht ueberschreiben: nach einem
      // zurueckgerollten Update steht die Versionsnummer wieder auf 1, die
      // Drehung aber schon in der Datei – und der Spiegel haengt weiterhin
      // hochkant an der Wand.
      return { ...config, display: { ...display, rotation: normalizeRotation(display.rotation) } };
    },
  },
  {
    from: 2,
    describe: 'display.paddingPercent wird zu display.insets, Einrichtungsstand ergaenzt',
    migrate: (config) => {
      const display = (config.display ?? {}) as Record<string, unknown>;
      // Der alte Wert galt fuer alle vier Seiten. Ihn als Startpunkt zu
      // uebernehmen heisst: nach dem Update sieht der Spiegel genauso aus wie
      // vorher, und die neuen Seitenwerte sind trotzdem sofort da.
      const insets = normalizeInsets(display.insets ?? display.paddingPercent);
      const { paddingPercent: _legacy, ...rest } = display;

      // Wer schon einen laufenden Spiegel hat, soll nach dem Update nicht
      // ploetzlich vor einer Einrichtung stehen. Ohne Zeitstempel: der
      // Durchlauf hat nie stattgefunden, und der Start setzt ihn wieder auf
      // Anfang, falls noch gar kein Handy gekoppelt ist.
      const setup = config.setup ?? { step: 'done', completedAt: null };

      return { ...config, display: { ...rest, insets }, setup };
    },
  },
  {
    from: 3,
    describe: 'Zonen werden zu Rasterplaetzen, erster Screen angelegt',
    migrate: (config) => {
      const display = (config.display ?? {}) as Record<string, unknown>;
      // Hochkant aufgehaengt heisst hochkantes Raster: sechs Zeilen und vier
      // Spalten statt umgekehrt. Sonst waeren die Zellen nach dem Update
      // liegende Rechtecke auf einem stehenden Bildschirm.
      const upright = normalizeRotation(display.rotation) % 180 !== 0;
      const grid: GridSize = upright
        ? { columns: DEFAULT_GRID.rows, rows: DEFAULT_GRID.columns }
        : { ...DEFAULT_GRID };

      const screens = Array.isArray(config.screens) && config.screens.length > 0
        ? config.screens
        : [createScreen('screen-1', 'Screen 1')];
      const screenId = (screens[0] as { id?: string }).id ?? 'screen-1';

      const legacy = (Array.isArray(config.instances) ? config.instances : []) as Record<string, unknown>[];
      const taken: GridRect[] = [];
      const instances = legacy
        // In der Zone bestimmte bisher `order` die Reihenfolge. Sie
        // entscheidet jetzt, wer sich den Wunschplatz zuerst nimmt.
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => Number(a.entry.order ?? a.index) - Number(b.entry.order ?? b.index))
        .map(({ entry }) => {
          // Eine Config, die schon Rasterplaetze hat, kommt aus einem
          // zurueckgerollten Update – ihre Werte bleiben stehen.
          const size = (typeof entry.size === 'string' ? entry.size : 'm') as WidgetSize;
          const preferred =
            typeof entry.x === 'number' && typeof entry.y === 'number'
              ? { x: entry.x, y: entry.y }
              : zoneAnchor(String(entry.zone ?? 'top-center'), size, grid);
          const spot = findFreeSpot(taken, grid, size, preferred) ?? preferred;
          taken.push(rectFor({ ...spot, size }, grid));

          const { zone: _zone, order: _order, ...rest } = entry;
          return {
            ...rest,
            screenId: typeof entry.screenId === 'string' ? entry.screenId : screenId,
            x: spot.x,
            y: spot.y,
            size,
          };
        });

      return { ...config, screens, instances, display: { ...display, grid } };
    },
  },
];

export function migrateToLatest(
  config: Record<string, unknown>,
  log: (message: string) => void,
): { config: Record<string, unknown>; changed: boolean } {
  let current = config;
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0;
  let changed = false;

  if (version > CONFIG_SCHEMA_VERSION) {
    // Downgrade nach fehlgeschlagenem Update: die Config ist neuer als der Code.
    // Wir brechen nicht ab, sondern arbeiten mit ihr weiter – unbekannte Felder
    // werden ignoriert, bekannte funktionieren.
    log(`Config hat Version ${version}, Code erwartet ${CONFIG_SCHEMA_VERSION}. Fahre schreibgeschuetzt fort.`);
    return { config: current, changed: false };
  }

  while (version < CONFIG_SCHEMA_VERSION) {
    const migration = migrations.find((m) => m.from === version);
    if (!migration) {
      log(`Keine Migration von Version ${version} gefunden – setze Version hoch.`);
      version = CONFIG_SCHEMA_VERSION;
      current = { ...current, schemaVersion: version };
      changed = true;
      break;
    }
    log(`Migriere Config ${version} -> ${version + 1}: ${migration.describe}`);
    current = migration.migrate(current);
    version += 1;
    current = { ...current, schemaVersion: version };
    changed = true;
  }

  return { config: current, changed };
}

/**
 * Wunschplatz einer alten Zone im neuen Raster.
 *
 * Die neun Zonen waren ein Drei-mal-drei-Raster mit Ausrichtung: "oben rechts"
 * hiess oben und rechtsbuendig. Genau das wird hier zur Ecke, an der der Block
 * ab jetzt klebt – wer seinen Spiegel eingerichtet hatte, findet nach dem
 * Update alles ungefaehr dort wieder, wo es vorher war.
 */
function zoneAnchor(zone: string, size: WidgetSize, grid: GridSize): { x: number; y: number } {
  const cells = sizeCells(size, grid);
  const [row = 'top', column = 'center'] = zone.split('-');
  const x =
    column === 'left' ? 0 : column === 'right' ? grid.columns - cells.columns : Math.floor((grid.columns - cells.columns) / 2);
  const y =
    row === 'top' ? 0 : row === 'bottom' ? grid.rows - cells.rows : Math.floor((grid.rows - cells.rows) / 2);
  return { x: Math.max(0, x), y: Math.max(0, y) };
}
