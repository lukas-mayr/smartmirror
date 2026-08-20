import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MirrorConfig, PowerRule } from '@mirror/sdk';
import { createLogger } from './logger.js';

const run = promisify(execFile);
const log = createLogger('power');

const TICK_MS = 20_000;

/**
 * Steuert, ob der Spiegel leuchtet.
 *
 * Zwei Ebenen, absichtlich: Der Core versucht, das Panel per wlr-randr
 * abzuschalten (dann ist wirklich Ruhe und das Panel altert nicht), und
 * verteilt zusaetzlich den logischen Zustand an die Shell. Wo die
 * Hardware-Abschaltung nicht greift – Entwicklung auf dem Mac, Monitore ohne
 * brauchbares DPMS – rendert die Shell einfach Schwarz. Der Spiegel ist damit
 * in jedem Fall dunkel, nur die Hintergrundbeleuchtung bleibt an.
 */
export class PowerController extends EventEmitter {
  #on = true;
  #config: MirrorConfig;
  #timer: NodeJS.Timeout | null = null;
  #output: string | null = null;
  /** Zeitplan-Zustand, als die manuelle Uebersteuerung gesetzt wurde. */
  #overrideBaseline: boolean | null = null;
  #hardwareAvailable = true;

  constructor(config: MirrorConfig) {
    super();
    this.#config = config;
  }

  get isOn(): boolean {
    return this.#on;
  }

  async start(): Promise<void> {
    this.#output = await detectOutput();
    if (!this.#output) {
      this.#hardwareAvailable = false;
      log.info('Kein wlr-randr-Ausgang gefunden – Display wird nur softwareseitig abgedunkelt.');
    }
    this.#timer = setInterval(() => void this.#evaluate(), TICK_MS);
    this.#timer.unref();
    await this.#evaluate();
    await this.applyBrightness(this.#config.display.brightness);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  onConfigChange(config: MirrorConfig): void {
    const brightnessChanged = config.display.brightness !== this.#config.display.brightness;
    this.#config = config;
    if (brightnessChanged) void this.applyBrightness(config.display.brightness);
    void this.#evaluate();
  }

  /** Manuelle Uebersteuerung vom Handy. Gilt bis zum naechsten Zeitplanwechsel. */
  async setManual(on: boolean): Promise<void> {
    this.#overrideBaseline = scheduledState(this.#config);
    await this.#apply(on);
    this.emit('override', { active: true, on });
  }

  clearManual(): void {
    this.#overrideBaseline = null;
    void this.#evaluate();
  }

  async applyBrightness(percent: number): Promise<void> {
    if (!this.#hardwareAvailable) return;
    try {
      // Nicht jeder Monitor spricht DDC/CI. Schlaegt es fehl, bleibt die
      // CSS-Abdunklung in der Shell als Rueckfallebene – daher nur debug.
      await run('ddcutil', ['setvcp', '10', String(Math.round(percent))], { timeout: 5_000 });
      log.debug(`Helligkeit per DDC/CI auf ${percent}% gesetzt.`);
    } catch {
      log.debug('ddcutil nicht verfuegbar – Helligkeit wird in der Anzeige geregelt.');
    }
  }

  async #evaluate(): Promise<void> {
    const scheduled = scheduledState(this.#config);
    const override = this.#config.power.manualOverride;

    if (override?.active && this.#overrideBaseline !== null) {
      if (scheduled === this.#overrideBaseline) {
        // Zeitplan hat noch nicht gewechselt – Uebersteuerung gilt weiter.
        await this.#apply(override.on);
        return;
      }
      log.info('Zeitplan hat gewechselt – manuelle Uebersteuerung aufgehoben.');
      this.#overrideBaseline = null;
      this.emit('override', null);
    }

    await this.#apply(scheduled);
  }

  async #apply(on: boolean): Promise<void> {
    if (on === this.#on) return;
    this.#on = on;
    log.info(`Display ${on ? 'ein' : 'aus'}.`);
    this.emit('change', on);

    if (!this.#output) return;
    try {
      await run('wlr-randr', ['--output', this.#output, on ? '--on' : '--off'], { timeout: 5_000 });
    } catch (error) {
      // Kein harter Fehler: die Shell hat den Zustand bereits bekommen.
      log.warn('wlr-randr fehlgeschlagen – Anzeige regelt selbst ab.', error);
      this.#hardwareAvailable = false;
    }
  }
}

/** Ist laut Zeitplan gerade "an"? Ohne aktiven Zeitplan immer true. */
export function scheduledState(config: MirrorConfig, now = new Date()): boolean {
  if (!config.power.scheduleEnabled) return true;
  const rules = config.power.rules;
  if (rules.length === 0) return true;

  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const applicable = rules.filter((rule) => rule.days.includes(day));
  if (applicable.length === 0) return false;
  return applicable.some((rule) => withinWindow(rule, minutes));
}

function withinWindow(rule: PowerRule, minutes: number): boolean {
  const on = parseClock(rule.on);
  const off = parseClock(rule.off);
  if (on === null || off === null) return true;
  // Fenster ueber Mitternacht, z.B. an 20:00 / aus 02:00.
  if (off <= on) return minutes >= on || minutes < off;
  return minutes >= on && minutes < off;
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Ermittelt den ersten aktiven Wayland-Ausgang. */
async function detectOutput(): Promise<string | null> {
  try {
    const { stdout } = await run('wlr-randr', [], { timeout: 5_000 });
    // wlr-randr listet Ausgaenge am Zeilenanfang: "HDMI-A-1 "Samsung ...""
    const match = /^(\S+)\s/m.exec(stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
