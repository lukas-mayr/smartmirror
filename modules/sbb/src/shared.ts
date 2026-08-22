import { parseLocalStamp, type NotificationInput } from '@mirror/sdk';

/**
 * Abfahrten im oeffentlichen Verkehr der Schweiz.
 *
 * Quelle ist die Fahrplanauskunft von search.ch: sie liefert JSON, braucht
 * keinen Schluessel und kennt Bahn, Bus, Tram und Schiff im selben Format.
 * Der offizielle Weg ueber opentransportdata.swiss waere XML mit
 * Registrierung — mehr Genauigkeit bei den Verspaetungen, aber auch mehr
 * Aufwand, als eine Abfahrtstafel an der Wand rechtfertigt.
 *
 * Das Modul zeigt, was als naechstes faehrt, und meldet auf Wunsch die
 * naechsten ein bis zwei Abfahrten an den Mitteilungsblock. Genau dafuer ist
 * eine Abfahrt die dankbarste Mitteilung: sie hat einen Zeitpunkt, sie ist
 * kurz, und sie raeumt sich selbst weg, wenn der Zug weg ist.
 */

export interface SbbConfig {
  /** Haltestelle, wie man sie am Automaten eintippt: "Bern", "Zuerich HB". */
  stop: string;
  /** Wieviele Abfahrten geholt werden. */
  limit: number;
  /**
   * Fussweg zur Haltestelle in Minuten.
   *
   * Was man nicht mehr erreicht, wird nicht gezeigt. Das ist der Unterschied
   * zwischen einer Abfahrtstafel am Bahnhof und einer in der Wohnung: hier
   * zaehlt nicht, was faehrt, sondern was man noch bekommt.
   */
  walkMinutes: number;
  /** Nur diese Linien, kommagetrennt. Leer heisst alle. */
  lines: string;
  /** Abfahrten an den Mitteilungsblock melden. */
  notify: boolean;
  notifyCount: number;
  refreshSeconds: number;
}

export interface Departure {
  id: string;
  /** Linienbezeichnung: "S3", "10", "IC 8". */
  line: string;
  /** Wohin: "Biel/Bienne". */
  destination: string;
  /** Planmaessige Abfahrt als Zeitpunkt. */
  scheduled: number;
  /** Verspaetung in Minuten. Null heisst puenktlich oder unbekannt. */
  delay: number;
  /** Faellt aus – steht dann statt der Minutenangabe da. */
  cancelled: boolean;
  /** Gleis oder Kante, wenn bekannt. */
  track: string;
}

export interface SbbState {
  stop: string;
  departures: Departure[];
  fetchedAt: string | null;
}

interface RawConnection {
  time?: unknown;
  type?: unknown;
  line?: unknown;
  number?: unknown;
  terminal?: { name?: unknown } | null;
  track?: unknown;
  dep_delay?: unknown;
  '*L'?: unknown;
}

