/**
 * Einrichtung in Schritten.
 *
 * Der Spiegel hat kein Eingabegeraet: alles, was eingestellt werden muss,
 * passiert am Handy – und alles, was man dabei sehen muss, passiert am
 * Spiegel. Die beiden Geraete muessen also durch dieselbe Reihenfolge gefuehrt
 * werden, und beide brauchen dafuer denselben Zustand. Er steht deshalb in der
 * Konfiguration und nicht in einer der beiden Oberflaechen:
 *
 *  1. `pair`  – der Spiegel zeigt den Kopplungscode, das Handy fragt ihn ab.
 *  2. `frame` – der Spiegel zeigt den Rahmen der bespielbaren Flaeche, das
 *               Handy stellt ihn Kante fuer Kante ein.
 *  3. `done`  – Normalbetrieb.
 *
 * Schritt 2 laesst sich spaeter erneut starten, ohne die Kopplung zu
 * verlieren: der Bildschirm rutscht beim Putzen, der Rahmen wird getauscht.
 */
export const SETUP_STEPS = ['pair', 'frame', 'done'] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupState {
  step: SetupStep;
  /** ISO-Zeitstempel des ersten vollstaendigen Durchlaufs, sonst null. */
  completedAt: string | null;
}

/** Schritte, die eine Fortschrittsanzeige bekommen – `done` ist keiner. */
export const SETUP_FLOW_STEPS: readonly SetupStep[] = ['pair', 'frame'];

export const SETUP_STEP_TITLES: Record<SetupStep, string> = {
  pair: 'Spiegel koppeln',
  frame: 'Bildschirm ausrichten',
  done: 'Eingerichtet',
};

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value);
}

export function createDefaultSetup(): SetupState {
  return { step: 'pair', completedAt: null };
}

export function normalizeSetup(value: unknown): SetupState {
  if (typeof value !== 'object' || value === null) return createDefaultSetup();
  const source = value as Partial<SetupState>;
  return {
    step: isSetupStep(source.step) ? source.step : 'pair',
    completedAt: typeof source.completedAt === 'string' ? source.completedAt : null,
  };
}

/**
 * Setzt den Schritt und fuehrt den Zeitstempel mit.
 *
 * `completedAt` wird genau einmal gesetzt und danach nie wieder angefasst: es
 * beantwortet die Frage "war dieser Spiegel schon einmal fertig eingerichtet?"
 * – nicht "wann wurde zuletzt nachjustiert?". Am Start haengt daran, ob eine
 * Konfiguration aus aelteren Versionen in die Einrichtung geschickt wird.
 */
export function withSetupStep(setup: SetupState, step: SetupStep): SetupState {
  return {
    step,
    completedAt: setup.completedAt ?? (step === 'done' ? new Date().toISOString() : null),
  };
}

/** Position im Ablauf, 1-basiert. `done` liegt hinter dem letzten Schritt. */
export function setupStepNumber(step: SetupStep): number {
  const index = SETUP_FLOW_STEPS.indexOf(step);
  return index < 0 ? SETUP_FLOW_STEPS.length + 1 : index + 1;
}
