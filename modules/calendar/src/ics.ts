/**
 * iCalendar lesen.
 *
 * Ein eigener Parser und keine Bibliothek, aus zwei Gruenden: ein Modul soll
 * eine abgeschlossene Einheit bleiben, die man einzeln nachinstallieren kann,
 * und von RFC 5545 braucht ein Spiegel eine Handvoll Felder. Was hier fehlt,
 * fehlt bewusst — Anhaenge, Teilnehmer, Alarme, Freibusy: nichts davon liest
 * jemand aus 3 m Entfernung.
 *
 * Was da ist: Termine mit und ohne Uhrzeit, Zeitzonen, Serien mit taeglicher,
 * woechentlicher, monatlicher und jaehrlicher Wiederholung samt Ausnahmen und
 * einzeln verschobenen Terminen. Das ist genau die Menge, die in einem
 * Haushaltskalender vorkommt.
 *
 * Gerechnet wird durchgaengig in Wandzeit-Feldern (Jahr, Monat, Tag, Stunde)
 * und erst am Ende in einen Zeitpunkt umgerechnet. Der Umweg ist noetig, weil
 * eine woechentliche Serie ueber die Zeitumstellung hinweg ihre Uhrzeit
 * behaelt: "jeden Montag 09:30" bleibt 09:30, auch wenn dazwischen die Uhren
 * umgestellt werden — in Millisekunden gerechnet waere daraus 08:30 oder
 * 10:30 geworden.
 */

/** Ein Zeitpunkt, wie er im Kalender steht. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Ganztaegig – dann sind die Uhrzeitfelder null und die Anzeige zeigt keine. */
  allDay: boolean;
  /** IANA-Zone aus TZID, "UTC" bei Z, oder null fuer "gilt lokal". */
  zone: string | null;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  location: string;
  start: WallTime;
  /** Fehlt im Kalender ein Ende, dauert der Termin eine Stunde bzw. den Tag. */
  end: WallTime;
  rrule: string | null;
  /** Ausgenommene Startzeitpunkte einer Serie, als Schluessel wie in `keyOf`. */
  exdates: Set<string>;
  /** Setzt diese Ausgabe einen Serientermin ausser Kraft? */
  recurrenceId: string | null;
}

/** Ein einzelner Termin im Kalender, aufgeloest und mit Zeitpunkt. */
export interface EventInstance {
  id: string;
  title: string;
  location: string;
  /** Beginn und Ende als Zeitpunkt in Millisekunden. */
  start: number;
  end: number;
  allDay: boolean;
  /** Name des Kalenders, aus dem er stammt. */
  calendar: string;
}

/* -------------------------------- Zeitzonen -------------------------------- */

/**
 * Verschiebung einer Zone gegenueber UTC, zu einem bestimmten Zeitpunkt.
 *
 * Ueber `Intl` und keine eigene Zeitzonentabelle: die Regeln aendern sich, und
 * eine mitgelieferte Tabelle waere ab dem Tag ihrer Auslieferung veraltet. Was
 * Node mitbringt, wird mit Node aktualisiert.
 */
