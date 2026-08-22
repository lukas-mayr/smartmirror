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

/* --------------------------------- Akzent --------------------------------- */

/** Kuehl und warm, zwischen denen der Ton wandert. */
const COLD = { red: 0x6f, green: 0x9a, blue: 0xd6 } as const;
const WARM = { red: 0xd9, green: 0x9a, blue: 0x4e } as const;

/** Ohne brauchbare Temperatur bleibt es beim neutralen Grau der Anzeige. */
const NEUTRAL = '#9a9aa3';

/**
 * Farbton aus der Temperatur.
 *
 * Der Spotify-Block zieht seinen Akzent aus dem Cover – dadurch wirkt die
 * Farbe dort nie dekorativ, sondern wie eine Eigenschaft dessen, was gerade zu
 * sehen ist. Damit das Wetter in derselben Handschrift sprechen kann, ohne
 * bunt zu werden, braucht es ebenfalls eine Quelle statt eines Lieblingstons.
 * Hier ist es die Temperatur: ein Verlauf von kuehlem Blau nach warmem
 * Bernstein ueber die Spanne, in der sich Wetter fuer einen Menschen
 * spuerbar aendert.
 *
 * Beide Endpunkte sind gedaempft. Hinter halbdurchlaessigem Glas frisst die
 * Folie Saettigung: ein kraeftiges Blau kaeme als Grau an, ein kraeftiges Rot
 * als Braun. Was hier steht, ist bereits der Ton *nach* der Scheibe.
 */
export function accentForTemperature(celsius: number): string {
  if (!Number.isFinite(celsius)) return NEUTRAL;
  const position = Math.min(1, Math.max(0, (celsius + 5) / 33));
  const channel = (from: number, to: number): string =>
    Math.round(from + (to - from) * position)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(COLD.red, WARM.red)}${channel(COLD.green, WARM.green)}${channel(COLD.blue, WARM.blue)}`;
}

/** Grad Celsius, egal in welcher Einheit die Anzeige gerade rechnet. */
export function toCelsius(value: number, units: WeatherConfig['units']): number {
  return units === 'imperial' ? ((value - 32) * 5) / 9 : value;
}

/* --------------------------------- Karten --------------------------------- */

/**
 * Eine Karte der Durchschaltung: ein Tag, so weit heruntergebrochen, dass die
 * Anzeige ihn nur noch hinstellen muss.
 *
 * Heute und ein Vorhersagetag sind im Block nicht zu unterscheiden – dieselbe
 * Beschriftung, dasselbe Symbol, dieselbe Zahl, derselbe Kurztext. Genau das
 * ist der Sinn: wer vorbeigeht, liest immer an derselben Stelle dasselbe, und
 * nur der Inhalt wechselt. Deshalb entsteht die Form hier und nicht in zwei
 * Zweigen der Anzeige, die mit der Zeit auseinanderlaufen wuerden.
 */
export interface WeatherSlide {
  /** Stabil je Tag – die Anzeige haengt die Einblendung daran. */
  key: string;
  label: string;
  icon: IconName;
  temperature: number;
  /** Kurztext unter der Zahl: Wetterlage und ein zweiter Wert. */
  note: string;
  /** Fuer den Farbton – der rechnet in Celsius, die Anzeige nicht zwingend. */
  celsius: number;
}

/**
 * Der Kalendertag, an dem der Spiegel steht – nicht der des Rechners, der die
 * Anzeige zeichnet. In der Regel dasselbe, aber die Vorhersage kommt in der
 * Zeitzone des Spiegels, und "heute" muss dieselbe Zeitzone meinen wie sie.
 */
export function isoDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Ganze Tage von einem ISO-Tag zum naechsten. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.NaN;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Beschriftung einer Karte.
 *
 * Die naechsten beiden Tage haben Namen, die naeher sind als ihr Wochentag:
 * "Morgen" versteht man ohne nachzurechnen, "Freitag" erst, wenn man weiss,
 * welcher Tag heute ist. Weiter draussen kippt es – dort ist der Wochentag die
 * kuerzere Auskunft, weil "in vier Tagen" niemand mitzaehlt.
 */
export function dayLabel(iso: string, todayIso: string, locale: string, timeZone: string): string {
  switch (daysBetween(todayIso, iso)) {
    case 0:
      return 'Heute';
    case 1:
      return 'Morgen';
    case 2:
      return 'Uebermorgen';
    default:
      // Mittag in UTC: der Tag bleibt damit in jeder Zeitzone derselbe, waehrend
      // Mitternacht je nach Verschiebung schon der Vortag waere.
      return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone }).format(
        new Date(`${iso}T12:00:00Z`),
      );
  }
}

/**
 * Der Stapel, durch den der grosse Block schaltet: heute zuerst, danach die
 * Vorhersage in ihrer Reihenfolge.
 *
 * Ohne aktuellen Wert bleibt der Stapel leer statt mit der Vorhersage zu
 * beginnen – ein Block, der bei "Morgen" anfaengt, sieht aus, als waere heute
 * nichts zu erwarten.
 */
export function buildSlides(
  state: Partial<WeatherState>,
  config: WeatherConfig,
  options: { locale: string; timeZone: string; now?: Date },
): WeatherSlide[] {
  const current = state.current;
  if (!current) return [];

  const today = isoDay(options.now ?? new Date(), options.timeZone);
  const appearance = describeWeather(current.weatherCode, current.isDay);
  const slides: WeatherSlide[] = [
    {
      key: today,
      label: 'Heute',
      icon: appearance.icon,
      temperature: current.temperature,
      note: config.showWind
        ? `${appearance.label} · ${current.windSpeed} ${state.windUnit ?? 'km/h'}`
        : appearance.label,
      celsius: toCelsius(current.temperature, config.units),
    },
  ];

  for (const day of state.forecast ?? []) {
    const look = describeWeather(day.weatherCode);
    slides.push({
      key: day.date,
      label: dayLabel(day.date, today, options.locale, options.timeZone),
      icon: look.icon,
      temperature: day.max,
      // Die grosse Zahl ist der Tageshoechstwert; das Tief gehoert dazu, aber
      // nicht in dieselbe Groesse – sonst stuenden zwei Zahlen gleichberechtigt
      // da und man muesste erst herausfinden, welche gemeint ist.
      note: `${look.label} · Tief ${day.min}°`,
      celsius: toCelsius(day.max, config.units),
    });
  }

  return slides;
}
