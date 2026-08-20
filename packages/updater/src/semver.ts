/**
 * Kleiner Semver-Vergleich. Bewusst keine Abhaengigkeit: der Updater soll so
 * wenig wie moeglich mitbringen, damit er auch dann noch laeuft, wenn ein
 * Update das Release-Verzeichnis in einen halben Zustand gebracht hat.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parse(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** -1 wenn a < b, 0 bei Gleichstand, 1 wenn a > b. Unlesbare Versionen sind kleiner. */
export function compare(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }

  // Eine Vorabversion ist aelter als die fertige Version mit gleicher Nummer.
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (!left.prerelease && !right.prerelease) return 0;
  return (left.prerelease as string).localeCompare(right.prerelease as string);
}

export function isNewer(candidate: string, current: string): boolean {
  return compare(candidate, current) > 0;
}
