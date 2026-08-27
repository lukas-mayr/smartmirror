import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MirrorConfig, OutletSettings, OutletStatus, PowerRule } from '@mirror/sdk';
import { OutletError, readReport, setRelay } from './mystrom.js';
import { createLogger } from './logger.js';

const run = promisify(execFile);
const log = createLogger('power');

const TICK_MS = 20_000;
/** Alle wie viele Ticks die Steckdose gefragt wird, wenn nichts geschaltet wird. */
const OUTLET_TICKS = 3;

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
  #outlet: OutletStatus = idleOutlet(false, false);
  /**
   * Der Token der Steckdose wird bei jedem Aufruf frisch geholt und nirgends
   * hier gehalten: der Geheimnisspeicher ist die einzige Ablage dafuer.
   */
  #readToken: () => string;
  /**
   * Anfragen an die Steckdose laufen nacheinander.
   *
   * Zwei gleichzeitig braeuchte niemand, und die Reihenfolge waere nicht
   * garantiert: eine Abfrage, die sich mit einem Schaltbefehl kreuzt, koennte
   * hinterher den alten Stand melden.
   */
  #outletQueue: Promise<void> = Promise.resolve();
  #outletPending = 0;
  /** Ticks bis zur naechsten Abfrage der Steckdose. */
  #outletCountdown = 0;
  /** Stand, auf den die Steckdose zuletzt gebracht wurde. `null`: unbekannt. */
  #outletDesired: boolean | null = null;
  /** Zeitplan-Zustand beim letzten Tick – daran haengt, ob gerade gewechselt wurde. */
  #lastScheduled: boolean | null = null;
  /**
   * Darf sich der Spiegel selbst vom Strom nehmen?
   *
   * Nur nach einem Wechsel des Zeitplans von "an" auf "aus", den dieser
   * Prozess selbst gesehen hat. Ohne diese Sperre entstuende die Schleife, vor
   * der auch die Neustart-Bruecke sich huetet: wer waehrend eines Aus-Fensters
   * einschaltet, bekaeme sofort wieder den Strom abgedreht und den Spiegel nie
   * zu sehen. Und ein Griff ans Handy darf es nie – eingeschaltet bekaeme
   * dieselbe App den Spiegel danach nicht mehr.
   */
  #selfCutPending = false;

  constructor(config: MirrorConfig, readToken: () => string = () => '') {
    super();
    this.#config = config;
    this.#readToken = readToken;
    this.#outlet = idleOutlet(outletActive(config), readToken() !== '');
  }

  get isOn(): boolean {
    return this.#on;
  }

  get outletStatus(): OutletStatus {
    return this.#outlet;
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
    const outletChanged = !sameOutlet(config.power.outlet, this.#config.power.outlet);
    this.#config = config;
    if (brightnessChanged) void this.applyBrightness(config.display.brightness);
    if (outletChanged) {
      // Eine frisch eingetippte Adresse soll sofort etwas sagen und nicht bis
      // zum Abend schweigen. Geschaltet wird dabei nicht: eine Aenderung an
      // den Einstellungen ist kein Wechsel im Zeitplan.
      this.#outlet = idleOutlet(outletActive(config), this.#readToken() !== '');
      this.#outletDesired = null;
      this.emit('outlet', this.#outlet);
      void this.#refreshOutlet();
    }
    void this.#evaluate();
  }

  /** Manuelle Uebersteuerung vom Handy. Gilt bis zum naechsten Zeitplanwechsel. */
  async setManual(on: boolean): Promise<void> {
    this.#overrideBaseline = scheduledState(this.#config);
    await this.#apply(on);
    await this.#syncOutlet(on);
    this.emit('override', { active: true, on });
  }

  clearManual(): void {
    this.#overrideBaseline = null;
    void this.#evaluate();
  }

  /** Die Steckdose jetzt fragen – der Knopf "Verbindung pruefen" in der App. */
  async checkOutlet(): Promise<OutletStatus> {
    await this.#refreshOutlet(true);
    return this.#outlet;
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
    if (this.#outletCountdown > 0) this.#outletCountdown -= 1;
    else void this.#refreshOutlet();

    const scheduled = scheduledState(this.#config);
    // Ein Wechsel ist etwas anderes als ein Zustand: nur er darf die Steckdose
    // ausschalten, an der womoeglich der Spiegel selbst haengt.
    if (scheduled) this.#selfCutPending = false;
    else if (this.#lastScheduled === true) this.#selfCutPending = true;
    this.#lastScheduled = scheduled;

    const override = this.#config.power.manualOverride;

    if (override?.active && this.#overrideBaseline !== null) {
      if (scheduled === this.#overrideBaseline) {
        // Zeitplan hat noch nicht gewechselt – Uebersteuerung gilt weiter.
        await this.#apply(override.on);
        await this.#syncOutlet(override.on);
        return;
      }
      log.info('Zeitplan hat gewechselt – manuelle Uebersteuerung aufgehoben.');
      this.#overrideBaseline = null;
      this.emit('override', null);
    }

    await this.#apply(scheduled);
    // Ausserhalb von #apply, weil das dort frueh abbricht, wenn sich am
    // Display nichts aendert: wer abends von Hand abschaltet, haette sonst
    // eine Steckdose, die die ganze Nacht anbleibt.
    await this.#syncOutlet(scheduled);
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

  /**
   * Bringt die Steckdose auf denselben Stand wie das Display – soweit das
   * ueberhaupt geht.
   *
   * Haengt der Spiegel selbst an der Dose, ist nur eine Richtung moeglich, und
   * auch die nur nach einem Wechsel des Zeitplans. Geschaltet wird nur bei
   * Aenderung: wer den Knopf an der Dose drueckt, soll nicht zwanzig Sekunden
   * spaeter dagegen anschalten muessen.
   */
  async #syncOutlet(on: boolean): Promise<void> {
    const outlet = this.#config.power.outlet;
    if (!outlet.enabled || !outlet.host) {
      this.#outletDesired = null;
      return;
    }
    if (on === this.#outletDesired) return;

    if (outlet.scope === 'mirror') {
      // Laeuft der Spiegel, ist die Dose an. Da gibt es nichts einzuschalten.
      if (on) {
        this.#outletDesired = true;
        return;
      }
      if (!this.#selfCutPending) return;
      log.info('Zeitplan schaltet die Steckdose aus – der Spiegel geht damit selbst aus.');
    }

    this.#outletDesired = on;
    await this.#talkToOutlet(() => setRelay(outlet.host, on, this.#readToken()));
    // Hat es nicht geklappt, bleibt es zu tun: eine Dose, die gerade nicht
    // antwortet, soll beim naechsten Tick wieder gefragt werden.
    if (!this.#outlet.reachable) this.#outletDesired = null;
  }

  /** Zustand der Steckdose auffrischen, ohne zu schalten. */
  async #refreshOutlet(force = false): Promise<void> {
    const outlet = this.#config.power.outlet;
    // Der Abstand ist kein Sparzwang, sondern Ruhe im Log und im Netz: der
    // Zeitplan tickt schneller, als sich an einer Steckdose etwas aendert.
    this.#outletCountdown = OUTLET_TICKS;
    if (!outlet.enabled || !outlet.host) {
      if (this.#outlet.configured) {
        this.#outlet = idleOutlet(false, this.#readToken() !== '');
        this.emit('outlet', this.#outlet);
      }
      return;
    }
    // Eine Abfrage darf ausfallen, solange ohnehin schon jemand mit der Dose
    // spricht – ein Schaltbefehl nie.
    await this.#talkToOutlet(() => readReport(outlet.host, this.#readToken()), !force);
  }

  async #talkToOutlet(
    action: () => Promise<{ relay: boolean; watts: number }>,
    skipIfBusy = false,
  ): Promise<void> {
    if (skipIfBusy && this.#outletPending > 0) return;
    this.#outletPending += 1;
    const next = this.#outletQueue.then(() => this.#runOutlet(action));
    this.#outletQueue = next;
    try {
      await next;
    } finally {
      this.#outletPending -= 1;
    }
  }

  /** Einmal mit der Dose sprechen. Wirft nicht: der Fehler ist das Ergebnis. */
  async #runOutlet(action: () => Promise<{ relay: boolean; watts: number }>): Promise<void> {
    try {
      const report = await action();
      this.#publishOutlet({
        configured: true,
        reachable: true,
        relay: report.relay,
        watts: report.watts,
        hasToken: this.#readToken() !== '',
        error: null,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof OutletError ? error.message : 'Die Steckdose ist nicht erreichbar.';
      // Nur beim ersten Mal laut: eine Dose, die eine Nacht lang weg ist,
      // soll das Journal nicht fuellen.
      if (this.#outlet.error !== message) log.warn(`Steckdose: ${message}`);
      this.#publishOutlet({
        configured: true,
        reachable: false,
        relay: null,
        watts: null,
        hasToken: this.#readToken() !== '',
        error: message,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  #publishOutlet(next: OutletStatus): void {
    const previous = this.#outlet;
    this.#outlet = next;
    // Der Zeitstempel aendert sich bei jeder Abfrage; ihn allein zu melden
    // hiesse, die Handy-App im Minutentakt ohne Neuigkeit zu wecken.
    if (
      previous.configured === next.configured &&
      previous.reachable === next.reachable &&
      previous.relay === next.relay &&
      previous.watts === next.watts &&
      previous.hasToken === next.hasToken &&
      previous.error === next.error
    ) {
      return;
    }
    this.emit('outlet', next);
  }
}

function idleOutlet(configured: boolean, hasToken: boolean): OutletStatus {
  return { configured, reachable: false, relay: null, watts: null, hasToken, error: null, checkedAt: null };
}

function outletActive(config: MirrorConfig): boolean {
  return config.power.outlet.enabled && config.power.outlet.host !== '';
}

function sameOutlet(a: OutletSettings, b: OutletSettings): boolean {
  return a.enabled === b.enabled && a.host === b.host && a.scope === b.scope;
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
