import { copyFile, mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import {
  CONFIG_SCHEMA_VERSION,
  createDefaultConfig,
  findFreeSpot,
  FONT_STACKS,
  normalizeGrid,
  normalizeInsets,
  normalizeNightMode,
  normalizeRotation,
  normalizeScreens,
  normalizeSetup,
  normalizeWidgetSize,
  normalizeZone,
  rectFor,
  rectsOverlap,
  type GridRect,
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

  const screens = normalizeScreens(source.screens);
  const screenIds = new Set(screens.map((screen) => screen.id));

  const display = { ...defaults.display, ...(source.display ?? {}) };
  display.brightness = clamp(display.brightness, 10, 100);
  display.grid = normalizeGrid(display.grid);
  // Zweites Argument: eine Config aus der Zeit vor den vier Raendern kennt nur
  // `paddingPercent`. Die Migration rechnet das um – hier steht es trotzdem
  // noch einmal, weil `normalize` auch auf von Hand editierte Dateien und auf
  // Teil-Patches aus der Handy-App laeuft.
  display.insets = normalizeInsets(
    display.insets,
    Number((display as unknown as { paddingPercent?: unknown }).paddingPercent ?? defaults.display.insets.top),
  );
  delete (display as unknown as { paddingPercent?: unknown }).paddingPercent;
  // Eine krumme Gradzahl wuerde die Anzeige stumm auf "quer" zurueckfallen
  // lassen – und wer sie von Hand in die Datei geschrieben hat, saehe nur einen
  // querstehenden Spiegel und keinen Grund dafuer.
  display.rotation = normalizeRotation(display.rotation);
  // Eine Nachtabsenkung mit "25:00" waere nie aktiv, und man saehe nicht warum.
  display.nightMode = normalizeNightMode(display.nightMode);
  // Eine Schrift, die es nicht gibt, wuerde in der Anzeige stumm auf die
  // Systemschrift zurueckfallen – lieber hier auf den Standard zurechtruecken.
  if (!(display.fontFamily in FONT_STACKS)) display.fontFamily = defaults.display.fontFamily;

  const seenIds = new Set<string>();
  // Belegte Rechtecke je Screen, damit sich zwei Bloecke nicht ueberdecken.
  const occupied = new Map<string, GridRect[]>();

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
    .map((entry) => {
      // Ein Block auf einem geloeschten Screen waere unsichtbar und in der
      // Handy-App nicht mehr erreichbar – er kommt auf den ersten Screen.
      const screenId = screenIds.has(entry.screenId) ? entry.screenId : screens[0]!.id;
      const size = normalizeWidgetSize(entry.size);
      const visible = entry.visible !== false;
      const taken = occupied.get(screenId) ?? [];
      let rect = rectFor({ x: entry.x, y: entry.y, size }, display.grid);

      /*
       * Wer keinen Platz belegt, braucht auch keinen zugewiesen zu bekommen.
       *
       * Ein ausgeblendeter Block behaelt seine Koordinaten fuer den Tag, an
       * dem er wieder eingeblendet wird — aber er darf keinem sichtbaren den
       * Platz wegnehmen und nicht vor einem Ueberlappen ausweichen, das es auf
       * dem Schirm gar nicht gibt.
       */
      if (!visible) {
        return {
          id: entry.id,
          moduleId: entry.moduleId,
          screenId,
          x: rect.x,
          y: rect.y,
          zone: normalizeZone(entry.zone),
          size,
          enabled: entry.enabled !== false,
          visible,
          config: typeof entry.config === 'object' && entry.config !== null ? entry.config : {},
        };
      }

      if (taken.some((other) => rectsOverlap(other, rect))) {
        // Ueblicher Fall: jemand hat das Raster verkleinert, und zwei Bloecke
        // sind aufeinander gerutscht. Der spaetere weicht aus.
        const spot = findFreeSpot(taken, display.grid, size, { x: rect.x, y: rect.y });
        // Kein freier Platz: lieber uebereinander als verschwunden. Am Handy
        // ist der Block dann sichtbar im Weg und laesst sich verschieben.
        if (spot) rect = { ...rect, ...spot };
        else log.warn(`Fuer "${entry.id}" ist kein freier Platz im Raster – der Block liegt ueber einem anderen.`);
      }
      taken.push(rect);
      occupied.set(screenId, taken);

      return {
        id: entry.id,
        moduleId: entry.moduleId,
        screenId,
        x: rect.x,
        y: rect.y,
        zone: normalizeZone(entry.zone),
        size,
        enabled: entry.enabled !== false,
        visible,
        config: typeof entry.config === 'object' && entry.config !== null ? entry.config : {},
      };
    });
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
    screens,
    instances,
    display,
    power,
    update,
    setup: normalizeSetup(source.setup),
  };
}

function clamp(value: unknown, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}
