import { defineBackend } from '@mirror/sdk';
import type { ForecastDay, HourlyPoint, WeatherConfig, WeatherState } from './shared.js';
import { meteoAlarmUrl, parseWarnings, selectWarnings, warningNotifications } from './warnings.js';

/**
 * Wie oft nach Warnungen gesehen wird.
 *
 * Ein eigener Takt und nicht der des Wetters: die Aktualisierung des Wetters
 * darf jemand auf drei Stunden stellen, eine Sturmwarnung drei Stunden spaeter
 * zu zeigen waere aber der Sinn der Sache verfehlt. Umgekehrt aendern sich
 * Warnungen selten genug, dass zehn Minuten reichen.
 */
const WARNING_INTERVAL_MS = 10 * 60_000;

interface GeocodeResponse {
  results?: { name: string; country_code?: string; admin1?: string; latitude: number; longitude: number }[];
}

/** Koordinaten samt Land – das Land waehlt den Warnfeed. */
interface Place {
  latitude: number;
  longitude: number;
  label: string;
  country: string;
}

interface ForecastResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
    is_day: number;
  };
  daily?: {
    time: string[];
    temperature_2m_min: number[];
    temperature_2m_max: number[];
    weather_code: number[];
  };
  hourly?: {
    time: string[];
    temperature_2m: number[];
  };
  current_units: { temperature_2m: string; wind_speed_10m: string };
}

