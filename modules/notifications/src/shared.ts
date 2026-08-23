import { clampTextScale, FEED, type FeedNotification } from '@mirror/sdk';
import type { IconName } from '@mirror/icons';

/**
 * Der Mitteilungsfeed.
 *
 * Eine Mitteilung ist eine Zeile: Symbol, Titel, Beschreibung. Die oberste
 * traegt die Flaeche, die darunter stehen frei und nach unten hin blasser —
 * damit liest man aus 3 m nur die oberste Zeile und weiss trotzdem, dass mehr
 * wartet.
 *
 * Die Zeile ist bewusst schmal gesetzt. Ein Mitteilungsblock ist kein Wert,
 * fuer den man hinsieht, sondern eine Liste, die man ueberfliegt: sie steht
 * naeher an den Wochentagen der Wettervorschau als an der Temperatur darueber.
 * Das Symbol traegt, was frueher eine eigene Zeile in Versalien war — woher
 * die Mitteilung kommt, erkennt man daran schneller als an dem Wort "Termin".
 *
 * Dieses Modul ist eine Flaeche und keine Quelle. Es holt nichts: was eine
 * Mitteilung ist, weiss der Kalender, das Wetter oder die Abfahrtstafel, und
 * jedes dieser Module hat den Zustand ohnehin schon. Sie melden ihn mit
 * `ctx.notify(...)`, der Host legt die Meldungen zusammen, und hier kommt der
 * fertige Stand an. Dazu die festen Zeilen aus der Konfiguration und was per
 * Kommando hereingereicht wird — mehr Wege gibt es nicht hinein.
 *
 * Wieviele Positionen es sind, entscheidet die Blockhoehe und nicht eine feste
 * Zahl: durchgeschaltet wird ohnehin, und ob dabei drei oder sieben Eintraege
 * gleichzeitig stehen, ist keine Frage der Gestaltung, sondern des Platzes.
 *
 * Ein leerer Feed heisst leere Hauptzone. Kein "Keine Mitteilungen": eine
 * leere Flaeche auf einem Spiegel ist ein Spiegel, ein Satz darueber ist eine
 * Meldung, dass nichts zu melden ist.
 */

/**
 * Der Eintragstyp kommt aus dem SDK.
 *
 * Er ist die gemeinsame Sprache zwischen Quelle und Anzeige und gehoert
 * deshalb keiner der beiden Seiten. Hier liegt nur, was die Anzeige damit
 * macht — und das Lesen der festen Zeilen aus der Konfiguration.
 */
export type { FeedNotification };

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
  /**
   * Schriftgroesse der Liste als Faktor.
   *
   * Nicht die Zahl der Positionen: die ergibt sich daraus. Wer groesser stellt,
   * sieht weniger Mitteilungen gleichzeitig — und das ist die richtige
   * Reihenfolge, denn eine Mitteilung, die man aus dem Flur lesen kann, ist
   * mehr wert als drei, vor die man treten muss.
   */
  scale: number;
}

export interface NotificationsState {
  items: FeedNotification[];
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

/** Die eingestellte Schriftgroesse, auf die erlaubten Grenzen gebracht. */
export function feedScale(config: Partial<Pick<NotificationsConfig, 'scale'>>): number {
  return clampTextScale(config.scale);
}

/**
 * Eine Mitteilung aus einer Konfigurationszeile.
 *
 * "Termin · in 18 min | Standup | 09:30 · Kueche" wird zu Label, Titel und
 * Zusatz. Fehlende Teile bleiben leer statt die Zeile zu verwerfen: wer nur
 * "Muell rausstellen" eintippt, meint einen Titel und keine kaputte Zeile.
 *
 * Ein "!" am Zeilenanfang macht die Mitteilung dringend.
 */
export function parseEntry(line: string, index: number): FeedNotification | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const urgent = trimmed.startsWith('!');
  const parts = (urgent ? trimmed.slice(1) : trimmed).split('|').map((part) => part.trim());

  // Ein Teil heisst Titel, zwei heissen Label und Titel, drei heissen alles.
  const [first = '', second = '', third = ''] = parts;
  const notification: FeedNotification = {
    id: `entry-${index}`,
    label: parts.length >= 2 ? first : '',
    title: parts.length >= 2 ? second : first,
    meta: parts.length >= 3 ? third : '',
    urgent,
    at: null,
    expiresAt: null,
    // Feste Zeilen sind die Ausnahme von der Regel "der Inhalt kommt aus den
    // Modulen": ein Zettel an die Familie hat keine Datenquelle.
    source: 'notifications',
  };
  return notification.title.length > 0 ? notification : null;
}

