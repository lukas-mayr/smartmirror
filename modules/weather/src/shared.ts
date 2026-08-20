import type { IconName } from '@mirror/icons';

export interface WeatherConfig {
  location: string;
  units: 'metric' | 'imperial';
  forecastDays: number;
  showWind: boolean;
  refreshMinutes: number;
}

export interface CurrentWeather {
  temperature: number;
  apparentTemperature: number;
  weatherCode: number;
  windSpeed: number;
  isDay: boolean;
}

export interface ForecastDay {
  date: string;
  min: number;
  max: number;
  weatherCode: number;
}

export interface WeatherState {
  resolvedLocation: string;
  current: CurrentWeather | null;
  forecast: ForecastDay[];
  temperatureUnit: string;
  windUnit: string;
  /** Zeitpunkt der letzten erfolgreichen Abfrage – die Anzeige braucht ihn,
   *  um veraltete Werte als solche kenntlich zu machen. */
  fetchedAt: string | null;
}

/**
 * WMO-Wettercodes, wie Open-Meteo sie liefert, abgebildet auf flache
 * Strichsymbole. Referenz: https://open-meteo.com/en/docs
 *
 * `night` ist nur dort gesetzt, wo sich Tag und Nacht sinnvoll unterscheiden –
 * Regen sieht nachts nicht anders aus, ein klarer Himmel schon.
 */
export interface WeatherAppearance {
  label: string;
  icon: IconName;
  night?: IconName;
}

export const WEATHER_CODES: Record<number, WeatherAppearance> = {
  0: { label: 'Klar', icon: 'sun', night: 'moon' },
  1: { label: 'Ueberwiegend klar', icon: 'sun', night: 'moon' },
  2: { label: 'Teilweise bewoelkt', icon: 'cloud-sun', night: 'cloud-moon' },
  3: { label: 'Bedeckt', icon: 'cloudy' },
  45: { label: 'Nebel', icon: 'cloud-fog' },
  48: { label: 'Reifnebel', icon: 'cloud-fog' },
  51: { label: 'Leichter Niesel', icon: 'cloud-drizzle' },
  53: { label: 'Niesel', icon: 'cloud-drizzle' },
  55: { label: 'Starker Niesel', icon: 'cloud-drizzle' },
  56: { label: 'Gefrierender Niesel', icon: 'cloud-hail' },
  57: { label: 'Gefrierender Niesel', icon: 'cloud-hail' },
  61: { label: 'Leichter Regen', icon: 'cloud-rain' },
  63: { label: 'Regen', icon: 'cloud-rain' },
  65: { label: 'Starker Regen', icon: 'cloud-rain' },
  66: { label: 'Gefrierender Regen', icon: 'cloud-hail' },
  67: { label: 'Gefrierender Regen', icon: 'cloud-hail' },
  71: { label: 'Leichter Schneefall', icon: 'cloud-snow' },
  73: { label: 'Schneefall', icon: 'cloud-snow' },
  75: { label: 'Starker Schneefall', icon: 'cloud-snow' },
  77: { label: 'Schneegriesel', icon: 'snowflake' },
  80: { label: 'Schauer', icon: 'cloud-rain' },
  81: { label: 'Schauer', icon: 'cloud-rain' },
  82: { label: 'Kraeftige Schauer', icon: 'cloud-rain' },
  85: { label: 'Schneeschauer', icon: 'cloud-snow' },
  86: { label: 'Schneeschauer', icon: 'cloud-snow' },
  95: { label: 'Gewitter', icon: 'cloud-lightning' },
  96: { label: 'Gewitter mit Hagel', icon: 'cloud-lightning' },
  99: { label: 'Gewitter mit Hagel', icon: 'cloud-lightning' },
};

export function describeWeather(code: number, isDay = true): { label: string; icon: IconName } {
  const entry = WEATHER_CODES[code];
  // Unbekannter Code heisst nicht "kein Wetter": lieber eine neutrale Wolke
  // als eine Luecke im Layout.
  if (!entry) return { label: 'Unbekannt', icon: 'cloud' };
  return { label: entry.label, icon: !isDay && entry.night ? entry.night : entry.icon };
}
