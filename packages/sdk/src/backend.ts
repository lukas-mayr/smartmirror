import type { Duration } from './duration.js';
import type { FeedNotification, NotificationInput } from './notify.js';
import type { ModuleAction } from './protocol.js';

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
   * Bittet den Nutzer um einen Schritt, den nur er tun kann – etwa eine
   * Anmeldung bei einem fremden Dienst. Die Handy-App zeigt die Bitte im
   * Einstellungsblatt des Blocks, die Anzeige zeigt sie nie: vor dem Spiegel
   * steht niemand, der darauf tippen koennte. `null` nimmt sie zurueck.
   */
  setAction(action: ModuleAction | null): void;

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
  /**
   * Geheimnis schreiben, `null` loescht es. Nur mit Permission "secrets".
   *
   * Gibt es, weil ein Modul nicht jedes Geheimnis vom Nutzer bekommt: wer sich
   * per OAuth anmeldet, tauscht einen einmaligen Code gegen einen Token, den
   * nur das Modul kennt und der einen Neustart ueberleben muss. Ihn in die
   * Konfiguration zu schreiben, waere falsch – die geht an alle Clients.
   *
   * Schreibt ein Modul sein eigenes Geheimnis, wird es dadurch nicht neu
   * gestartet. Nur was vom Handy kommt, startet die Instanz neu.
   */
  setSecret(key: string, value: string | null): Promise<void>;
  /** Nur mit Permission "commands". */
  onCommand(name: string, handler: (payload: unknown) => void | Promise<void>): Disposer;

  /**
   * Meldet, was diese Instanz gerade mitzuteilen hat. Nur mit Permission "notify".
   *
   * Immer der vollstaendige Stand und nie ein Zuwachs: was in der neuen
   * Meldung fehlt, ist zurueckgezogen. Ein leeres Array meldet "nichts mehr",
   * und genau das ist der Normalfall — die meisten Module haben die meiste
   * Zeit nichts zu melden.
   *
   * Ein Modul muss dafuer nichts zusaetzlich abrufen: es meldet, was es fuer
   * seinen eigenen Block ohnehin schon geholt hat.
   */
  notify(items: readonly NotificationInput[]): void;

  /**
   * Hoert den gesammelten Feed aller meldenden Instanzen. Nur mit Permission
   * "notifications".
   *
   * Der Handler laeuft sofort mit dem aktuellen Stand und danach bei jeder
   * Aenderung. Sortiert ist der Strom schon – Dringendes zuerst, dann das,
   * was als naechstes ansteht.
   */
  onNotifications(handler: (items: readonly FeedNotification[]) => void): Disposer;
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
