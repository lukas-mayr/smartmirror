import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertValidManifest,
  defaultsOf,
  hostAllowed,
  toMillis,
  validate,
  type BackendContext,
  type Disposer,
  type MirrorConfig,
  type ModuleBackend,
  type ModuleDescriptor,
  type ModuleInstance,
  type ModuleManifest,
  type ModuleStateEnvelope,
} from '@mirror/sdk';
import { createLogger } from './logger.js';
import { modulesDir } from './paths.js';
import type { SecretStore } from './secrets.js';

const log = createLogger('modules');

interface LoadedModule {
  manifest: ModuleManifest;
  directory: string;
  /** Absoluter Pfad zum gebauten Frontend – wird ueber HTTP ausgeliefert. */
  frontendFile: string | null;
  backendFile: string | null;
  loadError?: string;
}

interface RunningInstance {
  instance: ModuleInstance;
  module: LoadedModule;
  backend: ModuleBackend;
  ctx: BackendContext;
  abort: AbortController;
  timers: Set<NodeJS.Timeout>;
  commands: Map<string, (payload: unknown) => void | Promise<void>>;
  state: Record<string, unknown>;
  error: string | null;
  updatedAt?: string;
}

/**
 * Laedt Module von der Platte und haelt die laufenden Instanzen.
 *
 * Leitprinzip: ein kaputtes Modul darf den Spiegel nie anhalten. Jeder
 * Ladefehler, jeder Fehler in setup() und jeder Fehler in einer periodischen
 * Aufgabe wird gefangen, protokolliert und als Fehlerzustand der Instanz
 * angezeigt – die anderen Module laufen weiter.
 */
export class ModuleHost extends EventEmitter {
  #modules = new Map<string, LoadedModule>();
  #instances = new Map<string, RunningInstance>();
  #config: MirrorConfig;
  #secrets: SecretStore;

  constructor(config: MirrorConfig, secrets: SecretStore) {
    super();
    this.#config = config;
    this.#secrets = secrets;
  }

  /** Scannt das Modulverzeichnis. Idempotent – kann jederzeit erneut laufen. */
  async discover(): Promise<void> {
    this.#modules.clear();
    let entries: string[] = [];
    try {
      entries = (await readdir(modulesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      log.error(`Modulverzeichnis ${modulesDir} nicht lesbar`, error);
      return;
    }

    for (const name of entries) {
      const directory = join(modulesDir, name);
      const manifestFile = join(directory, 'module.json');
      if (!existsSync(manifestFile)) continue;
      try {
        const manifest: unknown = JSON.parse(await readFile(manifestFile, 'utf8'));
        assertValidManifest(manifest, manifestFile);
        if (manifest.id !== name) {
          throw new Error(`id "${manifest.id}" passt nicht zum Ordnernamen "${name}"`);
        }
        const backendFile = firstExisting(directory, ['dist/backend.js']);
        const frontendFile = firstExisting(directory, ['dist/frontend.js']);
        this.#modules.set(manifest.id, { manifest, directory, backendFile, frontendFile });
        log.info(`Modul "${manifest.id}" v${manifest.version} geladen.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Modul "${name}" uebersprungen: ${message}`);
        this.#modules.set(name, {
          manifest: { id: name, name, version: '0.0.0' },
          directory,
          backendFile: null,
          frontendFile: null,
          loadError: message,
        });
      }
    }
  }

