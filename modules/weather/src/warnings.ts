import type { NotificationInput } from '@mirror/sdk';

/**
 * Wetterwarnungen von MeteoAlarm.
 *
 * MeteoAlarm ist der gemeinsame Warndienst der europaeischen Wetterdienste:
 * was MeteoSchweiz, die ZAMG oder der DWD herausgibt, steht dort in einem
 * einheitlichen Format. Das ist der Grund fuer diese Quelle und nicht der
 * jeweilige nationale Dienst — ein Modul, das den Ort schon kennt, soll nicht
 * je Land eine eigene Schnittstelle mitbringen. Einen Schluessel braucht es
 * nicht.
 *
 * Warnungen gehoeren aus zwei Gruenden hierher und nicht in ein eigenes Modul:
 * das Wetter kennt den Ort bereits, und eine Warnung ohne das Wetter daneben
 * ist eine Meldung ohne Zusammenhang.
 *
 * Gelesen wird der Atom-Feed mit regulaeren Ausdruecken und nicht mit einem
 * XML-Parser. Das ist eine bewusste Entscheidung: der Feed ist flach, das
 * Modul soll keine Abhaengigkeit dafuer mitschleppen, und alles, was nicht
 * erkannt wird, faellt heraus, statt den Abruf scheitern zu lassen. Eine
 * Warnung, die wegen eines unbekannten Feldes fehlt, ist aergerlich; ein
 * Wettermodul, das wegen eines Feldes gar nichts mehr zeigt, ist kaputt.
 */

export interface WeatherWarning {
  id: string;
  /** Worum es geht: "Sturm", "Gewitter", "Schnee und Eis". */
  event: string;
  /**
   * Warnstufe 1 bis 4 (gruen, gelb, orange, rot).
   *
   * Gruen ist keine Warnung, sondern die Auskunft "nichts los" – solche
   * Eintraege stehen trotzdem im Feed und fliegen hier heraus.
   */
  level: number;
  /** Die Warnregion, wie der Feed sie nennt. */
  area: string;
  /** Beginn und Ende, als ISO-Zeitstempel. */
  from: string | null;
  until: string | null;
}

/**
 * Laendercode zu Feed-Name.
 *
 * Der Code kommt aus der Ortssuche, die das Modul ohnehin macht — damit passt
 * der Warnfeed automatisch zum eingestellten Ort, und es braucht keine zweite
 * Einstellung, die jemand vergessen kann umzustellen. Was nicht in dieser
 * Liste steht, bekommt keine Warnungen: ein falsches Land waere schlimmer als
 * keines.
 */
const FEEDS: Record<string, string> = {
  CH: 'switzerland',
  AT: 'austria',
  DE: 'germany',
  IT: 'italy',
  FR: 'france',
  LI: 'liechtenstein',
  NL: 'netherlands',
  BE: 'belgium',
  LU: 'luxembourg',
  DK: 'denmark',
  CZ: 'czechia',
  PL: 'poland',
  SI: 'slovenia',
  SK: 'slovakia',
  HU: 'hungary',
  HR: 'croatia',
  ES: 'spain',
  PT: 'portugal',
  SE: 'sweden',
  NO: 'norway',
  FI: 'finland',
};

export function meteoAlarmUrl(countryCode: string): string | null {
  const feed = FEEDS[countryCode.trim().toUpperCase()];
  return feed ? `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${feed}` : null;
}

/**
 * Die Warnarten, wie MeteoAlarm sie durchnummeriert.
 *
 * Der Feed liefert die Nummer und einen englischen Text. Genommen wird die
 * Nummer: der englische Text schwankt zwischen den Diensten, die Nummer nicht.
 */
const TYPES: Record<number, string> = {
  1: 'Sturm',
  2: 'Schnee und Eis',
  3: 'Gewitter',
  4: 'Nebel',
  5: 'Hitze',
  6: 'Kälte',
  7: 'Küstenwetter',
  8: 'Waldbrand',
  9: 'Lawinen',
  10: 'Regen',
  11: 'Hochwasser',
  12: 'Überschwemmung',
  13: 'Hochwasser',
};

