/**
 * Das Feld, in dem die Zeit vergeht.
 *
 * Der Timer zeigt seine Restzeit als Bild, und es gibt mehr als eines davon:
 * eine Baustelle, auf der ein Berg abgetragen wird (`site.ts`), und eine
 * Seegraswiese, die eine Schildkroete abweidet (`meadow.ts`). Was beide teilen,
 * steht hier — der Ausschnitt und der Boden.
 *
 * Geteilt wird das nicht aus Sparsamkeit, sondern weil es derselbe Block ist:
 * die Ziffern stehen an derselben Stelle, der Block hat dieselbe Hoehe, und
 * ein Motiv, das sich seinen eigenen Ausschnitt naehme, saehe beim Wechsel aus
 * wie ein anderer Block und nicht wie derselbe Timer.
 *
 * Alle Masse in Feldeinheiten des `viewBox`. Der Boden liegt bei `GROUND`,
 * gezaehlt wird wie in SVG von oben.
 */

/**
 * Der Ausschnitt, den das `viewBox` zeigt.
 *
 * `top` schneidet oben ab, was niemand braucht: gerechnet wird von einer Null
 * ganz oben, gezeichnet wird aber erst ab dem Gipfel des groessten Berges. Ohne
 * den Schnitt stuende ueber der Szene ein Streifen Leere, und weil sich das
 * Bild in seinen Platz einpasst, waere die Szene dadurch kleiner statt der
 * Streifen schmaler.
 *
 * Breit und flach: eine Baustelle ist eine Zeile, und eine Wiese ist es auch.
 */
export const FIELD = { top: 10, width: 220, height: 74 } as const;

/**
 * Wo der Boden liegt.
 *
 * Darunter bleibt Platz fuer Raeder und Raupen — und im Meer fuer nichts, denn
 * dort ist der Boden Sand. Dass beide Motive ihn auf derselben Hoehe haben, ist
 * der Grund, warum der Wechsel den Block nicht springen laesst.
 */
export const GROUND = 80;

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Zwei Nachkommastellen. Mehr Stellen sind im Pfad nur laengerer Text. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
