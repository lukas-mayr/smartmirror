import { defineBackend } from '@mirror/sdk';
import {
  boardStopName,
  departureNotifications,
  parseBoard,
  selectDepartures,
  type Departure,
  type SbbConfig,
  type SbbState,
} from './shared.js';

/**
 * Wie oft die Auswahl neu getroffen wird, ohne neu zu laden.
 *
 * Der Countdown laeuft weiter, auch wenn die Auskunft nichts Neues weiss:
 * aus "in 7 min" wird eine Minute spaeter "in 6 min", und irgendwann ist die
 * Abfahrt keine mehr. Dafuer noch einmal zu fragen waere Netzlast ohne
 * Erkenntnis.
 */
const RESELECT_MS = 20_000;

/**
 * Die Zeitzone, in der die Auskunft ihre Zeiten meint.
 *
 * Fest und nicht aus der Konfiguration des Spiegels: der schweizerische
 * Fahrplan gilt in schweizerischer Zeit, auch wenn der Spiegel in einer
 * anderen Zone haengt. Waere es die Zone des Spiegels, zeigte ein Spiegel in
 * London die Abfahrten eine Stunde zu frueh.
 */
const TIMETABLE_ZONE = 'Europe/Zurich';

export default defineBackend<SbbConfig, SbbState>({
  async setup(ctx) {
    let departures: Departure[] = [];
    let stopName = ctx.config.stop;

    const publish = (): void => {
      const now = new Date();
      const shown = selectDepartures(
        departures,
        now,
        ctx.config.walkMinutes,
        ctx.config.lines,
        ctx.config.limit,
      );

      ctx.setState({
        stop: stopName,
        departures: shown,
        fetchedAt: departures.length > 0 ? new Date().toISOString() : null,
      });

      if (!ctx.config.notify) {
        ctx.notify([]);
        return;
      }
      ctx.notify(
        departureNotifications(
          shown.slice(0, Math.max(1, ctx.config.notifyCount)),
          now,
          ctx.locale,
          TIMETABLE_ZONE,
        ),
      );
    };

    const load = async (): Promise<void> => {
      const stop = ctx.config.stop.trim();
      if (stop.length === 0) {
        departures = [];
        publish();
        return;
      }

      const url = new URL('https://timetable.search.ch/api/stationboard.json');
      url.searchParams.set('stop', stop);
      // Etwas mehr holen als angezeigt wird: der Fussweg und der Linienfilter
      // sortieren aus, und eine Tafel, die deswegen halb leer bleibt, waere
      // ein Abruf fuer nichts.
      url.searchParams.set('limit', String(Math.min(40, Math.max(4, ctx.config.limit * 3))));
      url.searchParams.set('show_delays', '1');
      url.searchParams.set('mode', 'depart');

      const response = await ctx.fetch(url.toString());
      if (!response.ok) throw new Error(`Fahrplan nicht abrufbar (HTTP ${response.status})`);
      const body: unknown = await response.json();

      departures = parseBoard(body, TIMETABLE_ZONE);
      stopName = boardStopName(body, stop);
      if (departures.length === 0) ctx.log.warn(`Keine Abfahrten fuer "${stop}".`);
      publish();
    };

    // Faellt eine Abfrage aus, wirft sie – der Host haelt den letzten Stand und
    // markiert die Instanz. Eine Abfahrtstafel von vor zwei Minuten ist noch
    // brauchbar, eine leere nicht.
    ctx.every(Math.max(30, ctx.config.refreshSeconds) * 1000, load);
    ctx.every(RESELECT_MS, publish);

    ctx.onCommand('refresh', async () => {
      ctx.log.info('Aktualisierung per Fernbedienung angefordert.');
      await load();
    });
  },
});
