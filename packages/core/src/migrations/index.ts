import { CONFIG_SCHEMA_VERSION, normalizeInsets, normalizeRotation } from '@mirror/sdk';

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
