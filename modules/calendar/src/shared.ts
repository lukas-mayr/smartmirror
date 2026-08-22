import type { NotificationInput } from '@mirror/sdk';
import { expandRule, keyOf, parseIcs, toInstant, type EventInstance, type IcsEvent } from './ics.js';

export type { EventInstance };

/**
 * Der Kalender.
 *
 * Er zeigt, was ansteht — heute, morgen oder die Woche, je nach Einstellung.
 * Die Quellen sind ICS-Adressen: iCloud gibt sie fuer einen veroeffentlichten
 * Kalender heraus, Gemeinden fuer den Muellkalender, Schulen fuer die Ferien.
 * Ein Format, drei Anwendungsfaelle, kein Konto.
 *
 * Was das Modul anzeigt, meldet es auf Wunsch auch dem Mitteilungsblock. Der
 * Zeitraum dafuer ist ein eigener: im Kalenderblock will man die Woche sehen,
 * im Mitteilungsblock steht sinnvollerweise nur, was heute noch kommt.
 */
export interface CalendarConfig {
  /** Eine Quelle je Zeile, als "Name | Adresse" oder nur die Adresse. */
  calendars: string;
  /** Wieviele Tage der Block zeigt. 1 heisst nur heute. */
  days: number;
  /** Obergrenze der Zeilen im Block. */
  maxEvents: number;
  /** Termine an den Mitteilungsblock melden. */
  notify: boolean;
  /** Wieviele Tage davon gemeldet werden. */
  notifyDays: number;
  /** Wieviele Termine hoechstens gemeldet werden. */
  notifyCount: number;
  refreshMinutes: number;
}

export interface CalendarState {
  events: EventInstance[];
  fetchedAt: string | null;
  /** Quellen, die gerade nicht erreichbar sind – die Anzeige dimmt dann. */
  failing: string[];
}

export interface CalendarSource {
  name: string;
  url: string;
}

/**
 * Die Quellen aus dem Textfeld.
 *
 * "Familie | https://…" wird zu Name und Adresse; steht nur eine Adresse da,
 * traegt der Kalender keinen Namen. Ein Name ist kein Muss: bei einem einzigen
 * Kalender waere er nur eine Spalte, die immer dasselbe sagt.
 */
export function parseSources(value: string): CalendarSource[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const bar = line.lastIndexOf('|');
      const name = bar > 0 ? line.slice(0, bar).trim() : '';
      const url = (bar > 0 ? line.slice(bar + 1) : line).trim().replace(/^webcal:\/\//i, 'https://');
      return { name, url };
    })
    .filter((source) => /^https?:\/\//i.test(source.url));
}

/**
 * Beginn des Tages in der Zeitzone des Spiegels, als Zeitpunkt.
 *
 * Gebraucht, weil "heute" keine 24 Stunden ab jetzt sind, sondern bis
 * Mitternacht: wer um 23:00 auf den Spiegel sieht, will nicht die Termine von
 * morgen frueh unter "heute" finden.
 */
export function startOfDay(now: Date, timezone: string, offsetDays = 0): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return toInstant(
    {
      year: get('year'),
      month: get('month'),
      day: get('day') + offsetDays,
      hour: 0,
      minute: 0,
      second: 0,
      allDay: true,
      zone: timezone,
    },
    timezone,
  );
}

/**
 * Die Termine eines Kalenders im Fenster, aufgeloest und sortiert.
 *
 * Verschobene Einzeltermine ersetzen ihren Serientermin: ein Standup, der
 * einmal auf 10:00 gerueckt ist, steht einmal da und nicht zweimal.
 */
export function collectInstances(
  events: readonly IcsEvent[],
  calendar: string,
  fromMs: number,
  toMs: number,
  zone: string,
): EventInstance[] {
  const overrides = new Set(
    events.filter((event) => event.recurrenceId).map((event) => `${event.uid}@${event.recurrenceId}`),
  );

  const out: EventInstance[] = [];
  for (const event of events) {
    const starts = event.recurrenceId ? [event.start] : expandRule(event, fromMs, toMs, zone);
    const duration = toInstant(event.end, zone) - toInstant(event.start, zone);

    for (const start of starts) {
      const key = keyOf(start);
      if (event.exdates.has(key)) continue;
      if (!event.recurrenceId && overrides.has(`${event.uid}@${key}`)) continue;

      const startMs = toInstant(start, zone);
      // Die Dauer stammt aus dem Ursprungstermin: eine Serie behaelt ihre
      // Laenge, auch wenn die Zeitumstellung dazwischenliegt.
      const endMs = startMs + Math.max(0, duration);
      if (endMs <= fromMs || startMs > toMs) continue;

      out.push({
        id: `${event.uid}@${key}`,
        title: event.summary,
        location: event.location,
        start: startMs,
        end: endMs,
        allDay: start.allDay,
        calendar,
      });
    }
  }
  return out;
}

