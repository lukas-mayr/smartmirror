/**
 * Layout-Zonen des Spiegels. Ein 3x3-Raster deckt die ueblichen
 * Smartmirror-Anordnungen ab; freie Pixel-Positionierung ist eine
 * spaetere Ausbaustufe und wuerde als weiterer Positionstyp ergaenzt.
 */
export const ZONES = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type Zone = (typeof ZONES)[number];

export function isZone(value: unknown): value is Zone {
  return typeof value === 'string' && (ZONES as readonly string[]).includes(value);
}

/** Menschenlesbare Bezeichnungen fuer die Remote-Oberflaeche. */
export const ZONE_LABELS: Record<Zone, string> = {
  'top-left': 'Oben links',
  'top-center': 'Oben Mitte',
  'top-right': 'Oben rechts',
  'middle-left': 'Mitte links',
  'middle-center': 'Mitte',
  'middle-right': 'Mitte rechts',
  'bottom-left': 'Unten links',
  'bottom-center': 'Unten Mitte',
  'bottom-right': 'Unten rechts',
};
