import {
  DEFAULT_FONT,
  FONT_STACKS,
  validate,
  ZONES,
  type MirrorConfig,
  type ModuleDescriptor,
  type ModuleInstance,
  type ModuleStateEnvelope,
  type ModuleView,
  type ServerMessage,
  type Zone,
} from '@mirror/sdk';
import type { CoreConnection, ConnectionState } from './connection.js';
import { loadModuleFrontend } from './module-loader.js';

interface MountedInstance {
  instance: ModuleInstance;
  host: HTMLElement;
  view: ModuleView | null;
  moduleVersion: string;
  /**
   * Konfiguration nach Schema-Validierung, also mit gefuellten Defaults.
   * Modul-Frontends muessen dieselbe Sicht bekommen wie die Backends – sonst
   * verhaelt sich ein Modul unterschiedlich, je nachdem ob eine Einstellung
   * jemals von Hand gesetzt wurde.
   */
  config: Record<string, unknown>;
}

const BURN_IN_INTERVAL_MS = 15 * 60_000;
/** Wanderpfad des Einbrennschutzes in Pixeln. Klein genug, um nicht aufzufallen. */
const BURN_IN_PATH: readonly [number, number][] = [
  [0, 0],
  [4, 3],
  [0, 6],
  [-4, 3],
  [-4, -3],
  [0, -6],
  [4, -3],
];

export class MirrorApp {
  #grid: HTMLElement;
  #dim: HTMLElement;
  #overlay: HTMLElement;
  #status: HTMLElement;
  #connection: CoreConnection;
  #coreUrl: string;

  #zones = new Map<Zone, HTMLElement>();
  #mounted = new Map<string, MountedInstance>();
  #descriptors = new Map<string, ModuleDescriptor>();
  #states = new Map<string, ModuleStateEnvelope>();
  #config: MirrorConfig | null = null;
  #powerOn = true;
  #burnInIndex = 0;
  #ready = false;

  constructor(stage: HTMLElement, connection: CoreConnection, coreUrl: string) {
    this.#grid = stage.querySelector('#grid') as HTMLElement;
    this.#dim = stage.querySelector('#dim') as HTMLElement;
    this.#overlay = stage.querySelector('#overlay') as HTMLElement;
    this.#connection = connection;
    this.#coreUrl = coreUrl;

    this.#status = document.createElement('div');
    this.#status.className = 'status';
    stage.append(this.#status);

    this.#buildZones();
    this.#startBurnInProtection();
  }

  handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        if (message.needsPairing) {
          this.#showOverlay(
            'Spiegel koppeln',
            null,
            'Oeffne die Spiegel-App auf dem Handy und gib den Code ein, sobald er hier erscheint.',
          );
        }
        return;

      case 'snapshot':
        this.#descriptors = new Map(message.modules.map((entry) => [entry.id, entry]));
        this.#states = new Map(Object.entries(message.state));
        this.#powerOn = message.power.on;
        this.#applyConfig(message.config);
        this.#applyPower();
        this.#hideOverlay();
        if (!this.#ready) {
          this.#ready = true;
          // Signal fuer den Healthcheck des Updaters: die Anzeige rendert
          // tatsaechlich Inhalte, nicht nur ein schwarzes Fenster.
          this.#connection.send({ t: 'shell:ready', appVersion: this.#appVersion() });
        }
        return;

      case 'config:update':
        this.#applyConfig(message.config);
        return;

