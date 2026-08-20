/**
 * Frontend-Vertrag eines Moduls.
 *
 * Bewusst framework-frei: `create` bekommt ein Host-Element und gibt einen
 * View zurueck. Ob darin Lit, reines DOM oder etwas anderes rendert, ist Sache
 * des Moduls. Die Shell reicht nur State-Aenderungen durch.
 */
export interface FrontendContext<TConfig = Record<string, unknown>> {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly config: Readonly<TConfig>;
  readonly locale: string;
  readonly timezone: string;
  /** Kommando an das Backend schicken (braucht Permission "commands"). */
  sendCommand(name: string, payload?: unknown): void;
}

export interface ModuleView<TState = Record<string, unknown>, TConfig = Record<string, unknown>> {
  /** Bei jeder State- oder Config-Aenderung. Muss idempotent sein. */
  update(state: Readonly<Partial<TState>>, config: Readonly<TConfig>): void;
  /**
   * Fehlerzustand des Backends. Die Shell blendet Module bei Fehlern nicht aus –
   * ein leerer Spiegel ist schlechter als ein veralteter Wert mit Hinweis.
   */
  setError?(error: string | null): void;
  destroy?(): void;
}

export interface ModuleFrontend<TState = Record<string, unknown>, TConfig = Record<string, unknown>> {
  create(host: HTMLElement, ctx: FrontendContext<TConfig>): ModuleView<TState, TConfig>;
}

/** Nur zur Typisierung – gibt die Definition unveraendert zurueck. */
export function defineFrontend<TState = Record<string, unknown>, TConfig = Record<string, unknown>>(
  definition: ModuleFrontend<TState, TConfig>,
): ModuleFrontend<TState, TConfig> {
  return definition;
}