  descriptors(): ModuleDescriptor[] {
    return [...this.#modules.values()].map((module) => ({
      id: module.manifest.id,
      name: module.manifest.name,
      version: module.manifest.version,
      description: module.manifest.description,
      singleton: module.manifest.singleton === true,
      preferredSize: module.manifest.preferredSize,
      configSchema: module.manifest.configSchema,
      secrets: module.manifest.secrets ?? [],
      secretsPresent: this.#secrets.listFor(module.manifest.id),
      loadError: module.loadError,
    }));
  }

  frontendFileFor(moduleId: string): string | null {
    return this.#modules.get(moduleId)?.frontendFile ?? null;
  }

  /** Momentaufnahme aller Instanz-States fuer neu verbundene Clients. */
  snapshot(): Record<string, ModuleStateEnvelope> {
    const out: Record<string, ModuleStateEnvelope> = {};
    for (const [id, running] of this.#instances) {
      out[id] = {
        instanceId: id,
        patch: running.state,
        error: running.error,
        updatedAt: running.updatedAt,
      };
    }
    return out;
  }

  /**
   * Bringt die laufenden Instanzen mit der Konfiguration in Deckung:
   * neue starten, entfernte stoppen, geaenderte neu konfigurieren.
   */
  async sync(config: MirrorConfig): Promise<void> {
    this.#config = config;
    const desired = new Map(config.instances.filter((entry) => entry.enabled).map((entry) => [entry.id, entry]));

    for (const [id, running] of [...this.#instances]) {
      const next = desired.get(id);
      if (!next) {
        await this.#stop(id);
        continue;
      }
      const configChanged = JSON.stringify(running.instance.config) !== JSON.stringify(next.config);
      running.instance = next;
      if (configChanged) {
        // Neustart ist der ehrliche Weg: ein Modul, das onConfigChange nicht
        // implementiert, wuerde sonst mit veralteter Konfiguration weiterlaufen.
        await this.#stop(id);
        await this.#start(next);
      }
    }

    for (const [id, instance] of desired) {
      if (!this.#instances.has(id)) await this.#start(instance);
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.#instances.keys()]) await this.#stop(id);
  }

  async dispatchCommand(instanceId: string, name: string, payload: unknown): Promise<void> {
    const running = this.#instances.get(instanceId);
    if (!running) throw new Error(`Instanz "${instanceId}" laeuft nicht`);
    const handler = running.commands.get(name);
    if (!handler) throw new Error(`Instanz "${instanceId}" kennt kein Kommando "${name}"`);
    await handler(payload);
  }

  /* --------------------------------- intern --------------------------------- */

  async #start(instance: ModuleInstance): Promise<void> {
    const module = this.#modules.get(instance.moduleId);
    if (!module) {
      log.warn(`Instanz "${instance.id}" verweist auf unbekanntes Modul "${instance.moduleId}".`);
      return;
    }
    if (module.loadError || !module.backendFile) {
      // Module ohne Backend sind erlaubt (reine Anzeige, z.B. die Uhr laeuft
      // vollstaendig im Frontend). Nur echte Ladefehler melden wir.
      if (module.loadError) {
        this.#emitState(instance.id, {}, module.loadError);
      }
      if (!module.backendFile) {
        this.#instances.set(instance.id, this.#makeShell(instance, module));
        this.#emitState(instance.id, {}, null);
      }
      return;
    }

    const abort = new AbortController();
    const running = this.#makeShell(instance, module, abort);

    try {
      const imported = (await import(pathToFileURL(module.backendFile).href)) as {
        default?: ModuleBackend;
      };
      const backend = imported.default;
      if (!backend || typeof backend.setup !== 'function') {
        throw new Error('backend.js exportiert kein Default mit setup()');
      }
      running.backend = backend;
      running.ctx = this.#createContext(running);
      this.#instances.set(instance.id, running);
      await backend.setup(running.ctx);
      log.info(`Instanz "${instance.id}" (${module.manifest.id}) gestartet.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Instanz "${instance.id}" konnte nicht starten: ${message}`);
      this.#instances.set(instance.id, running);
      running.error = message;
      this.#emitState(instance.id, {}, message);
    }
  }

  async #stop(instanceId: string): Promise<void> {
    const running = this.#instances.get(instanceId);
    if (!running) return;
    this.#instances.delete(instanceId);
    running.abort.abort();
    for (const timer of running.timers) clearTimeout(timer);
    running.timers.clear();
    running.commands.clear();
    try {
      await running.backend?.teardown?.(running.ctx);
    } catch (error) {
      log.warn(`teardown von "${instanceId}" hat geworfen`, error);
    }
    log.info(`Instanz "${instanceId}" gestoppt.`);
  }

  #makeShell(instance: ModuleInstance, module: LoadedModule, abort = new AbortController()): RunningInstance {
    return {
      instance,
      module,
      backend: { setup: () => {} },
      ctx: undefined as unknown as BackendContext,
      abort,
      timers: new Set(),
      commands: new Map(),
      state: {},
      error: null,
    };
  }

  #createContext(running: RunningInstance): BackendContext {
    const { instance, module } = running;
    const manifest = module.manifest;
    const permissions = new Set(manifest.permissions ?? []);
    const moduleLog = createLogger(`${manifest.id}:${instance.id}`);

    // Konfiguration einmal beim Start validieren und mit Defaults fuellen.
    // Damit muss kein Modul im Code auf fehlende Felder pruefen.
    const config = manifest.configSchema
      ? (() => {
          const result = validate(manifest.configSchema, instance.config);
          for (const issue of result.issues) {
            moduleLog.warn(`Konfiguration: ${issue.path} – ${issue.message}`);
          }
          return result.value as Record<string, unknown>;
        })()
      : { ...defaultsOf({ type: 'object' }), ...instance.config };

    const track = (timer: NodeJS.Timeout): Disposer => {
      running.timers.add(timer);
      return () => {
        clearTimeout(timer);
        clearInterval(timer);
        running.timers.delete(timer);
      };
    };

    const guard = async (task: () => void | Promise<void>, label: string): Promise<void> => {
      try {
        await task();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        moduleLog.error(`${label} fehlgeschlagen: ${message}`);
        running.error = message;
        this.#emitState(instance.id, {}, message);
      }
    };

    const ctx: BackendContext = {
      instanceId: instance.id,
      moduleId: manifest.id,
      config,
      locale: this.#config.locale,
      timezone: this.#config.timezone,
      log: moduleLog,
      signal: running.abort.signal,

      setState: (patch) => {
        Object.assign(running.state, patch);
        running.updatedAt = new Date().toISOString();
        running.error = null;
        this.#emitState(instance.id, patch as Record<string, unknown>, null, running.updatedAt);
      },
      getState: () => running.state,
      setError: (error) => {
        running.error = error;
        this.#emitState(instance.id, {}, error);
      },

      every: (interval, task) => {
        const ms = toMillis(interval);
        void guard(task, 'Periodische Aufgabe');
        const timer = setInterval(() => void guard(task, 'Periodische Aufgabe'), ms);
        return track(timer);
      },
      after: (delay, task) => {
        const timer = setTimeout(() => void guard(task, 'Verzoegerte Aufgabe'), toMillis(delay));
        return track(timer);
      },

      fetch: async (input, init) => {
        if (!permissions.has('network')) {
          throw new Error(`Modul "${manifest.id}" hat keine Permission "network"`);
        }
        const url = new URL(input);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
          throw new Error(`Nur HTTPS erlaubt (angefragt: ${url.protocol}//${url.host})`);
        }
        if (!hostAllowed(manifest, url.hostname)) {
          throw new Error(
            `Host "${url.hostname}" steht nicht in network.allow von "${manifest.id}"`,
          );
        }
        return fetch(url, { ...init, signal: init?.signal ?? running.abort.signal });
      },

      secret: (key) => {
        if (!permissions.has('secrets')) {
          throw new Error(`Modul "${manifest.id}" hat keine Permission "secrets"`);
        }
        return this.#secrets.get(manifest.id, key);
      },

      onCommand: (name, handler) => {
        if (!permissions.has('commands')) {
          throw new Error(`Modul "${manifest.id}" hat keine Permission "commands"`);
        }
        running.commands.set(name, handler);
        return () => running.commands.delete(name);
      },
    };

    return ctx;
  }

  #emitState(instanceId: string, patch: Record<string, unknown>, error: string | null, updatedAt?: string): void {
    const envelope: ModuleStateEnvelope = { instanceId, patch, error, updatedAt };
    this.emit('state', envelope);
  }
}

function firstExisting(directory: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const file = join(directory, candidate);
    if (existsSync(file)) return file;
  }
  return null;
}