export function parseEntries(entries: string): FeedNotification[] {
  return entries
    .split('\n')
    .map((line, index) => parseEntry(line, index))
    .filter((entry): entry is FeedNotification => entry !== null);
}

/**
 * Das Symbol, das eine Mitteilung traegt.
 *
 * Es kommt aus der Quelle und nicht aus der Mitteilung: ein Modul meldet, was
 * es zu sagen hat, und nicht, wie es aussehen soll — sonst haette jede Quelle
 * eine Meinung zur Gestaltung des Feeds, und der Block saehe je nach
 * Absender anders aus. Wer hier nicht steht, bekommt die Glocke; das ist kein
 * Notbehelf, sondern die richtige Auskunft fuer "eine Mitteilung, sonst weiss
 * ich nichts".
 *
 * Dringendes bekommt das Warndreieck, egal woher es kommt. Es ist die eine
 * Auszeichnung, die vor der Herkunft kommt: bei einer Sturmwarnung ist das
 * Dringende die Nachricht und die Wolke nur die Adresse.
 */
const SOURCE_ICONS: Readonly<Record<string, IconName>> = {
  calendar: 'calendar-days',
  weather: 'cloud',
  sbb: 'train-front',
  spotify: 'music',
  notifications: 'bell',
};

export function feedIcon(item: Pick<FeedNotification, 'source' | 'urgent'>): IconName {
  if (item.urgent) return 'triangle-alert';
  return SOURCE_ICONS[item.source] ?? 'bell';
}

/**
 * Die Beschreibung unter dem Titel.
 *
 * Herkunft und Zusatz stehen in einer Zeile und nicht mehr in zweien:
 * "Termin · 09:30 · Kueche" ist eine Auskunft, "TERMIN" darueber und "09:30 ·
 * Kueche" darunter sind zwei Zeilen fuer dieselbe. Die Zeile darf fehlen —
 * eine Mitteilung ohne Zusatz ist ein Titel und kein halber Eintrag.
 */
export function feedDescription(item: Pick<FeedNotification, 'label' | 'meta'>): string {
  return [item.label, item.meta]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' · ');
}

/**
 * Wieviele Positionen in eine Liste dieser Hoehe passen.
 *
 * `listHeight` ist der Platz, der der Liste tatsaechlich bleibt (also ohne
 * Ueberschrift), `blockHeight` die Hoehe des ganzen Blocks — an der haengen
 * die `cqh`-Deckel der Positionen im Stylesheet, und deshalb muessen beide
 * Masse herein. `scale` ist die eingestellte Schriftgroesse: sie vergroessert
 * die Zeilen und macht die Liste damit kuerzer. Gerechnet wird mit denselben Formeln wie dort: passte hier
 * eine Position mehr als dort, waere die unterste angeschnitten.
 *
 * Angeschnitten wird nichts: was nicht ganz hineinpasst, wird nicht gezeigt.
 * Eine halbe Zeile am unteren Rand liest sich als Fehler, nicht als Ausblick.
 */
export function fitCount(listHeight: number, blockHeight: number, scale = 1): number {
  if (!Number.isFinite(listHeight) || !Number.isFinite(blockHeight)) return VISIBLE_MIN;

  // Der Faktor steht aussen und nicht in der Klammer — genau wie im
  // Stylesheet: er soll auch dann noch wirken, wenn laengst die Blockhoehe
  // entscheidet, und dann passt eben eine Position weniger hinein.
  const factor = clampTextScale(scale);
  const lead = factor * Math.min(FEED.itemHeight, blockHeight * FEED.itemShare);
  const rest = factor * Math.min(FEED.itemHeightRest, blockHeight * FEED.itemShareRest);
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
  items: readonly FeedNotification[],
  offset: number,
  slots: number,
): FeedNotification[] {
  if (items.length === 0 || slots <= 0) return [];
  const count = Math.min(slots, items.length);
  const start = items.length > slots ? ((offset % items.length) + items.length) % items.length : 0;
  return Array.from({ length: count }, (_, step) => items[(start + step) % items.length] as FeedNotification);
}
