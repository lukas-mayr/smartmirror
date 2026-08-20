import { copyFile, mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import {
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  FONT_STACKS,
  isZone,
  type MirrorConfig,
  type ModuleInstance,
} from '@mirror/sdk';
import { readJson, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { configFile, dataDir } from './paths.js';
import { migrateToLatest } from './migrations/index.js';

const log = createLogger('config');

export class ConfigStore extends EventEmitter {
  #config: MirrorConfig = createDefaultConfig();

  get current(): MirrorConfig {
    return this.#config;
  }

  async load(): Promise<MirrorConfig> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const raw = await readJson<Record<string, unknown>>(configFile);

    if (!raw) {
      log.info('Keine Konfiguration gefunden – lege Standardkonfiguration an.');
      this.#config = createDefaultConfig();
      await this.#persist();
      return this.#config;
    }

    const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
    if (version < CONFIG_SCHEMA_VERSION) {
      // Sicherung vor jeder Migration – ein misslungener Schemawechsel darf
      // die einzige Kopie der Nutzereinstellungen nicht kosten.
      const backup = `${configFile}.bak-v${version}`;
      await copyFile(configFile, backup).catch((error: unknown) => {
        log.warn('Sicherung der Konfiguration fehlgeschlagen', error);
      });
    }

    const { config: migrated, changed } = migrateToLatest(raw, (message) => log.info(message));
    this.#config = normalize(migrated);
    if (changed) await this.#persist();
    return this.#config;
  }

  /**
   * Ersetzt die Konfiguration und schreibt sie weg. `emit` weckt alle
   * Interessenten (Modul-Host, Power-Steuerung, Clients).
   */
  async update(mutate: (draft: MirrorConfig) => void): Promise<MirrorConfig> {
    const draft = structuredClone(this.#config);
    mutate(draft);
    const next = normalize(draft as unknown as Record<string, unknown>);
    const previous = this.#config;
    this.#config = next;
    await this.#persist();
    this.emit('change', next, previous);
    return next;
  }

  async #persist(): Promise<void> {
    await writeJsonAtomic(configFile, this.#config);
  }
}

/**
 * Bringt eine geladene oder bearbeitete Konfiguration in einen garantiert
 * benutzbaren Zustand. Das ist die einzige Stelle, an der Werte aus Datei oder
 * Fernbedienung repariert werden – danach darf sich alles darauf verlassen.
 */
function normalize(input: Record<string, unknown>): MirrorConfig {
  const defaults = createDefaultConfig();
  const source = input as Partial<MirrorConfig>;

  const seenIds = new Set<string>();
  const instances: ModuleInstance[] = (Array.isArray(source.instances) ? source.instances : [])
    .filter((entry): entry is ModuleInstance => typeof entry?.id === 'string' && typeof entry?.moduleId === 'string')
    .filter((entry) => {
      if (seenIds.has(entry.id)) {
        log.warn(`Doppelte Instanz-ID "${entry.id}" verworfen.`);
        return false;
      }
      seenIds.add(entry.id);
      return true;
    })
    .map((entry, index) => ({
      id: entry.id,
      moduleId: entry.moduleId,
      zone: isZone(entry.zone) ? entry.zone : 'top-center',
      order: Number.isFinite(entry.order) ? Number(entry.order) : index,
      enabled: entry.enabled !== false,
      config: typeof entry.config === 'object' && entry.config !== null ? entry.config : {},
    }));

  const display = { ...defaults.display, ...(source.display ?? {}) };
  display.brightness = clamp(display.brightness, 10, 100);
  display.paddingPercent = clamp(display.paddingPercent, 0, 15);
  // Eine Schrift, die es nicht gibt, wuerde in der Anzeige stumm auf die
  // Systemschrift zurueckfallen – lieber hier auf den Standard zurechtruecken.
  if (!(display.fontFamily in FONT_STACKS)) display.fontFamily = defaults.display.fontFamily;

  const power = { ...defaults.power, ...(source.power ?? {}) };
  power.rules = (Array.isArray(power.rules) ? power.rules : []).filter(
    (rule) => typeof rule?.on === 'string' && typeof rule?.off === 'string' && Array.isArray(rule?.days),
  );

  const update = { ...defaults.update, ...(source.update ?? {}) };
  update.checkIntervalMinutes = clamp(update.checkIntervalMinutes, 5, 1440);
  if (update.channel !== 'beta') update.channel = 'stable';

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceName: source.deviceName || defaults.deviceName,
    locale: source.locale || defaults.locale,
    timezone: source.timezone || defaults.timezone,
    instances,
    display,
    power,
    update,
  };
}

function clamp(value: unknown, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}
