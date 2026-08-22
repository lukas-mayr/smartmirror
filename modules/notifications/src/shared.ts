import { FEED } from '@mirror/sdk';

/**
 * Der Mitteilungsfeed.
 *
 * Er zeigt eine Mitteilung gross und mit Flaeche und darunter so viele als
 * Ausblick, wie in den Block passen. Damit liest man aus 3 m nur die oberste
 * Zeile und weiss trotzdem, dass mehr wartet — der Rest ist kein Text, den man
 * lesen soll, sondern die Auskunft "da kommt noch was".
 *
 * Wieviele Positionen es sind, entscheidet die Blockhoehe und nicht eine feste
 * Zahl: durchgeschaltet wird ohnehin, und ob dabei drei oder sieben Eintraege
 * gleichzeitig stehen, ist keine Frage der Gestaltung, sondern des Platzes.
 * Eine feste Drei war in einem hohen Block eine halbleere Liste.
 *
 * Ein leerer Feed heisst leere Hauptzone. Kein "Keine Mitteilungen": eine
 * leere Flaeche auf einem Spiegel ist ein Spiegel, ein Satz darueber ist eine
 * Meldung, dass nichts zu melden ist.
 */

export interface NotificationsConfig {
  /**
   * Feste Eintraege aus der Konfiguration, als "Label | Titel | Zusatz" je
   * Zeile.
   *
   * Eine Zeichenkette und kein Objekt-Array, weil die Handy-App ihr Formular
   * aus dem Schema baut und dort ein mehrzeiliges Feld die einzige Form ist,
   * die sich mit dem Daumen fuellen laesst. Wer strukturierte Mitteilungen
   * will, schickt sie als Kommando.
   */
  entries: string;
  /** Wie lange eine Mitteilung steht, bevor die Liste nachrueckt (Sekunden). */
  advanceSeconds: number;
  /** Ueberschrift ueber der Liste zeigen. */
  showHeading: boolean;
  /**
   * Wieviele Positionen der Feed besetzt. 0 heisst: so viele wie passen.
   *
   * Die Voreinstellung ist die Null, weil der Platz die bessere Antwort gibt
   * als eine Zahl, die jemand einmal eingestellt und beim naechsten Umbau der
   * Anordnung vergessen hat. Die Einstellung gibt es trotzdem, weil "nur die
   * naechste Sache, sonst nichts" ein legitimer Wunsch ist und kein Platzmangel.
   */
  visibleCount: number;
}

export interface Notification {
  /** Stabil ueber die Lebensdauer – die Anzeige haengt die Einblendung daran. */
  id: string;
  /** Woher die Mitteilung kommt: "Termin · in 18 min", "Paket", "Bus 142". */
  label: string;
  /** Die Aussage in wenigen Woertern: "Standup", "Regen ab 16 Uhr". */
  title: string;
  /** Zweitzeile mit Zeit, Ort oder Wahrscheinlichkeit. */
  meta: string;
  /**
   * Dringendes rueckt sofort auf Position 1 und bekommt Sand statt Salbei.
   *
   * Bewusst ein Schalter und keine Prioritaetszahl: eine Skala von 1 bis 5
   * beantwortet die Frage nicht, die auf einem Spiegel zaehlt — steht es ganz
   * oben oder nicht. Und wer drei Stufen hat, vergibt irgendwann nur noch die
   * hoechste.
   */
  urgent: boolean;
  /** ISO-Zeitstempel, ab dem die Mitteilung nicht mehr gezeigt wird. */
  expiresAt: string | null;
}

export interface NotificationsState {
  items: Notification[];
}

/**
 * Grenzen der sichtbaren Positionen, aus dem Design-System.
 *
 * Ausdruecklich als `number` und nicht als das Literal, das aus dem `as const`
 * des Design-Systems faellt: wer damit eine Zaehlvariable anlegt, bekaeme sonst
 * eine Variable vom Typ `1`, die nie etwas anderes werden darf.
 */
export const VISIBLE_MIN: number = FEED.visibleMin;
export const VISIBLE_MAX: number = FEED.visibleMax;

/** Voreingestellte Taktung in Sekunden, aus dem Design-System. */
export const ADVANCE_SECONDS = FEED.advance / 1000;

/**
 * Eine Mitteilung aus einer Konfigurationszeile.
 *
 * "Termin · in 18 min | Standup | 09:30 · Kueche" wird zu Label, Titel und
 * Zusatz. Fehlende Teile bleiben leer statt die Zeile zu verwerfen: wer nur
 * "Muell rausstellen" eintippt, meint einen Titel und keine kaputte Zeile.
 *
 * Ein "!" am Zeilenanfang macht die Mitteilung dringend.
 */
export function parseEntry(line: string, index: number): Notification | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const urgent = trimmed.startsWith('!');
  const parts = (urgent ? trimmed.slice(1) : trimmed).split('|').map((part) => part.trim());

  // Ein Teil heisst Titel, zwei heissen Label und Titel, drei heissen alles.
  const [first = '', second = '', third = ''] = parts;
  const notification: Notification = {
    id: `entry-${index}`,
    label: parts.length >= 2 ? first : '',
    title: parts.length >= 2 ? second : first,
    meta: parts.length >= 3 ? third : '',
    urgent,
    expiresAt: null,
  };
  return notification.title.length > 0 ? notification : null;
}

