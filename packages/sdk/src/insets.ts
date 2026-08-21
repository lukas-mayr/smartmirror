/**
 * Rand der bespielbaren Flaeche, je Seite einzeln.
 *
 * Hinter einem Zwei-Wege-Spiegel sitzt der Bildschirm fast nie mittig im
 * Rahmen: ein paar Millimeter Versatz beim Aufhaengen genuegen, und der
 * Rahmen verdeckt links mehr Pixel als rechts. Ein einziger Randabstand fuer
 * alle vier Seiten kann das nicht ausgleichen – er macht den Inhalt nur
 * kleiner, aber nicht mittig.
 *
 * Deshalb vier Werte statt einem. Sie beschreiben, wie weit die bespielbare
 * Flaeche von der jeweiligen Bildschirmkante wegbleibt, in Prozent der
 * zugehoerigen Kantenlaenge: oben/unten von der Hoehe, links/rechts von der
 * Breite. Prozent und nicht Pixel, damit dieselbe Einstellung auch nach einem
 * Bildschirmtausch mit anderer Aufloesung noch passt.
 */
export const INSET_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export type InsetSide = (typeof INSET_SIDES)[number];

export type ScreenInsets = Record<InsetSide, number>;

/** Voreinstellung: schmaler Rand ringsum, der uebliche Rahmen verdeckt etwa so viel. */
export const DEFAULT_INSET_PERCENT = 4;

export const INSET_MIN = 0;
/**
 * Mehr als ein Viertel je Seite waere kein Ausgleich mehr, sondern ein
 * Briefkasten – und mit 25 links und 25 rechts bliebe nichts uebrig.
 */
export const INSET_MAX = 25;
/** Schrittweite von "+"/"−". Auf 1920 Pixeln sind das rund zehn Pixel. */
export const INSET_STEP = 0.5;

export interface InsetSideOption {
  id: InsetSide;
  /** Bezeichnung fuer die Handy-App. */
  name: string;
}

export const INSET_SIDE_OPTIONS: readonly InsetSideOption[] = [
  { id: 'top', name: 'Oben' },
  { id: 'right', name: 'Rechts' },
  { id: 'bottom', name: 'Unten' },
  { id: 'left', name: 'Links' },
];

export function createDefaultInsets(value: number = DEFAULT_INSET_PERCENT): ScreenInsets {
  const inset = clampInset(value);
  return { top: inset, right: inset, bottom: inset, left: inset };
}

/**
 * Begrenzt einen einzelnen Wert und raeumt Nachkommastellen auf.
 *
 * Gerundet wird auf die Schrittweite: sonst sammeln sich aus wiederholtem
 * "+"/"−" ueber Gleitkomma Werte wie 4.499999999999999 an, die in der App als
 * unleserliche Zahl auftauchen und in der Konfigurationsdatei stehen bleiben.
 */
export function clampInset(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_INSET_PERCENT;
  const stepped = Math.round(num / INSET_STEP) * INSET_STEP;
  const bounded = Math.min(INSET_MAX, Math.max(INSET_MIN, stepped));
  // Auf zwei Stellen: INSET_STEP kann kuenftig auch 0.25 sein.
  return Math.round(bounded * 100) / 100;
}

/**
 * Bringt einen beliebigen Wert auf vier gueltige Raender.
 *
 * Nimmt auch eine einzelne Zahl an – so sah die Einstellung frueher aus
 * (`paddingPercent`), und so kommt sie aus von Hand editierten Dateien.
 */
export function normalizeInsets(value: unknown, fallback: number = DEFAULT_INSET_PERCENT): ScreenInsets {
  if (typeof value === 'number' || typeof value === 'string') return createDefaultInsets(Number(value));
  if (typeof value !== 'object' || value === null) return createDefaultInsets(fallback);
  const source = value as Partial<Record<InsetSide, unknown>>;
  const base = clampInset(fallback);
  const result = {} as ScreenInsets;
  for (const side of INSET_SIDES) {
    // Fehlend und unbrauchbar landen beim selben Rueckfallwert: sonst haengt
    // das Ergebnis daran, ob in der Datei nichts oder Unsinn steht.
    const raw = source[side];
    result[side] = Number.isFinite(Number(raw)) && raw !== null && raw !== '' ? clampInset(raw) : base;
  }
  return result;
}

/** Verschiebt eine Kante. Positives `delta` heisst nach innen. */
export function adjustInset(insets: ScreenInsets, side: InsetSide, delta: number): ScreenInsets {
  return { ...insets, [side]: clampInset(insets[side] + delta) };
}

/** Verschiebt alle vier Kanten gleichzeitig. */
export function adjustAllInsets(insets: ScreenInsets, delta: number): ScreenInsets {
  const result = {} as ScreenInsets;
  for (const side of INSET_SIDES) result[side] = clampInset(insets[side] + delta);
  return result;
}

export function insetsEqual(a: ScreenInsets, b: ScreenInsets): boolean {
  return INSET_SIDES.every((side) => a[side] === b[side]);
}

/**
 * Rechnet einen Rand in Pixel um – nur zur Anzeige in der Handy-App.
 *
 * `length` ist die Kantenlaenge der zugehoerigen Achse: fuer oben/unten die
 * Hoehe der Buehne, fuer links/rechts ihre Breite.
 */
export function insetToPixels(percent: number, length: number): number {
  return Math.round((percent / 100) * length);
}
