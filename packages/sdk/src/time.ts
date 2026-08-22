/**
 * Wandzeit und Zeitpunkt.
 *
 * Module, die mit Fahrplaenen oder Kalendern arbeiten, bekommen Zeiten in
 * Wandzeit geliefert — "09:31" ohne Zone, weil der Fahrplan die Zone fuer
 * selbstverstaendlich haelt. Um daraus einen Zeitpunkt zu machen, braucht es
 * die Verschiebung der Zone, und die haengt am Datum.
 *
 * Steht hier und nicht in einem der Module, weil sonst jedes Modul, das
 * Zeiten liest, seine eigene Zeitzonenrechnung mitbrachte — und zwei
 * Implementierungen derselben Sache weichen frueher oder spaeter voneinander
 * ab. Ohne eigene Zeitzonentabelle: `Intl` weiss es, und was Node mitbringt,
 * wird mit Node aktualisiert.
 */

/** Wandzeit ohne Zone, so wie sie auf einer Uhr oder im Fahrplan steht. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Verschiebung einer Zone gegenueber UTC, zu einem bestimmten Zeitpunkt. */
export function zoneOffset(utcMillis: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMillis));

  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // Mitternacht kommt aus Intl je nach Umgebung als "24" heraus.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - utcMillis;
}

/**
 * Wandzeit in einen Zeitpunkt.
 *
 * Zwei Durchgaenge, weil die Verschiebung selbst vom Zeitpunkt abhaengt: der
 * erste schaetzt, der zweite korrigiert. In der doppelten Stunde der
 * Rueckstellung gibt es zwei richtige Antworten; genommen wird die fruehere,
 * denn ein Termin um 02:30 ist der erste 02:30 des Tages.
 */
export function instantOf(time: WallClock, zone: string): number {
  const naive = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  if (zone === 'UTC') return naive;
  let guess = naive - zoneOffset(naive, zone);
  guess = naive - zoneOffset(guess, zone);
  return guess;
}

/**
 * "2026-08-24 09:31:00" in einen Zeitpunkt.
 *
 * Die Form, in der Fahrplanauskuenfte ihre Zeiten liefern: Ortszeit, ohne
 * Zone, mit Leerzeichen statt T. `Date.parse` deutet das je nach Umgebung als
 * UTC oder als Ortszeit des Rechners — beides waere hier falsch.
 */
export function parseLocalStamp(value: string, zone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return instantOf(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? '0'),
    },
    zone,
  );
}