export function parseEntries(entries: string): Notification[] {
  return entries
    .split('\n')
    .map((line, index) => parseEntry(line, index))
    .filter((entry): entry is Notification => entry !== null);
}

/**
 * Was gerade noch gilt, in der Reihenfolge, in der es gezeigt wird.
 *
 * Dringendes zuerst, sonst die Reihenfolge, in der es hereinkam. Abgelaufenes
 * faellt heraus: eine Mitteilung "Bus in 7 min" von vor einer Stunde ist keine
 * veraltete Information, sondern eine falsche.
 */
export function activeNotifications(
  items: readonly Notification[],
  now: Date = new Date(),
): Notification[] {
  const stamp = now.getTime();
  const alive = items.filter((item) => {
    if (!item.expiresAt) return true;
    const expires = Date.parse(item.expiresAt);
    return !Number.isFinite(expires) || expires > stamp;
  });

  // Ein stabiler Sortierlauf: gleich dringende behalten ihre Reihenfolge, und
  // die Liste springt nicht bei jedem Zeichnen um.
  return [...alive].sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/**
 * Wieviele Positionen in eine Liste dieser Hoehe passen.
 *
 * `listHeight` ist der Platz, der der Liste tatsaechlich bleibt (also ohne
 * Ueberschrift), `blockHeight` die Hoehe des ganzen Blocks — an der haengen
 * die `cqh`-Deckel der Positionen im Stylesheet, und deshalb muessen beide
 * Masse herein. Gerechnet wird mit denselben Formeln wie dort: passte hier
 * eine Position mehr als dort, waere die unterste angeschnitten.
 *
 * Angeschnitten wird nichts: was nicht ganz hineinpasst, wird nicht gezeigt.
 * Eine halbe Zeile am unteren Rand liest sich als Fehler, nicht als Ausblick.
 */
export function fitCount(listHeight: number, blockHeight: number): number {
  if (!Number.isFinite(listHeight) || !Number.isFinite(blockHeight)) return VISIBLE_MIN;

  const lead = Math.min(FEED.itemHeight, blockHeight * FEED.itemShare);
  const rest = Math.min(FEED.itemHeightRest, blockHeight * FEED.itemShareRest);
  if (rest <= 0) return VISIBLE_MIN;

  // Jede weitere Position kostet ihre Hoehe plus den Abstand davor.
  const room = listHeight - lead;
  const extra = room <= 0 ? 0 : Math.floor(room / (rest + FEED.gap));
  return Math.max(VISIBLE_MIN, Math.min(VISIBLE_MAX, 1 + extra));
}

/**
 * Wieviele Positionen der Feed besetzen soll.
 *
 * Die Einstellung gewinnt, wenn sie gesetzt ist, aber nur bis zu dem, was
 * hineinpasst: wer acht Positionen einstellt und den Block danach auf die
 * halbe Hoehe zieht, soll eine kuerzere Liste sehen und keine abgeschnittene.
 */
export function slotCount(configured: number, fits: number): number {
  const wanted = Math.round(Number(configured));
  if (!Number.isFinite(wanted) || wanted <= 0) return fits;
  return Math.max(VISIBLE_MIN, Math.min(fits, wanted));
}

/**
 * Deckkraft einer Ausblick-Position.
 *
 * `step` zaehlt ab 1 unterhalb der obersten, `total` ist die Zahl der
 * Ausblick-Positionen. Die erste bekommt dim1, die letzte dim2, dazwischen
 * wird linear verteilt — bei nur einer bleibt es bei dim1, weil sie sonst als
 * "letzte" sofort auf den blassesten Wert fiele.
 *
 * Das rechnet die Anzeige und nicht das Stylesheet: eine Regel je Position
 * ginge nur mit einer festen Zahl von Positionen, und genau die gibt es hier
 * nicht mehr.
 */
export function restOpacity(step: number, total: number): number {
  if (total <= 1) return FEED.dim1;
  const share = Math.min(1, Math.max(0, (step - 1) / (total - 1)));
  const value = FEED.dim1 + (FEED.dim2 - FEED.dim1) * share;
  // Zwei Nachkommastellen: sonst aendert sich die Zahl bei jedem Zeichnen in
  // der siebten Stelle und das Stylesheet wird ohne Grund neu gesetzt.
  return Math.round(value * 100) / 100;
}

/**
 * Die Positionen, so wie sie gerade besetzt sind.
 *
 * Der Rang steckt in der Position und nicht im Eintrag: ein Eintrag weiss
 * nicht, der wievielte er ist — er wird an eine Position gehaengt, und die
 * Position bestimmt Groesse, Flaeche und Deckkraft. Beim Nachruecken aendert
 * sich damit nur, welcher Eintrag an welcher Position haengt, und die Form der
 * Liste bleibt exakt dieselbe.
 *
 * Gibt es weniger Eintraege als Plaetze, bleibt die Liste kuerzer, statt sich
 * zu wiederholen: derselbe Termin zweimal untereinander sieht nach einem
 * Fehler aus. Erst ab einem Eintrag mehr als Plaetzen lohnt das Nachruecken
 * ueberhaupt.
 */
export function visibleWindow(
  items: readonly Notification[],
  offset: number,
  slots: number,
): Notification[] {
  if (items.length === 0 || slots <= 0) return [];
  const count = Math.min(slots, items.length);
  const start = items.length > slots ? ((offset % items.length) + items.length) % items.length : 0;
  return Array.from({ length: count }, (_, step) => items[(start + step) % items.length] as Notification);
}