/** Alles aus einem ICS-Dokument, im Fenster. */
export function eventsFromIcs(
  text: string,
  calendar: string,
  fromMs: number,
  toMs: number,
  zone: string,
): EventInstance[] {
  return collectInstances(parseIcs(text), calendar, fromMs, toMs, zone);
}

/**
 * Was angezeigt wird: sortiert, entdoppelt, begrenzt.
 *
 * Entdoppelt, weil derselbe Termin in zwei abonnierten Kalendern stehen kann —
 * der Geburtstag steht im Familienkalender und im eigenen, und zweimal
 * untereinander sieht nach einem Fehler aus. Ganztaegiges steht vor
 * Terminiertem desselben Tages: es gilt den ganzen Tag und damit auch jetzt.
 */
export function selectEvents(
  events: readonly EventInstance[],
  limit: number,
  toMs: number,
): EventInstance[] {
  const seen = new Set<string>();
  return [...events]
    .filter((event) => event.start <= toMs)
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.title.localeCompare(b.title);
    })
    .filter((event) => {
      const key = `${event.start}|${event.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, limit));
}

/* ------------------------------- Beschriften ------------------------------ */

export interface EventLabels {
  /** Der Tag, soweit er nicht heute ist: "Morgen", "Sa". */
  day: string;
  /** Die Zeit: "09:30", "jetzt", "in 18 min", "ganztaegig". */
  time: string;
}

/**
 * Wie ein Termin beschriftet wird.
 *
 * Nah dran zaehlt die Spanne, weiter weg der Tag: "in 18 min" beantwortet die
 * Frage, die man um neun Uhr morgens hat, "09:30" die von gestern Abend. Die
 * Grenze liegt bei einer Stunde — darueber rechnet niemand mehr in Minuten.
 */
export function describeEvent(
  event: EventInstance,
  now: Date,
  timezone: string,
  locale: string,
): EventLabels {
  const stamp = now.getTime();
  const tomorrow = startOfDay(now, timezone, 1);
  const dayAfter = startOfDay(now, timezone, 2);

  const day =
    event.start < tomorrow
      ? ''
      : event.start < dayAfter
        ? 'Morgen'
        : new Date(event.start).toLocaleDateString(locale, { timeZone: timezone, weekday: 'short' });

  if (event.allDay) {
    // Ein ganztaegiger Termin hat keine Uhrzeit, und eine erfundene waere eine
    // Behauptung ueber etwas, das im Kalender nicht steht.
    return { day: day || 'Heute', time: '' };
  }

  const clock = new Date(event.start).toLocaleTimeString(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });

  if (event.start <= stamp && event.end > stamp) return { day, time: 'jetzt' };

  const minutes = Math.round((event.start - stamp) / 60_000);
  if (minutes > 0 && minutes <= 60) return { day: '', time: `in ${minutes} min` };

  return { day, time: clock };
}

/**
 * Termine als Mitteilungen.
 *
 * Das Label traegt den Zeitpunkt und der Titel den Termin: im Mitteilungsblock
 * steht der Titel gross, und "Standup" ist die Auskunft, nicht "09:30".
 */
export function eventNotifications(
  events: readonly EventInstance[],
  now: Date,
  timezone: string,
  locale: string,
): NotificationInput[] {
  return events.map((event) => {
    const { day, time } = describeEvent(event, now, timezone, locale);
    const when = [day, time].filter((part) => part.length > 0).join(' ');
    return {
      id: event.id,
      label: when.length > 0 ? `Termin · ${when}` : 'Termin',
      title: event.title,
      meta: event.location,
      urgent: false,
      at: new Date(event.start).toISOString(),
      // Ein Termin verschwindet, wenn er vorbei ist, und nicht wenn er
      // beginnt: waehrend er laeuft, ist er die richtige Antwort auf "was ist
      // gerade".
      expiresAt: new Date(event.end).toISOString(),
    };
  });
}
