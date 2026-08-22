import { defineBackend } from '@mirror/sdk';
import {
  eventNotifications,
  eventsFromIcs,
  parseSources,
  selectEvents,
  startOfDay,
  type CalendarConfig,
  type CalendarState,
  type EventInstance,
} from './shared.js';

/**
 * Wie oft die Auswahl neu getroffen wird, ohne neu zu laden.
 *
 * Termine aendern sich selten, ihre Beschriftung dauernd: "in 18 min" wird zu
 * "in 17 min", und um Mitternacht wird aus "Morgen" ein "Heute". Neu zu laden
 * waere dafuer Unsinn — die Daten sind ja dieselben.
 */
const RESELECT_MS = 60_000;

/** Wieviel eine einzelne Quelle liefern darf, bevor wir sie fuer kaputt halten. */
const MAX_BYTES = 4 * 1024 * 1024;

export default defineBackend<CalendarConfig, CalendarState>({
  async setup(ctx) {
    /** Der zuletzt geholte Text je Quelle. Ueberlebt einen Netzausfall. */
    const documents = new Map<string, string>();
    const failing = new Set<string>();

    /**
     * Das Fenster, das die Anzeige braucht.
     *
     * Beginn ist jetzt und nicht Mitternacht: was heute frueh war, ist vorbei,
     * und ein Kalender, der abgelaufene Termine zeigt, kostet nur Platz. Ende
     * ist Mitternacht des letzten gewuenschten Tages — "drei Tage" heisst
     * heute, morgen und uebermorgen, nicht 72 Stunden ab jetzt.
     */
    const windowFor = (days: number, now: Date): { from: number; to: number } => ({
      from: now.getTime(),
      to: startOfDay(now, ctx.timezone, Math.max(1, days)),
    });

    /** Aus den geladenen Dokumenten die Termine im groessten noetigen Fenster. */
    const instancesFor = (from: number, to: number): EventInstance[] => {
      const out: EventInstance[] = [];
      for (const source of parseSources(ctx.config.calendars)) {
        const text = documents.get(source.url);
        if (!text) continue;
        try {
          out.push(...eventsFromIcs(text, source.name, from, to, ctx.timezone));
        } catch (error) {
          ctx.log.warn(`Kalender "${source.name || source.url}" nicht lesbar: ${String(error)}`);
        }
      }
      return out;
    };

    /**
     * Auswahl treffen, anzeigen, melden.
     *
     * Zwei Fenster aus denselben Daten: der Block zeigt, was eingestellt ist,
     * der Mitteilungsblock in der Regel weniger. Zweimal zu rechnen ist
     * billiger als zweimal zu laden — und es waere die einzige Alternative.
     */
    const publish = (): void => {
      const now = new Date();
      const shown = windowFor(ctx.config.days, now);
      const all = instancesFor(shown.from, shown.to);

      ctx.setState({
        events: selectEvents(all, ctx.config.maxEvents, shown.to),
        fetchedAt: documents.size > 0 ? new Date().toISOString() : null,
        failing: [...failing],
      });

      if (!ctx.config.notify) {
        ctx.notify([]);
        return;
      }
      const reported = windowFor(Math.min(ctx.config.notifyDays, ctx.config.days), now);
      ctx.notify(
        eventNotifications(
          selectEvents(all, ctx.config.notifyCount, reported.to),
          now,
          ctx.timezone,
          ctx.locale,
        ),
      );
    };

    const load = async (): Promise<void> => {
      const sources = parseSources(ctx.config.calendars);
      if (sources.length === 0) {
        documents.clear();
        failing.clear();
        publish();
        return;
      }

      for (const source of sources) {
        const label = source.name || source.url;
        try {
          const response = await ctx.fetch(source.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          if (text.length > MAX_BYTES) throw new Error('Antwort zu gross');
          if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Kein Kalender');
          documents.set(source.url, text);
          failing.delete(label);
        } catch (error) {
          // Eine kaputte Quelle nimmt die anderen nicht mit, und der letzte
          // bekannte Stand bleibt stehen: ein Termin von vorhin ist besser als
          // ein leerer Block.
          failing.add(label);
          ctx.log.warn(`Kalender "${label}" nicht erreichbar: ${String(error)}`);
        }
      }

      // Quellen, die aus der Konfiguration verschwunden sind, raeumen wir mit
      // aus – sonst zeigte der Block Termine aus einem abbestellten Kalender.
      const urls = new Set(sources.map((source) => source.url));
      for (const url of [...documents.keys()]) if (!urls.has(url)) documents.delete(url);

      if (failing.size === sources.length) {
        ctx.setError(`Keine Kalenderquelle erreichbar (${[...failing].join(', ')})`);
      } else {
        ctx.setError(null);
      }
      publish();
    };

    ctx.every(Math.max(5, ctx.config.refreshMinutes) * 60_000, load);
    ctx.every(RESELECT_MS, publish);

    ctx.onCommand('refresh', async () => {
      ctx.log.info('Aktualisierung per Fernbedienung angefordert.');
      await load();
    });
  },
});
