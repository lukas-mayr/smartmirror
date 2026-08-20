/* Automatisch erzeugt von scripts/collect-fonts.mjs – nicht von Hand aendern. */

/** Kennung einer mitgelieferten Schriftfamilie. */
export type FontId = 'rubik' | 'nunito' | 'm-plus-rounded-1c' | 'varela-round';

export interface FontOption {
  id: FontId;
  name: string;
  note: string;
}

export const FONT_OPTIONS: readonly FontOption[] = [
  { id: 'rubik', name: 'Rubik', note: "Leicht abgerundete Ecken, Proportionen nahe an Roboto. Ruhigste Wahl." },
  { id: 'nunito', name: 'Nunito', note: "Deutlich abgerundete Endungen, wirkt weicher und freundlicher." },
  { id: 'm-plus-rounded-1c', name: 'M PLUS Rounded 1c', note: "Durchgehend runde Strichenden, am staerksten \"rund\" von allen." },
  { id: 'varela-round', name: 'Varela Round', note: "Sehr rund und kompakt, nur ein Schnitt verfuegbar." },
];

/** Vollstaendige CSS-Fallback-Kette je Familie. */
export const FONT_STACKS: Record<FontId, string> = {
  'rubik': "'Rubik', 'Helvetica Neue', Arial, system-ui, sans-serif",
  'nunito': "'Nunito', 'Helvetica Neue', Arial, system-ui, sans-serif",
  'm-plus-rounded-1c': "'M PLUS Rounded 1c', 'Helvetica Neue', Arial, system-ui, sans-serif",
  'varela-round': "'Varela Round', 'Helvetica Neue', Arial, system-ui, sans-serif",
};

export const DEFAULT_FONT: FontId = 'nunito';
