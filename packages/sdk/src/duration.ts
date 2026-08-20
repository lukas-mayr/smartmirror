/**
 * Kurzschreibweise fuer Zeitspannen: "30s", "10m", "2h", "1d".
 * Reine Zahlen werden als Millisekunden interpretiert.
 */
export type Duration = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}` | number;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Wandelt eine Duration in Millisekunden um. Wirft bei ungueltiger Eingabe. */
export function toMillis(value: Duration): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Ungueltige Dauer: ${value}`);
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new SyntaxError(`Ungueltige Dauer: "${value}" (erwartet z.B. "30s", "10m", "2h")`);
  }
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2] as string];
  if (unit === undefined) {
    throw new SyntaxError(`Unbekannte Zeiteinheit in "${value}"`);
  }
  return amount * unit;
}
