import type { Duration } from './duration.js';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Rueckgabe der Registrierungs-Methoden: aufrufen hebt die Registrierung auf. */
export type Disposer = () => void;

export interface BackendContext<TConfig = Record<string, unknown>, TState = Record<string, unknown>> {
  readonly instanceId: string;
  readonly moduleId: string;
  /** Bereits gegen das `configSchema` validiert und mit Defaults gefuellt. */
  readonly config: Readonly<TConfig>;
  readonly locale: string;
  readonly timezone: string;
  readonly log: Logger;
  /** Wird abgebrochen, wenn die Instanz gestoppt wird. An `fetch` weitergeben. */
  readonly signal: AbortSignal;

  /** Flacher Merge in den State; wird automatisch an alle Clients verteilt. */
  setState(patch: Partial<TState>): void;
  getState(): Readonly<Partial<TState>>;
  /** Fehlerzustand setzen (z.B. Netzausfall). `null` loescht ihn wieder. */
  setError(error: string | null): void;

  /**
   * Wiederkehrende Aufgabe. Laeuft sofort einmal und danach im Intervall.
   * Wird beim Stoppen der Instanz automatisch abgeraeumt.
   */
  every(interval: Duration, task: () => void | Promise<void>): Disposer;
  /** Einmalige verzoegerte Aufgabe, ebenfalls automatisch abgeraeumt. */
  after(delay: Duration, task: () => void | Promise<void>): Disposer;

  /** Nur mit Permission "network"; nur Hosts aus `network.allow`. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Nur mit Permission "secrets". Erreicht das Frontend nie. */
  secret(key: string): string | undefined;
  /** Nur mit Permission "commands". */
  onCommand(name: string, handler: (payload: unknown) => void | Promise<void>): Disposer;
}

export interface ModuleBackend<TConfig = Record<string, unknown>, TState = Record<string, unknown>> {
  setup(ctx: BackendContext<TConfig, TState>): void | Promise<void>;
  /** Nach einer Konfigurationsaenderung. Ohne Implementierung wird die Instanz neu gestartet. */
  onConfigChange?(ctx: BackendContext<TConfig, TState>): void | Promise<void>;
  teardown?(ctx: BackendContext<TConfig, TState>): void | Promise<void>;
}

/** Nur zur Typisierung – gibt die Definition unveraendert zurueck. */
export function defineBackend<TConfig = Record<string, unknown>, TState = Record<string, unknown>>(
  definition: ModuleBackend<TConfig, TState>,
): ModuleBackend<TConfig, TState> {
  return definition;
}
