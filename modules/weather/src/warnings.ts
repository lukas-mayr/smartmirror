import type { NotificationInput } from '@mirror/sdk';

/**
 * Wetterwarnungen von MeteoAlarm.
 *
 * MeteoAlarm ist der gemeinsame Warndienst der europaeischen Wetterdienste:
 * was MeteoSchweiz, GeoSphere Austria oder der DWD herausgibt, steht dort in
 * einem einheitlichen Format. Das ist der Grund fuer diese Quelle und nicht
 * der jeweilige nationale Dienst — ein Modul, das den Ort schon kennt, soll
 * nicht je Land eine eigene Schnittstelle mitbringen. Einen Schluessel braucht
 * es nicht.
 *
 * Warnungen gehoeren aus zwei Gruenden hierher und nicht in ein eigenes Modul:
 * das Wetter kennt den Ort bereits, und eine Warnung ohne das Wetter daneben
 * ist eine Meldung ohne Zusammenhang.
 *
 * Gelesen wird die JSON-Schnittstelle und nicht der Atom-Feed daneben. Der
 * Atom-Feed traegt je Warnung nur einen Kopf — Gebiet, Zeitraum, Dringlichkeit
 * — und verlinkt fuer alles Weitere ein zweites Dokument. Vor allem die
 * Warnstufe steht erst dort. Ein Spiegel, der ohne Stufe nicht entscheiden
 * kann, ob eine Zeile gelb oder rot ist, muesste also je Warnung ein zweites
 * Mal fragen. Die JSON-Schnittstelle liefert dieselben Warnungen vollstaendig
 * in einer Antwort.
 *
 * Gearbeitet wird defensiv: was nicht erkannt wird, faellt heraus, statt den
 * Abruf scheitern zu lassen. Eine Warnung, die wegen eines unbekannten Feldes
 * fehlt, ist aergerlich; ein Wettermodul, das wegen eines Feldes gar nichts
 * mehr zeigt, ist kaputt.
 */