/** Inhalt des ersten passenden Elements, egal mit welchem Namensraum davor. */
function tag(source: string, name: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`).exec(source);
  return match ? clean(match[1] ?? '') : '';
}

function clean(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Einen der `<parameter>`-Bloecke lesen.
 *
 * Dort stehen Stufe und Art, jeweils als "2; yellow; Moderate" bzw. "1; wind".
 * Gebraucht wird die fuehrende Zahl.
 */
function parameter(source: string, name: string): string {
  const blocks = source.match(/<(?:[A-Za-z0-9]+:)?parameter[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9]+:)?parameter>/g) ?? [];
  for (const block of blocks) {
    if (tag(block, 'valueName').toLowerCase().includes(name)) return tag(block, 'value');
  }
  return '';
}

function leadingNumber(value: string): number {
  const match = /(\d+)/.exec(value);
  return match ? Number(match[1]) : 0;
}

function stampOf(value: string): string | null {
  if (value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Die Warnungen aus einem Atom- oder RSS-Feed.
 *
 * Beide Formen, weil MeteoAlarm beide ausliefert und sich im Inneren nur der
 * Name des Eintragselements unterscheidet.
 */
export function parseWarnings(xml: string): WeatherWarning[] {
  const entries = xml.match(/<(entry|item)[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  const warnings: WeatherWarning[] = [];

  for (const [index, entry] of entries.entries()) {
    const level = leadingNumber(parameter(entry, 'awareness_level'));
    // Ohne Stufe ist es keine Warnung, sondern ein Feed-Eintrag ueber das
    // Nichtvorhandensein einer Warnung. Genau die machen die Mehrzahl aus.
    if (level < 2) continue;

    const type = leadingNumber(parameter(entry, 'awareness_type'));
    const event = TYPES[type] ?? clean(tag(entry, 'event')) ?? '';
    const area = clean(tag(entry, 'areaDesc'));

    warnings.push({
      id: clean(tag(entry, 'id')) || `warning-${index}`,
      event: event.length > 0 ? event : 'Wetterwarnung',
      level,
      area,
      from: stampOf(tag(entry, 'onset')) ?? stampOf(tag(entry, 'effective')),
      until: stampOf(tag(entry, 'expires')),
    });
  }

  return warnings;
}

/**
 * Was davon jetzt zaehlt.
 *
 * Abgelaufenes faellt heraus, der Rest wird nach Stufe geordnet: steht nur
 * eine Warnung im Block, soll es die ernsteste sein. Der Regionsfilter ist
 * eine Textsuche und kein Schluessel — die Namen der Warnregionen sind
 * Klartext ("Bern", "Tessin"), und wer sie eintippt, soll nicht ihre Kennung
 * suchen muessen.
 */
export function selectWarnings(
  items: readonly WeatherWarning[],
  region: string,
  now: Date = new Date(),
): WeatherWarning[] {
  const needle = region.trim().toLowerCase();
  const stamp = now.getTime();

  return items
    .filter((item) => {
      if (item.until && Date.parse(item.until) <= stamp) return false;
      if (needle.length === 0) return true;
      return item.area.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.level - a.level);
}

/** Ab dieser Stufe (orange) rueckt eine Warnung im Feed ganz nach oben. */
export const URGENT_LEVEL = 3;

/**
 * Eine Warnung als Mitteilung.
 *
 * Der Titel ist die Warnart und nicht "Wetterwarnung": aus 3 m liest man ein
 * Wort, und "Sturm" ist das Wort, um das es geht. Woher es kommt, steht im
 * Label, und wann es gilt, in der Zweitzeile.
 */
export function warningNotifications(
  items: readonly WeatherWarning[],
  format: (stamp: string) => string,
): NotificationInput[] {
  return items.map((item) => {
    const parts = [item.area, item.from ? `ab ${format(item.from)}` : '', item.until ? `bis ${format(item.until)}` : '']
      .filter((part) => part.length > 0);
    return {
      id: item.id,
      label: 'Warnung',
      title: item.event,
      meta: parts.join(' · '),
      urgent: item.level >= URGENT_LEVEL,
      at: item.from,
      expiresAt: item.until,
    };
  });
}