interface RawBoard {
  stop?: { name?: unknown } | null;
  connections?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/**
 * Verspaetung aus dem Feld, das die Auskunft mitschickt.
 *
 * Sie kommt als Text: "+3" fuer drei Minuten, "-1" fuer zu frueh, "X" fuer
 * einen Ausfall, leer fuer puenktlich. Ein Ausfall ist keine Verspaetung von
 * null Minuten, deshalb kommt er getrennt heraus.
 */
export function parseDelay(value: unknown): { delay: number; cancelled: boolean } {
  const raw = text(value).toUpperCase();
  if (raw === 'X') return { delay: 0, cancelled: true };
  const minutes = Number.parseInt(raw, 10);
  return { delay: Number.isFinite(minutes) ? minutes : 0, cancelled: false };
}

/**
 * Die Abfahrten aus der Antwort.
 *
 * Tolerant gegen fehlende Felder: eine Verbindung ohne Ziel ist immer noch
 * eine Verbindung, und eine Abfahrtstafel, die wegen eines fehlenden Gleises
 * leer bleibt, waere die schlechtere Antwort.
 */
export function parseBoard(body: unknown, zone: string): Departure[] {
  const board = (typeof body === 'object' && body !== null ? body : {}) as RawBoard;
  const list = Array.isArray(board.connections) ? (board.connections as RawConnection[]) : [];

  const out: Departure[] = [];
  for (const [index, entry] of list.entries()) {
    const scheduled = parseLocalStamp(text(entry.time), zone);
    if (scheduled === null) continue;

    const { delay, cancelled } = parseDelay(entry.dep_delay);
    const line = text(entry['*L']) || text(entry.line) || text(entry.number) || text(entry.type);
    out.push({
      id: `${line}-${scheduled}-${index}`,
      line,
      destination: text(entry.terminal?.name),
      scheduled,
      delay,
      cancelled,
      track: text(entry.track),
    });
  }
  return out;
}

/** Der Name der Haltestelle, wie die Auskunft ihn kennt. */
export function boardStopName(body: unknown, fallback: string): string {
  const board = (typeof body === 'object' && body !== null ? body : {}) as RawBoard;
  const name = text(board.stop?.name);
  return name.length > 0 ? name : fallback;
}

/** Tatsaechliche Abfahrt, also planmaessig plus Verspaetung. */
export function actualDeparture(departure: Departure): number {
  return departure.scheduled + departure.delay * 60_000;
}

/**
 * Was davon noch zu erreichen ist.
 *
 * Der Fussweg zaehlt: eine Abfahrt in zwei Minuten ist keine Information,
 * wenn man sieben Minuten zur Haltestelle braucht — sie ist eine Zeile, die
 * den Platz derjenigen wegnimmt, die man noch bekommt. Ausfaelle bleiben
 * stehen, solange sie in der Zukunft liegen: dass etwas nicht faehrt, ist die
 * wichtigere Nachricht.
 */
export function selectDepartures(
  departures: readonly Departure[],
  now: Date,
  walkMinutes: number,
  lines: string,
  limit: number,
): Departure[] {
  const earliest = now.getTime() + Math.max(0, walkMinutes) * 60_000;
  const wanted = lines
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return departures
    .filter((departure) => actualDeparture(departure) >= earliest)
    .filter((departure) => wanted.length === 0 || wanted.includes(departure.line.toLowerCase()))
    .sort((a, b) => actualDeparture(a) - actualDeparture(b))
    .slice(0, Math.max(1, limit));
}

/**
 * Wie lange es noch dauert, als Text.
 *
 * In Minuten, solange es in Minuten zaehlbar ist, sonst als Uhrzeit: "in 7
 * min" beantwortet die Frage im Flur, "14:32" die am Vorabend. Ab einer
 * Stunde rechnet niemand mehr in Minuten.
 */
export function countdown(
  departure: Departure,
  now: Date,
  locale: string,
  zone: string,
): string {
  if (departure.cancelled) return 'faellt aus';
  const minutes = Math.round((actualDeparture(departure) - now.getTime()) / 60_000);
  if (minutes <= 0) return 'jetzt';
  if (minutes <= 60) return `${minutes} min`;
  return new Date(actualDeparture(departure)).toLocaleTimeString(locale, {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Abfahrten als Mitteilungen.
 *
 * Die Linie gehoert ins Label und das Ziel in den Titel: "Biel" ist die
 * Auskunft, "S3" die Herkunft. Die Mitteilung laeuft ab, wenn der Zug weg ist
 * — nicht frueher, denn bis dahin ist sie richtig, und nicht spaeter, denn
 * danach ist sie falsch.
 */
export function departureNotifications(
  departures: readonly Departure[],
  now: Date,
  locale: string,
  zone: string,
): NotificationInput[] {
  return departures.map((departure) => {
    const parts = [
      countdown(departure, now, locale, zone),
      departure.delay > 0 ? `+${departure.delay}` : '',
      departure.track ? `Gl. ${departure.track}` : '',
    ].filter((part) => part.length > 0);

    return {
      id: departure.id,
      label: departure.line ? `Abfahrt · ${departure.line}` : 'Abfahrt',
      title: departure.destination || departure.line || 'Abfahrt',
      meta: parts.join(' · '),
      // Ein Ausfall ist die eine Abfahrtsmeldung, die nach oben gehoert: sie
      // aendert den Plan, statt ihn zu bestaetigen.
      urgent: departure.cancelled,
      at: new Date(actualDeparture(departure)).toISOString(),
      expiresAt: new Date(actualDeparture(departure)).toISOString(),
    };
  });
}