export default defineBackend<WeatherConfig, WeatherState>({
  async setup(ctx) {
    const metric = ctx.config.units === 'metric';
    let coordinates: Place | null = null;

    const geocode = async (): Promise<Place> => {
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.searchParams.set('name', ctx.config.location);
      url.searchParams.set('count', '1');
      url.searchParams.set('language', ctx.locale.split('-')[0] ?? 'de');
      const response = await ctx.fetch(url.toString());
      if (!response.ok) throw new Error(`Ortssuche fehlgeschlagen (HTTP ${response.status})`);
      const body = (await response.json()) as GeocodeResponse;
      const hit = body.results?.[0];
      if (!hit) throw new Error(`Ort "${ctx.config.location}" nicht gefunden`);
      // Bei Stadtstaaten liefert der Geocoder die Region gleich noch einmal
      // ("Wien, Bundesland Wien, AT"). Doppelungen fliegen raus.
      const parts = [hit.name, hit.admin1, hit.country_code].filter(Boolean) as string[];
      const label = parts
        .filter((part, index) => !parts.some((other, otherIndex) => otherIndex < index && other.includes(part)))
        .filter((part, index) => index === 0 || !part.includes(parts[0] as string))
        .join(', ');
      return {
        latitude: hit.latitude,
        longitude: hit.longitude,
        label,
        // Das Land kommt aus derselben Antwort und waehlt den Warnfeed. So
        // passt die Warnung immer zum eingestellten Ort, ohne dass jemand ein
        // zweites Feld pflegen muss.
        country: hit.country_code ?? '',
      };
    };

    const refresh = async (): Promise<void> => {
      // Koordinaten einmal aufloesen und behalten: der Ort aendert sich nur
      // ueber die Konfiguration, und die startet die Instanz ohnehin neu.
      coordinates ??= await geocode();
      if (!coordinates) return;

      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', String(coordinates.latitude));
      url.searchParams.set('longitude', String(coordinates.longitude));
      url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day');
      url.searchParams.set('timezone', ctx.timezone);
      if (!metric) {
        url.searchParams.set('temperature_unit', 'fahrenheit');
        url.searchParams.set('wind_speed_unit', 'mph');
      }
      if (ctx.config.forecastDays > 0) {
        url.searchParams.set('daily', 'temperature_2m_min,temperature_2m_max,weather_code');
        // Open-Meteo zaehlt den heutigen Tag mit; wir wollen die naechsten N.
        url.searchParams.set('forecast_days', String(Math.min(ctx.config.forecastDays + 1, 16)));
      }
      // Der Tagesverlauf nur, wenn er auch gezeigt wird: er verdoppelt die
      // Antwort, und der Spiegel fragt alle 15 Minuten.
      if (ctx.config.showHourly) url.searchParams.set('hourly', 'temperature_2m');

      const response = await ctx.fetch(url.toString());
      if (!response.ok) throw new Error(`Wetterabfrage fehlgeschlagen (HTTP ${response.status})`);
      const body = (await response.json()) as ForecastResponse;

      /**
       * Nur der heutige Tag.
       *
       * Open-Meteo liefert die Stunden aller angefragten Tage am Stueck;
       * "Tagesverlauf" meint aber den Verlauf von heute. Verglichen wird ueber
       * das Datum im Zeitstempel, weil die Antwort schon in der Zeitzone des
       * Spiegels kommt – die erste Stunde ist also dessen Mitternacht.
       */
      const hourly: HourlyPoint[] = [];
      if (body.hourly) {
        const today = (body.hourly.time[0] ?? '').slice(0, 10);
        body.hourly.time.forEach((stamp, index) => {
          if (!stamp.startsWith(today)) return;
          const value = body.hourly?.temperature_2m[index];
          if (typeof value !== 'number') return;
          hourly.push({ hour: stamp.slice(11, 13), temperature: Math.round(value) });
        });
      }

      const forecast: ForecastDay[] = [];
      if (body.daily) {
        for (let index = 1; index < body.daily.time.length; index += 1) {
          if (forecast.length >= ctx.config.forecastDays) break;
          forecast.push({
            date: body.daily.time[index] as string,
            min: Math.round(body.daily.temperature_2m_min[index] as number),
            max: Math.round(body.daily.temperature_2m_max[index] as number),
            weatherCode: body.daily.weather_code[index] as number,
          });
        }
      }

      ctx.setState({
        resolvedLocation: coordinates.label,
        current: {
          temperature: Math.round(body.current.temperature_2m),
          apparentTemperature: Math.round(body.current.apparent_temperature),
          weatherCode: body.current.weather_code,
          windSpeed: Math.round(body.current.wind_speed_10m),
          isDay: body.current.is_day === 1,
        },
        forecast,
        hourly,
        temperatureUnit: body.current_units.temperature_2m,
        windUnit: body.current_units.wind_speed_10m,
        fetchedAt: new Date().toISOString(),
      });
      ctx.log.debug(`Wetter fuer ${coordinates.label} aktualisiert.`);
    };

    /**
     * Zeitpunkt einer Warnung, wie er in der Zweitzeile steht.
     *
     * Nur die Uhrzeit, solange es heute ist, sonst mit Wochentag davor: "ab
     * 14:00" liest man ohne Nachdenken, "ab 22.08. 14:00" nicht.
     */
    const formatWarningTime = (stamp: string): string => {
      const date = new Date(stamp);
      const today = new Date().toLocaleDateString(ctx.locale, { timeZone: ctx.timezone });
      const sameDay = date.toLocaleDateString(ctx.locale, { timeZone: ctx.timezone }) === today;
      return date.toLocaleTimeString(ctx.locale, {
        timeZone: ctx.timezone,
        hour: '2-digit',
        minute: '2-digit',
        ...(sameDay ? {} : { weekday: 'short' }),
      });
    };

    /**
     * Warnungen holen, zeigen und melden.
     *
     * Faengt seine Fehler selbst: eine Warnquelle, die den ganzen Block rot
     * faerbt, waere das falsche Ergebnis – die Temperatur stimmt ja weiterhin.
     * Was hier schiefgeht, steht im Log und sonst nirgends.
     */
    const refreshWarnings = async (): Promise<void> => {
      if (!ctx.config.warnings) {
        ctx.setState({ warnings: [] });
        if (ctx.config.warningsNotify) ctx.notify([]);
        return;
      }

      try {
        coordinates ??= await geocode();
        const url = meteoAlarmUrl(coordinates.country);
        if (!url) {
          // Lieber keine Warnungen als die eines anderen Landes.
          ctx.log.warn(`Fuer "${coordinates.country}" gibt es keinen bekannten Warnfeed.`);
          ctx.setState({ warnings: [] });
          if (ctx.config.warningsNotify) ctx.notify([]);
          return;
        }

        const response = await ctx.fetch(url);
        if (!response.ok) throw new Error(`Warnungen nicht abrufbar (HTTP ${response.status})`);
        const payload = (await response.json()) as { warnings?: unknown };
        // Die Koordinaten kommen mit: MeteoAlarm warnt fuer ein ganzes Land,
        // und ohne den Ort daneben stuende die Lawinenwarnung fuer Tirol auf
        // einem Spiegel in Wien.
        const warnings = selectWarnings(
          parseWarnings(payload, {
            language: ctx.locale.split('-')[0] ?? 'de',
            place: { latitude: coordinates.latitude, longitude: coordinates.longitude },
          }),
          ctx.config.warningRegion,
        );

        ctx.setState({ warnings });
        // Der Schalter entscheidet nur ueber den Feed. Im eigenen Block steht
        // die Warnung immer – wer sie abbestellen will, schaltet sie ganz ab.
        if (ctx.config.warningsNotify) {
          ctx.notify(warningNotifications(warnings, formatWarningTime));
        }
        /*
         * Gezaehlt wird beides: was ankam und was uebrig blieb.
         *
         * "0 Warnungen" ist die eine Auskunft, die auch dann richtig aussieht,
         * wenn das Lesen kaputt ist – genau daran ist die Vorgaengerfassung
         * lange unbemerkt vorbeigelaufen. Steht daneben, wieviel die Quelle
         * geschickt hat, ist der Unterschied zwischen "ruhiges Wetter" und
         * "wir verstehen die Antwort nicht mehr" eine Zeile im Log.
         */
        const delivered = Array.isArray(payload.warnings) ? payload.warnings.length : 0;
        ctx.log.debug(`${warnings.length} von ${delivered} Meldung(en) fuer ${coordinates.label} uebrig.`);
      } catch (error) {
        ctx.log.warn(`Warnungen konnten nicht geholt werden: ${String(error)}`);
      }
    };

    // Faellt eine Abfrage aus, wirft sie – der Modul-Host haelt den letzten
    // Stand und markiert die Instanz als fehlerhaft. Genau so soll es sein:
    // ein veralteter Wert mit Hinweis ist besser als ein leerer Spiegel.
    ctx.every(ctx.config.refreshMinutes * 60_000, refresh);
    ctx.every(WARNING_INTERVAL_MS, refreshWarnings);

    ctx.onCommand('refresh', async () => {
      ctx.log.info('Aktualisierung per Fernbedienung angefordert.');
      await refresh();
      await refreshWarnings();
    });
  },
});