function zoneOffset(utcMillis: number, zone: string): number {
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
export function toInstant(time: WallTime, fallbackZone: string): number {
  const naive = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const zone = time.zone ?? fallbackZone;
  if (zone === 'UTC') return naive;

  let guess = naive - zoneOffset(naive, zone);
  guess = naive - zoneOffset(guess, zone);
  return guess;
}

/** Schluessel eines Startzeitpunkts, um Ausnahmen zu erkennen. */
export function keyOf(time: WallTime): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(time.year, 4)}${pad(time.month)}${pad(time.day)}T${pad(time.hour)}${pad(time.minute)}${pad(time.second)}`;
}

/* --------------------------------- Lesen ---------------------------------- */

/**
 * Gefaltete Zeilen zusammensetzen.
 *
 * iCalendar bricht lange Zeilen um und markiert die Fortsetzung mit einem
 * Leerzeichen am Anfang. Wer das ueberspringt, verliert die zweite Haelfte
 * jedes laengeren Betreffs — und lange Betreffs sind die Regel.
 */
export function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescape(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\;/g, ';')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "DTSTART;TZID=Europe/Zurich:20260822T093000" in seine drei Teile. */
function splitLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name = '', ...rest] = head.split(';');
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/** "20260822T093000Z" oder "20260822" in Wandzeit-Felder. */
export function parseWallTime(value: string, params: Record<string, string>): WallTime | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const allDay = hour === undefined || params.VALUE === 'DATE';
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: allDay ? 0 : Number(hour),
    minute: allDay ? 0 : Number(minute ?? '0'),
    second: allDay ? 0 : Number(second ?? '0'),
    allDay,
    zone: utc ? 'UTC' : (params.TZID ?? null),
  };
}

/** Einen Tag weiterzaehlen, ohne ueber Zeitzonen nachzudenken. */
function addDays(time: WallTime, days: number): WallTime {
  const shifted = new Date(Date.UTC(time.year, time.month - 1, time.day + days));
  return {
    ...time,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Die Termine eines ICS-Dokuments.
 *
 * Abgesagte Termine fallen heraus: ein abgesagter Termin ist kein Termin,
 * und wer ihn absagt, will ihn nicht mehr an der Wand sehen.
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> & { exdates?: Set<string> } | null = null;
  let cancelled = false;

  for (const line of unfold(text)) {
    if (line.startsWith('BEGIN:VEVENT')) {
      current = { exdates: new Set<string>() };
      cancelled = false;
      continue;
    }
    if (line.startsWith('END:VEVENT')) {
      if (current && !cancelled && current.start && current.summary) {
        const start = current.start;
        // Ohne Ende dauert ein Termin mit Uhrzeit eine Stunde und einer ohne
        // den ganzen Tag. Beides ist geraten, aber ein Termin ohne Dauer
        // verschwaende die Frage, ob er gerade laeuft.
        const end =
          current.end ??
          (start.allDay ? addDays(start, 1) : { ...start, hour: start.hour + 1 });
        events.push({
          uid: current.uid ?? `${keyOf(start)}-${events.length}`,
          summary: current.summary,
          location: current.location ?? '',
          start,
          end,
          rrule: current.rrule ?? null,
          exdates: current.exdates ?? new Set(),
          recurrenceId: current.recurrenceId ?? null,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    switch (name) {
      case 'UID':
        current.uid = value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescape(value);
        break;
      case 'LOCATION':
        current.location = unescape(value);
        break;
      case 'STATUS':
        if (value.trim().toUpperCase() === 'CANCELLED') cancelled = true;
        break;
      case 'DTSTART':
        current.start = parseWallTime(value, params) ?? undefined;
        break;
      case 'DTEND':
        current.end = parseWallTime(value, params) ?? undefined;
        break;
      case 'RRULE':
        current.rrule = value.trim();
        break;
      case 'RECURRENCE-ID': {
        const time = parseWallTime(value, params);
        if (time) current.recurrenceId = keyOf(time);
        break;
      }
      case 'EXDATE':
        for (const part of value.split(',')) {
          const time = parseWallTime(part, params);
          if (time) current.exdates?.add(keyOf(time));
        }
        break;
      default:
        break;
    }
  }

  return events;
}

/* ------------------------------- Serien ----------------------------------- */

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Sicherheitsnetz gegen eine Serie ohne Ende.
 *
 * Grosszuegig, weil ein Schritt nur Feldarithmetik ist: eine taegliche Serie,
 * die vor zwanzig Jahren begann, muss bis heute durchgezaehlt werden, bevor
 * ueberhaupt der erste sichtbare Termin herauskommt. Waere die Grenze knapp,
 * fiele so eine Serie stillschweigend aus dem Kalender.
 */
const MAX_STEPS = 20_000;

function ruleParts(rrule: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const chunk of rrule.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) parts[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1);
  }
  return parts;
}

/** Wandzeit als vergleichbare Zahl – ohne Zeitzone, nur zum Sortieren. */
function naive(time: WallTime): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

/**
 * Spielraum beim Vergleich von Wandzeit mit echten Zeitpunkten.
 *
 * Im Takt der Serie wird bewusst ohne Zeitzonenrechnung verglichen: `Intl`
 * kostet pro Aufruf, und eine lange Serie fragt sonst zehntausendmal nach
 * derselben Verschiebung. Zwei Tage Spielraum sind mehr als jede Zone von UTC
 * abweicht — es kommen also hoechstens ein paar Termine zu viel heraus, die
 * die Auswahl danach ohnehin verwirft. Zu wenige koennen es nie sein.
 */
const SLACK_MS = 2 * 86_400_000;

/**
 * Die Startzeitpunkte einer Serie im Fenster.
 *
 * Unterstuetzt taeglich, woechentlich (auch mit mehreren Wochentagen),
 * monatlich und jaehrlich, jeweils mit INTERVAL, COUNT und UNTIL. Was
 * darueber hinausgeht — der dritte Donnerstag im Monat, die 30. Woche des
 * Jahres — kommt in Haushaltskalendern nicht vor und wuerde die Rechnung
 * verdoppeln. Eine Regel, die hier niemand versteht, wird zum Einzeltermin:
 * besser einmal richtig als beliebig oft falsch.
 */
export function expandRule(event: IcsEvent, fromMs: number, toMs: number, zone: string): WallTime[] {
  const start = event.start;
  if (!event.rrule) return [start];

  const parts = ruleParts(event.rrule);
  const freq = (parts.FREQ ?? '').toUpperCase();
  const interval = Math.max(1, Number(parts.INTERVAL ?? '1') || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const untilTime = parts.UNTIL ? parseWallTime(parts.UNTIL, {}) : null;
  const untilNaive = untilTime ? naive(untilTime) : null;

  const byDay = (parts.BYDAY ?? '')
    .split(',')
    .map((day) => WEEKDAYS.indexOf(day.trim().slice(-2).toUpperCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  const fromNaive = fromMs - SLACK_MS;
  const toNaive = toMs + SLACK_MS;

  const out: WallTime[] = [];
  let emitted = 0;
  let done = false;

  /** Ein Vorkommen: gezaehlt wird immer, gesammelt nur im Fenster. */
  const emit = (time: WallTime): void => {
    const stamp = naive(time);
    if (untilNaive !== null && stamp > untilNaive) {
      done = true;
      return;
    }
    emitted += 1;
    if (count !== null && emitted > count) {
      done = true;
      return;
    }
    if (stamp >= fromNaive && stamp <= toNaive) out.push(time);
  };

  const advance = (cursor: WallTime): WallTime | null => {
    switch (freq) {
      case 'DAILY':
        return addDays(cursor, interval);
      case 'WEEKLY':
        return addDays(cursor, 7 * interval);
      case 'MONTHLY': {
        const month = cursor.month - 1 + interval;
        const year = cursor.year + Math.floor(month / 12);
        const normalized = ((month % 12) + 12) % 12;
        // Der 31. in einem 30-Tage-Monat rutscht auf den letzten Tag, statt in
        // den Folgemonat zu springen.
        const lastDay = new Date(Date.UTC(year, normalized + 1, 0)).getUTCDate();
        return { ...cursor, year, month: normalized + 1, day: Math.min(start.day, lastDay) };
      }
      case 'YEARLY':
        return { ...cursor, year: cursor.year + interval };
      default:
        return null;
    }
  };

  let cursor: WallTime | null = start;
  for (let step = 0; step < MAX_STEPS && !done && cursor; step += 1) {
    if (freq === 'WEEKLY' && byDay.length > 0) {
      // Der Zeiger steht in der Woche der Serie; ausgegeben wird jeder
      // genannte Wochentag dieser Woche.
      const weekday = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day)).getUTCDay();
      for (const day of byDay) {
        emit(addDays(cursor, (day - weekday + 7) % 7));
        if (done) break;
      }
    } else {
      emit(cursor);
    }

    if (naive(cursor) > toNaive) break;
    cursor = advance(cursor);
  }

  /*
   * Zum Schluss die obere Grenze scharf ziehen.
   *
   * Im Takt wurde grosszuegig gerechnet, um `Intl` aus der Schleife zu halten;
   * hier sind es nur noch die wenigen Kandidaten im Fenster, und fuer die
   * lohnt die genaue Umrechnung. Nach unten bleibt es grosszuegig: ein Termin,
   * der gestern begann und noch laeuft, gehoert dazu, und ob er noch laeuft,
   * entscheidet erst sein Ende.
   *
   * Eine unverstandene Regel hat oben `null` geliefert und nur den ersten
   * Termin ausgegeben – das ist der Einzeltermin, auf den wir zurueckfallen.
   */
  return out.filter((time) => toInstant(time, zone) <= toMs);
}
