import { FEED } from '@mirror/sdk';

/**
 * Der Mitteilungsfeed.
 *
 * Er zeigt genau drei Eintraege: der oberste traegt die Flaeche und die volle
 * Groesse, die beiden darunter stehen frei und gedimmt als Ausblick. Damit
 * liest man aus 3 m nur die oberste Zeile und weiss trotzdem, dass mehr
 * wartet — der Rest ist kein Text, den man lesen soll, sondern die Auskunft
 * "da kommt noch was".
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
 * Wieviele Mitteilungen gleichzeitig sichtbar sind.
 *
 * Aus dem Design-System und nicht als zweite Drei hier: die Zahl steht auch im
 * Stylesheet, das den drei Positionen ihre Groessen gibt, und zwei Dreien an
 * zwei Orten sind eine Dreiviertel-Aenderung, wenn jemand vier haben will.
 */
export const VISIBLE = FEED.visible;

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
 * Die drei Positionen, so wie sie gerade besetzt sind.
 *
 * Der Rang steckt in der Position und nicht im Eintrag: ein Eintrag weiss
 * nicht, der wievielte er ist — er wird an eine Position gehaengt, und die
 * Position bestimmt Groesse, Flaeche und Deckkraft. Beim Nachruecken aendert
 * sich damit nur, welcher Eintrag an welcher Position haengt, und die Form der
 * Liste bleibt exakt dieselbe.
 *
 * Sind es weniger als drei, bleibt die Liste kuerzer, statt sich zu
 * wiederholen: derselbe Termin dreimal untereinander sieht nach einem Fehler
 * aus. Erst ab vier lohnt das Nachruecken ueberhaupt.
 */
export function visibleWindow(
  items: readonly Notification[],
  offset: number,
): Notification[] {
  if (items.length === 0) return [];
  const count = Math.min(VISIBLE, items.length);
  const start = items.length > VISIBLE ? ((offset % items.length) + items.length) % items.length : 0;
  return Array.from({ length: count }, (_, step) => items[(start + step) % items.length] as Notification);
}
