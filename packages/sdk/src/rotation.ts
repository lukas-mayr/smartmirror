/**
 * Drehung des Bildschirminhalts.
 *
 * Der Wert ist die Drehung des *Inhalts* im Uhrzeigersinn. Ein Bildschirm, der
 * am Spiegel nach links gekippt haengt, braucht also 90 Grad. Welcher der
 * beiden Hochkant-Werte der richtige ist, sieht man in einer Sekunde – deshalb
 * beschreiben die Bezeichnungen unten das Ergebnis und nicht die Mechanik.
 *
 * Gedreht wird in der Anzeige selbst; die Begruendung steht im Stylesheet der
 * Anzeige (packages/shell/src/renderer/styles.css).
 */
export const ROTATIONS = [0, 90, 180, 270] as const;

export type Rotation = (typeof ROTATIONS)[number];

export const DEFAULT_ROTATION: Rotation = 0;

export interface RotationOption {
  id: Rotation;
  name: string;
  note: string;
}

/** Bezeichnungen fuer die Remote-Oberflaeche. */
export const ROTATION_OPTIONS: readonly RotationOption[] = [
  { id: 0, name: 'Quer', note: 'Bildschirm haengt wie gebaut.' },
  { id: 90, name: 'Hochkant (90°)', note: 'Bildschirm nach links gekippt aufgehaengt.' },
  { id: 180, name: 'Quer, auf dem Kopf (180°)', note: 'Bildschirm um 180 Grad gedreht aufgehaengt.' },
  { id: 270, name: 'Hochkant (270°)', note: 'Bildschirm nach rechts gekippt aufgehaengt.' },
];

export function isRotation(value: unknown): value is Rotation {
  return (ROTATIONS as readonly unknown[]).includes(value);
}

/**
 * Bringt einen beliebigen Wert auf eine der vier erlaubten Drehungen.
 *
 * Nimmt auch Zahlen als Zeichenkette an: die Werte kommen aus JSON-Dateien,
 * aus `<select>`-Elementen der Handy-App und aus einer Kommandozeilenoption des
 * Installers – eine "90" ist an all diesen Stellen dasselbe gemeint.
 */
export function normalizeRotation(value: unknown): Rotation {
  if (value === null || value === undefined || value === '') return DEFAULT_ROTATION;
  const degrees = Number(value);
  return isRotation(degrees) ? degrees : DEFAULT_ROTATION;
}
