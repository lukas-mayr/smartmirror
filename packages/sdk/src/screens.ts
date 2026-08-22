/**
 * Screens: mehrere Anordnungen, die der Spiegel nacheinander zeigt.
 *
 * Eine Flaeche reicht selten. Morgens zaehlen Uhr, Wetter und der naechste
 * Termin, abends eher der Kalender der Woche – und alles gleichzeitig waere
 * eine Wand aus Zahlen. Ein Screen ist deshalb eine vollstaendige Anordnung,
 * und der Spiegel schaltet sie im Kreis weiter.
 *
 * Die Standzeit steht am Screen und nicht global: der eine Screen ist ein
 * Blick, der andere will gelesen werden.
 */

/**
 * Wie die Bloecke eines Screens angeordnet werden.
 *
 * `grid` ist das freie Raster: jeder Block liegt auf einem Rasterplatz, den
 * man am Handy verschiebt. Es kann alles und laesst deshalb auch zu, dass
 * jemand zehn Zeilen fuellt.
 *
 * `zones` ist die Szene aus dem Design-System: drei Baender, Uhr fix links
 * oben, hoechstens drei Elemente. Die Obergrenze ist hier keine Regel, an die
 * man sich halten muss, sondern die Form selbst – wo kein vierter Platz ist,
 * landet auch kein vierter Block.
 *
 * Zwei Modi und nicht eine Ablœsung: ein Spiegel, der seit einem Jahr an der
 * Wand haengt, soll durch ein Update nicht neu angeordnet werden.
 */
export const SCREEN_LAYOUTS = ['grid', 'zones'] as const;

export type ScreenLayout = (typeof SCREEN_LAYOUTS)[number];

export const DEFAULT_SCREEN_LAYOUT: ScreenLayout = 'grid';

export interface ScreenLayoutOption {
  id: ScreenLayout;
  name: string;
  note: string;
}

export const SCREEN_LAYOUT_OPTIONS: readonly ScreenLayoutOption[] = [
  { id: 'grid', name: 'Raster', note: 'Bloecke frei auf dem Raster anordnen.' },
  { id: 'zones', name: 'Szene', note: 'Drei Baender: Kopf, Hauptzone, Fussband. Hoechstens drei Bloecke.' },
];

export function isScreenLayout(value: unknown): value is ScreenLayout {
  return typeof value === 'string' && (SCREEN_LAYOUTS as readonly string[]).includes(value);
}

export function normalizeScreenLayout(
  value: unknown,
  fallback: ScreenLayout = DEFAULT_SCREEN_LAYOUT,
): ScreenLayout {
  return isScreenLayout(value) ? value : fallback;
}

export interface MirrorScreen {
  /** Stabil ueber die Lebensdauer, z.B. "screen-2". */
  id: string;
  name: string;
  /** Standzeit, bevor der naechste Screen an die Reihe kommt. */
  durationSeconds: number;
  /** Freies Raster oder die drei Baender der Szene. */
  layout: ScreenLayout;
}

/** Unter fuenf Sekunden ist es kein Screen mehr, sondern ein Flackern. */
export const SCREEN_DURATION_MIN = 5;
/** Zehn Minuten. Wer laenger stehen lassen will, braucht keinen zweiten Screen. */
export const SCREEN_DURATION_MAX = 600;
export const SCREEN_DURATION_STEP = 5;
export const DEFAULT_SCREEN_DURATION = 20;

export function clampScreenDuration(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_SCREEN_DURATION;
  const stepped = Math.round(num / SCREEN_DURATION_STEP) * SCREEN_DURATION_STEP;
  return Math.min(SCREEN_DURATION_MAX, Math.max(SCREEN_DURATION_MIN, stepped));
}

export function createScreen(
  id: string,
  name: string,
  layout: ScreenLayout = DEFAULT_SCREEN_LAYOUT,
): MirrorScreen {
  return { id, name, durationSeconds: DEFAULT_SCREEN_DURATION, layout };
}

/** Naechste freie Id. Die Nummer im Namen ist nur der Vorschlag beim Anlegen. */
export function nextScreenId(existing: readonly string[]): string {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `screen-${index}`;
    if (!existing.includes(candidate)) return candidate;
  }
  throw new Error('Keine freie Screen-Id gefunden');
}

export function defaultScreenName(existing: readonly MirrorScreen[]): string {
  return `Screen ${existing.length + 1}`;
}

export function normalizeScreen(value: unknown, fallbackId: string, fallbackName: string): MirrorScreen {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<MirrorScreen>;
  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : fallbackId;
  const name = typeof source.name === 'string' && source.name.trim().length > 0 ? source.name.trim() : fallbackName;
  return {
    id,
    name,
    durationSeconds: clampScreenDuration(source.durationSeconds),
    layout: normalizeScreenLayout(source.layout),
  };
}

/**
 * Bringt eine Liste auf mindestens einen Screen mit eindeutigen Ids.
 *
 * Kein Screen bedeutet keine Flaeche und damit ein schwarzer Spiegel ohne
 * jeden Hinweis, woran es liegt – der Fall darf gar nicht erst entstehen.
 */
export function normalizeScreens(value: unknown): MirrorScreen[] {
  const input = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const screens: MirrorScreen[] = [];

  for (const entry of input) {
    const screen = normalizeScreen(entry, nextScreenId([...seen]), `Screen ${screens.length + 1}`);
    if (seen.has(screen.id)) continue;
    seen.add(screen.id);
    screens.push(screen);
  }

  if (screens.length === 0) screens.push(createScreen('screen-1', 'Screen 1'));
  return screens;
}

/** Standzeit als "20 s" bzw. "1:30 min" fuer die Handy-App. */
export function formatScreenDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes}:${String(rest).padStart(2, '0')} min`;
}
