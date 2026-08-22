import type { IconName } from '@mirror/icons';
import { MOTION } from '@mirror/sdk';

export interface WeatherConfig {
  location: string;
  units: 'metric' | 'imperial';
  forecastDays: number;
  showWind: boolean;
  /** Tagesverlauf als Balkengrafik zeigen (nur im grossen und breiten Block). */
  showHourly: boolean;
  /**
   * Der Block traegt die eine deckende Flaeche der Szene.
   *
   * Eine Einstellung und keine Automatik: das Design-System erlaubt genau eine
   * deckende Flaeche pro Anordnung, und welcher Block sie bekommt, kann nur
   * entscheiden, wer die Anordnung kennt. Ein Modul, das sie sich selbst
   * nimmt, waere nach dem zweiten Modul mit derselben Idee ein Leuchtfeld.
   */
  highlight: boolean;
  /**
   * Wie lange eine Karte steht, in Sekunden.
   *
   * Fehlt der Wert, gilt der Takt des Design-Systems. Aeltere Konfigurationen
   * kennen ihn nicht, und die sollen sich nicht ploetzlich anders bewegen.
   */
  dwellSeconds?: number;
  refreshMinutes: number;
}

/**
 * Die Spanne, in der sich die Standzeit einstellen laesst.
 *
 * Unter zwei Sekunden flimmert die Durchschaltung, ueber sechzig steht sie
 * praktisch – wer so lange einen Tag sehen will, nimmt besser den breiten
 * Block, in dem alle Tage nebeneinander stehen.
 */
export const DWELL_SECONDS = { min: 2, max: 60 } as const;

/**
 * Die Standzeit in Millisekunden.
 *
 * Das Design-System gibt mit MOTION.dwell einen Takt fuer alles vor, was
 * durchschaltet – auch fuer den Mitteilungsfeed. Dass das Wetter davon
 * abweichen darf, ist eine bewusste Ausnahme und kein Versehen: es ist der
 * einzige Block, bei dem man den Takt tatsaechlich spuert, weil man auf eine
 * bestimmte Karte wartet. Ohne eigene Angabe bleibt es beim Systemtakt.
 */
