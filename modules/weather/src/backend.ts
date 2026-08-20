import { defineBackend } from '@mirror/sdk';
import type { ForecastDay, WeatherConfig, WeatherState } from './shared.js';

interface GeocodeResponse {
  results?: { name: string; country_code?: string; admin1?: string; latitude: number; longitude: number }[];
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
  current_units: { temperature_2m: string; wind_speed_10m: string };
}

export default defineBackend<WeatherConfig, WeatherState>({
  async setup(ctx) {
    const metric = ctx.config.units === 'metric';
    let coordinates: { latitude: number; longitude: number; label: string } | null = null;

    const geocode = async (): Promise<typeof coordinates> => {
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
      return { latitude: hit.latitude, longitude: hit.longitude, label };
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

      const response = await ctx.fetch(url.toString());
      if (!response.ok) throw new Error(`Wetterabfrage fehlgeschlagen (HTTP ${response.status})`);
      const body = (await response.json()) as ForecastResponse;

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
        temperatureUnit: body.current_units.temperature_2m,
        windUnit: body.current_units.wind_speed_10m,
        fetchedAt: new Date().toISOString(),
      });
      ctx.log.debug(`Wetter fuer ${coordinates.label} aktualisiert.`);
    };

    // Faellt eine Abfrage aus, wirft sie – der Modul-Host haelt den letzten
    // Stand und markiert die Instanz als fehlerhaft. Genau so soll es sein:
    // ein veralteter Wert mit Hinweis ist besser als ein leerer Spiegel.
    ctx.every(ctx.config.refreshMinutes * 60_000, refresh);

    ctx.onCommand('refresh', async () => {
      ctx.log.info('Aktualisierung per Fernbedienung angefordert.');
      await refresh();
    });
  },
});