export interface WeatherWarning {
  id: string;
  /** Worum es geht: "Sturm", "Gewitter", "Schnee und Eis". */
  event: string;
  /**
   * Warnstufe 1 bis 4 (gruen, gelb, orange, rot).
   *
   * Gruen ist keine Warnung, sondern die Auskunft "nichts los" – solche
   * Eintraege stehen trotzdem in der Antwort und fliegen hier heraus.
   */
  level: number;
  /** Die Warnregion, wie der Dienst sie nennt. */
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
 * keines. Liechtenstein fehlt, weil MeteoAlarm es nicht fuehrt — der
 * Schweizer Feed daneben waere die falsche Antwort auf die richtige Frage.
 */
const FEEDS: Record<string, string> = {
  AT: 'austria',
  BE: 'belgium',
  BA: 'bosnia-herzegovina',
  BG: 'bulgaria',
  HR: 'croatia',
  CY: 'cyprus',
  CZ: 'czechia',
  DK: 'denmark',
  EE: 'estonia',
  FI: 'finland',
  FR: 'france',
  DE: 'germany',
  GR: 'greece',
  HU: 'hungary',
  IS: 'iceland',
  IE: 'ireland',
  IL: 'israel',
  IT: 'italy',
  LV: 'latvia',
  LT: 'lithuania',
  LU: 'luxembourg',
  MT: 'malta',
  MD: 'moldova',
  ME: 'montenegro',
  NL: 'netherlands',
  MK: 'north-macedonia',
  NO: 'norway',
  PL: 'poland',
  PT: 'portugal',
  RO: 'romania',
  RS: 'serbia',
  SK: 'slovakia',
  SI: 'slovenia',
  ES: 'spain',
  SE: 'sweden',
  CH: 'switzerland',
  TR: 'turkey',
  UA: 'ukraine',
  GB: 'united-kingdom',
};

export function meteoAlarmUrl(countryCode: string): string | null {
  const feed = FEEDS[countryCode.trim().toUpperCase()];
  return feed ? `https://feeds.meteoalarm.org/api/v1/warnings/feeds-${feed}` : null;
}

/**
 * Die Warnarten, wie MeteoAlarm sie durchnummeriert.
 *
 * Die Antwort liefert die Nummer und einen englischen Text. Genommen wird die
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

/**
 * CAP-Dringlichkeit als Ersatz fuer die Warnstufe.
 *
 * Nur der Notnagel: `awareness_level` ist das, worauf die Farben von
 * MeteoAlarm beruhen, und steht praktisch immer dabei. Fehlt es, ist eine
 * Warnung mit ungefaehrer Stufe immer noch besser als keine.
 */
const SEVERITIES: Record<string, number> = {
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
};

/** Ab dieser Stufe (orange) rueckt eine Warnung im Feed ganz nach oben. */
export const URGENT_LEVEL = 3;

/** Der Ort des Spiegels, gegen den die Warngebiete geprueft werden. */
export interface Place {
  latitude: number;
  longitude: number;
}

export interface ParseOptions {
  /**
   * Sprache der Textfelder, z.B. "de". Eine Warnung steht in der Antwort
   * einmal je Sprache; genommen wird die passende, sonst Englisch, sonst die
   * erste.
   */
  language?: string;
  /**
   * Der Ort. Ist er gesetzt, bleiben nur Warnungen, deren Gebiet ihn
   * einschliesst.
   *
   * Ohne diese Pruefung waere eine Warnung "irgendwo im Land" — ein Spiegel in
   * Wien zeigte die Lawinenwarnung fuer Tirol. Warnungen ohne Polygon bleiben
   * trotzdem stehen: dass ein Dienst seine Gebiete nicht als Flaeche
   * mitschickt, darf nicht heissen, dass er gar nicht mehr warnt.
   */
  place?: Place | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Ein Feld, das eines oder mehrere sein darf, als Liste.
 *
 * CAP kennt `info`, `area` und `parameter` in der Mehrzahl, aber wer nur eines
 * hat, schickt gern das nackte Objekt. Beides hier einmal geradebiegen ist
 * billiger, als es an jeder Stelle zu bedenken.
 */
function list(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
  if (typeof value === 'object' && value !== null) return [value as Record<string, unknown>];
  return [];
}

function stampOf(value: unknown): string | null {
  const raw = text(value);
  if (raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function leadingNumber(value: string): number {
  const match = /(\d+)/.exec(value);
  return match ? Number(match[1]) : 0;
}

/**
 * Einen der `parameter`-Eintraege lesen.
 *
 * Dort stehen Stufe und Art, jeweils als "2; yellow; Moderate" bzw. "1; Wind".
 * Gebraucht wird die fuehrende Zahl.
 */
function parameter(info: Record<string, unknown>, name: string): string {
  for (const entry of list(info.parameter)) {
    if (text(entry.valueName).toLowerCase().includes(name)) return text(entry.value);
  }
  return '';
}

/**
 * Der Sprachblock, der hier gebraucht wird.
 *
 * Die Stufe steht in jedem Block gleich; die Sprache entscheidet nur ueber die
 * Texte. Trotzdem wird gewaehlt und nicht der erste genommen: sonst haengt das
 * Ergebnis an der Reihenfolge, in der ein Dienst seine Uebersetzungen anlegt.
 */
function pickInfo(infos: Record<string, unknown>[], language: string): Record<string, unknown> | null {
  if (infos.length === 0) return null;
  const wanted = language.trim().toLowerCase().split('-')[0] ?? '';
  const matches = (info: Record<string, unknown>, prefix: string): boolean =>
    text(info.language).toLowerCase().startsWith(prefix);
  return (
    (wanted.length > 0 ? infos.find((info) => matches(info, wanted)) : undefined) ??
    infos.find((info) => matches(info, 'en')) ??
    infos[0] ??
    null
  );
}

/**
 * Liegt der Punkt im Polygon?
 *
 * Strahlverfahren, wie es fuer die Frage "betrifft mich das" ueblich ist. Die
 * Polygone von MeteoAlarm sind Ketten aus "Breite,Laenge" — in dieser
 * Reihenfolge, anders als bei GeoJSON.
 */
function pointInPolygon(place: Place, polygon: string): boolean {
  const points: [number, number][] = [];
  for (const pair of polygon.trim().split(/\s+/)) {
    const [latitude, longitude] = pair.split(',').map(Number);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) points.push([latitude as number, longitude as number]);
  }
  if (points.length < 3) return false;

  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [latI, lonI] = points[i] as [number, number];
    const [latJ, lonJ] = points[j] as [number, number];
    const crosses = latI > place.latitude !== latJ > place.latitude;
    if (!crosses) continue;
    const cut = ((lonJ - lonI) * (place.latitude - latI)) / (latJ - latI) + lonI;
    if (place.longitude < cut) inside = !inside;
  }
  return inside;
}

/**
 * Betrifft die Warnung den Ort?
 *
 * Gibt `null` zurueck, wenn die Frage sich nicht stellt — kein Ort bekannt
 * oder kein Polygon dabei. Der Aufrufer laesst solche Warnungen stehen; das
 * ist der Unterschied zwischen "trifft nicht zu" und "kann ich nicht sagen".
 */
function covers(areas: Record<string, unknown>[], place: Place | null | undefined): boolean | null {
  if (!place) return null;
  let asked = false;
  for (const area of areas) {
    for (const polygon of Array.isArray(area.polygon) ? area.polygon : [area.polygon]) {
      const raw = text(polygon);
      if (raw.length === 0) continue;
      asked = true;
      if (pointInPolygon(place, raw)) return true;
    }
  }
  return asked ? false : null;
}

/**
 * Die Kennungen, auf die sich eine Meldung bezieht.
 *
 * CAP schreibt sie als "Absender,Kennung,Zeitpunkt", mehrere durch Leerzeichen
 * getrennt. Gebraucht wird die mittlere.
 */
function referenced(value: unknown): string[] {
  return text(value)
    .split(/\s+/)
    .map((part) => part.split(',')[1] ?? '')
    .filter((id) => id.length > 0);
}

/**
 * Die Warnungen aus der Antwort der JSON-Schnittstelle.
 *
 * Erwartet wird `{ warnings: [{ alert: { … } }] }`; alles andere ergibt eine
 * leere Liste statt eines Fehlers.
 */
export function parseWarnings(payload: unknown, options: ParseOptions = {}): WeatherWarning[] {
  const root = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const alerts = list(root.warnings).map((entry) => list(entry.alert)[0] ?? entry);

  /*
   * Zurueckgezogenes zuerst einsammeln.
   *
   * Eine Aufhebung ("Cancel") und eine Fortschreibung ("Update") nennen die
   * Meldung, die sie ersetzen. Ohne diesen Durchgang stuende die alte Warnung
   * neben der neuen, und der Spiegel zeigte einen Sturm, den der Wetterdienst
   * laengst abgeblasen hat.
   */
  const withdrawn = new Set<string>();
  for (const alert of alerts) {
    const type = text(alert.msgType).toLowerCase();
    if (type === 'cancel' || type === 'update') {
      for (const id of referenced(alert.references)) withdrawn.add(id);
    }
  }

  const language = options.language ?? '';
  const warnings: WeatherWarning[] = [];

  for (const [index, alert] of alerts.entries()) {
    const identifier = text(alert.identifier);
    if (withdrawn.has(identifier)) continue;

    const type = text(alert.msgType).toLowerCase();
    if (type === 'cancel' || type === 'ack' || type === 'error') continue;
    // "Actual" ist die Meldung, die gilt; daneben gibt es Uebungen und
    // Systemtests, die auf einem Spiegel im Flur nichts verloren haben. Fehlt
    // die Angabe, wird sie als echt genommen.
    const status = text(alert.status).toLowerCase();
    if (status.length > 0 && status !== 'actual') continue;

    const info = pickInfo(list(alert.info), language);
    if (!info) continue;

    const areas = list(info.area);
    if (covers(areas, options.place) === false) continue;

    const level = leadingNumber(parameter(info, 'awareness_level')) || SEVERITIES[text(info.severity).toLowerCase()] || 0;
    // Ohne Stufe ist es keine Warnung, sondern die Auskunft, dass nichts los
    // ist. Genau die machen die Mehrzahl aus.
    if (level < 2) continue;

    const kind = TYPES[leadingNumber(parameter(info, 'awareness_type'))] ?? '';
    const event = kind || text(info.event) || text(info.headline);
    const named = areas.map((area) => text(area.areaDesc)).filter((name) => name.length > 0);

    warnings.push({
      id: identifier || `warning-${index}`,
      event: event.length > 0 ? event : 'Wetterwarnung',
      level,
      area: [...new Set(named)].join(', '),
      from: stampOf(info.onset) ?? stampOf(info.effective),
      until: stampOf(info.expires),
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
 * suchen muessen. Er engt weiter ein, was der Ortsabgleich beim Lesen schon
 * uebrig gelassen hat.
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