      case 'modules:update':
        this.#descriptors = new Map(message.modules.map((entry) => [entry.id, entry]));
        if (this.#config) this.#applyConfig(this.#config);
        return;

      case 'state:patch': {
        const previous = this.#states.get(message.envelope.instanceId);
        const merged: ModuleStateEnvelope = {
          instanceId: message.envelope.instanceId,
          patch: { ...(previous?.patch ?? {}), ...message.envelope.patch },
          error: message.envelope.error ?? null,
          updatedAt: message.envelope.updatedAt ?? previous?.updatedAt,
        };
        this.#states.set(merged.instanceId, merged);
        this.#pushState(merged);
        return;
      }

      case 'display:power':
        this.#powerOn = message.on;
        this.#applyPower();
        return;

      case 'pair:code':
        if (message.code) {
          this.#showOverlay('Spiegel koppeln', message.code, 'Diesen Code in der Spiegel-App eingeben.');
        } else {
          this.#hideOverlay();
        }
        return;

      case 'error':
        console.error(`[shell] ${message.code}: ${message.message}`);
        return;

      default:
        return;
    }
  }

  setConnectionState(state: ConnectionState): void {
    // Waehrend eines Updates ist der Core kurz weg. Das ist kein Fehler, den
    // man gross anzeigen muesste – ein kleiner Hinweis unten rechts genuegt.
    const visible = state !== 'online';
    this.#status.textContent = state === 'connecting' ? 'verbinde …' : 'keine Verbindung';
    this.#status.classList.toggle('status--visible', visible);
  }

  /* ---------------------------------- intern --------------------------------- */

  #appVersion(): string {
    return (window as unknown as { mirror?: { version: string } }).mirror?.version ?? '0.0.0';
  }

  #buildZones(): void {
    for (const zone of ZONES) {
      const element = document.createElement('section');
      element.className = `zone zone--${zone}`;
      element.dataset.zone = zone;
      this.#grid.append(element);
      this.#zones.set(zone, element);
    }
  }

  #applyConfig(config: MirrorConfig): void {
    this.#config = config;
    // Die Drehung greift damit auch fuer den Kopplungscode: die Anzeige
    // bekommt ihre Konfiguration direkt beim Verbinden, lange bevor ein Handy
    // ueberhaupt gekoppelt ist.
    document.documentElement.dataset.rotation = String(config.display.rotation);
    document.documentElement.style.setProperty('--mirror-padding', `${config.display.paddingPercent}%`);
    document.documentElement.style.setProperty(
      '--mirror-font',
      FONT_STACKS[config.display.fontFamily] ?? FONT_STACKS[DEFAULT_FONT],
    );
    this.#applyPower();

    const desired = config.instances
      .filter((instance) => instance.enabled)
      .sort((a, b) => a.order - b.order);
    const desiredIds = new Set(desired.map((instance) => instance.id));

    for (const [id, mounted] of [...this.#mounted]) {
      if (!desiredIds.has(id)) this.#unmount(id, mounted);
    }

    for (const instance of desired) {
      const descriptor = this.#descriptors.get(instance.moduleId);
      const version = descriptor?.version ?? '0.0.0';
      const existing = this.#mounted.get(instance.id);

      if (existing && existing.moduleVersion === version) {
        existing.instance = instance;
        existing.config = this.#effectiveConfig(instance, descriptor);
        const zone = this.#zones.get(instance.zone);
        // Auch bei unveraenderter Zone neu anhaengen: das stellt die
        // Reihenfolge innerhalb der Zone wieder her.
        zone?.append(existing.host);
        this.#pushState(this.#states.get(instance.id), existing);
        continue;
      }

      if (existing) this.#unmount(instance.id, existing);
      void this.#mount(instance, version);
    }
  }

  async #mount(instance: ModuleInstance, moduleVersion: string): Promise<void> {
    const host = document.createElement('div');
    host.className = `module module--${instance.moduleId}`;
    host.dataset.instance = instance.id;
    this.#zones.get(instance.zone)?.append(host);

    const descriptor = this.#descriptors.get(instance.moduleId);
    const mounted: MountedInstance = {
      instance,
      host,
      view: null,
      moduleVersion,
      config: this.#effectiveConfig(instance, descriptor),
    };
    this.#mounted.set(instance.id, mounted);
    if (descriptor?.loadError) {
      host.classList.add('module--failed');
      host.textContent = `${descriptor.name}: ${descriptor.loadError}`;
      return;
    }

    try {
      const frontend = await loadModuleFrontend(this.#coreUrl, instance.moduleId, moduleVersion);
      // Waehrend des Ladens kann die Instanz schon wieder entfernt worden sein.
      if (this.#mounted.get(instance.id) !== mounted) return;

      mounted.view = frontend.create(host, {
        instanceId: instance.id,
        moduleId: instance.moduleId,
        config: mounted.config,
        locale: this.#config?.locale ?? 'de-DE',
        timezone: this.#config?.timezone ?? 'Europe/Vienna',
        sendCommand: (name, payload) =>
          this.#connection.send({ t: 'command', instanceId: instance.id, name, payload }),
      });
      this.#pushState(this.#states.get(instance.id), mounted);
    } catch (error) {
      // Ein Modul, das nicht laedt, darf die anderen nicht mitreissen.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[shell] Modul "${instance.moduleId}" nicht geladen:`, message);
      host.classList.add('module--failed');
      host.textContent = `${instance.moduleId} nicht verfuegbar`;
    }
  }

  #unmount(id: string, mounted: MountedInstance): void {
    try {
      mounted.view?.destroy?.();
    } catch (error) {
      console.warn(`[shell] destroy von "${id}" hat geworfen`, error);
    }
    mounted.host.remove();
    this.#mounted.delete(id);
  }

  #pushState(envelope: ModuleStateEnvelope | undefined, target?: MountedInstance): void {
    if (!envelope) return;
    const mounted = target ?? this.#mounted.get(envelope.instanceId);
    if (!mounted?.view) return;
    try {
      mounted.view.update(envelope.patch, mounted.config);
      mounted.view.setError?.(envelope.error ?? null);
    } catch (error) {
      console.error(`[shell] update von "${envelope.instanceId}" hat geworfen`, error);
    }
  }

  /**
   * Fuellt fehlende Einstellungen aus dem Schema des Moduls auf. Ohne das
   * bekaeme ein frisch hinzugefuegtes Modul eine leere Konfiguration und
   * wuerde sich anders verhalten als eines, das einmal konfiguriert wurde.
   */
  #effectiveConfig(instance: ModuleInstance, descriptor: ModuleDescriptor | undefined): Record<string, unknown> {
    if (!descriptor?.configSchema) return instance.config;
    return validate(descriptor.configSchema, instance.config).value as Record<string, unknown>;
  }

  #applyPower(): void {
    const brightness = this.#config?.display.brightness ?? 100;
    // Aus = vollstaendig schwarz. Gedimmt = teilweise abgedeckt. Das ist die
    // Rueckfallebene fuer alles, was per wlr-randr/ddcutil nicht erreichbar ist.
    const opacity = this.#powerOn ? Math.min(0.92, 1 - brightness / 100) : 1;
    this.#dim.style.opacity = String(opacity);
    this.#grid.setAttribute('aria-hidden', this.#powerOn ? 'false' : 'true');
  }

  #showOverlay(title: string, code: string | null, hint: string): void {
    this.#overlay.replaceChildren();
    const titleElement = document.createElement('div');
    titleElement.className = 'overlay__title';
    titleElement.textContent = title;
    this.#overlay.append(titleElement);

    if (code) {
      const codeElement = document.createElement('div');
      codeElement.className = 'overlay__code';
      codeElement.textContent = code;
      this.#overlay.append(codeElement);
    }

    const hintElement = document.createElement('div');
    hintElement.className = 'overlay__hint';
    hintElement.textContent = hint;
    this.#overlay.append(hintElement);
    this.#overlay.classList.add('overlay--visible');
  }

  #hideOverlay(): void {
    this.#overlay.classList.remove('overlay--visible');
  }

  #startBurnInProtection(): void {
    window.setInterval(() => {
      if (this.#config?.display.burnInProtection === false) return;
      this.#burnInIndex = (this.#burnInIndex + 1) % BURN_IN_PATH.length;
      const [x, y] = BURN_IN_PATH[this.#burnInIndex] as [number, number];
      document.documentElement.style.setProperty('--mirror-shift-x', `${x}px`);
      document.documentElement.style.setProperty('--mirror-shift-y', `${y}px`);
    }, BURN_IN_INTERVAL_MS);
  }
}