export function dwellMs(seconds: unknown): number {
  /*
   * Nur eine echte Zahl zaehlt. `Number(null)` und `Number('')` sind beide
   * null, und die rutschten sonst als "null Sekunden" in die Spanne statt als
   * "keine Angabe" – aus einer fehlenden Einstellung wuerde der schnellste
   * erlaubte Takt.
   */
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return MOTION.dwell;
  const clamped = Math.min(DWELL_SECONDS.max, Math.max(DWELL_SECONDS.min, seconds));
  return Math.round(clamped * 1000);
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

/**
 * Ein Stuetzpunkt des Tagesverlaufs.
 *
 * Nicht jede Stunde, sondern eine Handvoll ueber den Tag verteilt: sechs
 * Balken auf 480 px sind 70 px breit und tragen eine Beschriftung, die man aus
 * 3 m liest. Vierundzwanzig waeren 18 px breit und damit eine Textur.
 */
export interface HourlyPoint {
  /** "08", "11", … – Stunde in der Zeitzone des Spiegels. */
  hour: string;
  temperature: number;
}

export interface WeatherState {
  resolvedLocation: string;
  current: CurrentWeather | null;
  forecast: ForecastDay[];
  /** Tagesverlauf von heute. Leer, wenn die Einstellung aus ist. */
  hourly: HourlyPoint[];
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

/* ---------------------------------- Form ---------------------------------- */

/**
 * Welche der drei Formen der Block gerade zeigt.
 *
 *  - `badge`  Symbol und Zahl in einer getoenten Box. Der kleinste Block.
 *  - `deck`   Ein Tag nach dem anderen, gross. Der grosse Block.
 *  - `full`   Zahl, Kurztext und darunter Tagesverlauf oder Vorhersage.
 */
export type WeatherForm = 'badge' | 'deck' | 'full';

export interface WeatherPlace {
  size: string;
  /** Die Werte sind zu alt, um sich als aktuell auszugeben. */
  stale: boolean;
  /** Die Abfrage ist fehlgeschlagen. */
  error: boolean;
  /** Nachtabsenkung. */
  night: boolean;
}

/**
 * Die Form haengt an der Blockgroesse – und an sonst nichts.
 *
 * Insbesondere nicht daran, ob der Block im freien Raster liegt oder in einem
 * Band einer Szene. Ein Modul, das je nach Aufhaengung etwas anderes zeigt,
 * ist aus Sicht dessen, der davorsteht, zwei Module: derselbe Name, dieselbe
 * Groesse, zwei Anzeigen. Wo ein Block haengt, ist eine Sache der Anordnung.
 *
 * Damit das aufgeht, muss der Platz zur Groesse passen: der Slot im Kopfband
 * ist deshalb so breit wie ein L-Block (siehe styles.css, `.zone--head`).
 *
 * Der Rest ist die alte Regel: der kleinste Block zeigt eine Zahl, der grosse
 * schaltet durch, alle anderen zeigen die feste Ansicht. Durchgeschaltet wird
 * nur, solange die Tage auch stimmen – eine Durchschaltung veralteter Werte
 * sieht lebendiger aus, als die Daten sind – und nachts gar nicht.
 */
export function weatherForm(place: WeatherPlace): WeatherForm {
  if (place.size === 's') return 'badge';
  if (place.size === 'l' && !place.stale && !place.error && !place.night) return 'deck';
  return 'full';
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

/* ------------------------------ Tagesverlauf ------------------------------ */

/**
 * Wieviele Stuetzpunkte der Tagesverlauf zeigt.
 *
 * Sechs, weil das die Zahl ist, bei der ein Balken auf der Breite eines
 * grossen Blocks noch eine lesbare Beschriftung traegt. Die Auswahl liegt hier
 * und nicht im Backend: was ein Balken sein darf, entscheidet die Breite der
 * Anzeige, nicht die Datenquelle.
 */
export const HOURLY_POINTS = 6;

/**
 * Der Verlauf, auf die Stunden reduziert, die tatsaechlich Balken werden.
 *
 * Gespannt wird gleichmaessig von der aktuellen Stunde bis zum Tagesende: ein
 * Verlauf, der um Mitternacht anfaengt, waere um 18 Uhr zu drei Vierteln
 * Vergangenheit, und Vergangenheit ist auf einem Spiegel kein Wetter, sondern
 * Statistik.
 *
 * Reicht der Rest des Tages nicht mehr fuer sechs Punkte, ruecken die
 * fehlenden nach hinten in die Vergangenheit — lieber der Abend im Rueckblick
 * als zwei Balken um 23 Uhr. Das ist die einzige Stelle, an der ueberhaupt
 * zurueckgeschaut wird.
 */
export function pickHourly(points: readonly HourlyPoint[], nowHour: number): HourlyPoint[] {
  if (points.length <= HOURLY_POINTS) return [...points];

  const upcoming = points.findIndex((point) => Number(point.hour) >= nowHour);
  // Nach hinten so weit zurueck, dass wieder sechs Punkte uebrig bleiben.
  const first = Math.min(
    Math.max(0, upcoming === -1 ? 0 : upcoming),
    points.length - HOURLY_POINTS,
  );
  const last = points.length - 1;

  /*
   * Gleichmaessig ueber die Spanne verteilt und nicht in festen Schritten:
   * eine feste Schrittweite muesste nach oben passen (dann liegen die Punkte
   * am Abend zu dicht) oder nach unten (dann endet der Verlauf am Nachmittag).
   * Ueber die Spanne gerechnet sitzt der erste Punkt immer auf jetzt und der
   * letzte immer auf der letzten Stunde des Tages.
   */
  const picked: HourlyPoint[] = [];
  for (let step = 0; step < HOURLY_POINTS; step += 1) {
    const index = first + Math.round((step * (last - first)) / (HOURLY_POINTS - 1));
    picked.push(points[index] as HourlyPoint);
  }
  return picked;
}

/** Der waermste Punkt des Verlaufs – er traegt im Diagramm den warmen Ton. */
export function peakIndex(points: readonly HourlyPoint[]): number {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  points.forEach((point, index) => {
    if (point.temperature > bestValue) {
      bestValue = point.temperature;
      best = index;
    }
  });
  return best;
}

/**
 * Hoehe eines Balkens in Prozent.
 *
 * Bezogen auf die Spanne des Tages und nicht auf null: zwischen 18 und 21 Grad
 * liegen drei Grad, und ein Diagramm ab null Grad zeigte davon sechs fast
 * gleich hohe Balken. Die Untergrenze von 18 % sorgt dafuer, dass der kaelteste
 * Punkt ein Balken bleibt und kein Strich.
 */
export function barHeight(value: number, min: number, max: number): number {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 100;
  return 18 + ((value - min) / span) * 82;
}
