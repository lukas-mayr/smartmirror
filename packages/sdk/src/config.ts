import type { Zone } from './design.js';
import { DEFAULT_FONT, type FontId } from './fonts.js';
import { createDefaultInsets, type ScreenInsets } from './insets.js';
import { defaultGridForRotation, type GridSize, type WidgetSize } from './layout.js';
import { DEFAULT_ROTATION, type Rotation } from './rotation.js';
import { createScreen, type MirrorScreen } from './screens.js';
import { createDefaultSetup, type SetupState } from './setup.js';

/** Aktuelle Version des Config-Formats. Erhoehen = Migration schreiben. */
export const CONFIG_SCHEMA_VERSION = 6;

export interface ModuleInstance {
  /** Stabil ueber die Lebensdauer der Instanz, z.B. "weather-1". */
  id: string;
  moduleId: string;
  /** Auf welchem Screen der Block liegt. */
  screenId: string;
  /** Nullbasierte Rasterkoordinaten der linken oberen Ecke. */
  x: number;
  y: number;
  /**
   * In welchem Band der Block liegt, wenn sein Screen als Szene angeordnet ist.
   *
   * Steht neben `x`/`y` und nicht statt ihnen: ein Screen laesst sich zwischen
   * Raster und Szene umschalten, und beim Zurueckschalten soll der Block
   * wieder dort liegen, wo er lag. Welcher der beiden Werte gilt, entscheidet
   * `MirrorScreen.layout`.
   */
  zone: Zone;
  size: WidgetSize;
  enabled: boolean;
  /**
   * Belegt der Block einen Platz auf dem Screen?
   *
   * Getrennt von `enabled`, weil es zwei verschiedene Fragen sind: ob die
   * Instanz laeuft und ob man sie sieht. Ein Kalender, der nur Mitteilungen
   * liefern soll, muss laufen — aber er soll keinen Block belegen, und in
   * einem vollen Raster ist ohnehin keiner mehr frei.
   *
   * Ein eigener Schalter und nicht "kein Screen" oder "keine Koordinaten":
   * Platz, Groesse und Band bleiben stehen, damit ein Block beim
   * Wiedereinblenden dorthin zurueckkehrt, wo er lag. Dieselbe Ueberlegung wie
   * bei `zone` neben `x`/`y`.
   */
  visible: boolean;
  /**
   * Darf dieser Block den Spiegel anhalten?
   *
   * Wenn ja, bleibt der Spiegel stehen, solange der Block danach fragt (siehe
   * hold.ts): kein Screenwechsel, im Fussband kein Weiterschalten. Gefragt
   * wird nur von Modulen, bei denen etwas laeuft und zu Ende geht — der Timer
   * ist der Fall, fuer den es das gibt.
   *
   * Voreingestellt aus, und zwar ohne Ausnahme. Ein Block, der die Anzeige
   * uebernimmt, ist genau dann richtig, wenn jemand das so wollte; wer es nie
   * eingeschaltet hat, hat es nicht gewollt.
   */
  priority: boolean;
  config: Record<string, unknown>;
}

/** Ein Schaltfenster. `days` nach JS-Konvention: 0 = Sonntag. */
export interface PowerRule {
  id: string;
  days: readonly number[];
  /** "HH:MM" – ab hier ist das Display an. */
  on: string;
  /** "HH:MM" – ab hier ist es aus. */
  off: string;
}

export interface PowerSettings {
  /** Zeitplan aktiv? Wenn false, bleibt das Display dauerhaft an. */
  scheduleEnabled: boolean;
  rules: readonly PowerRule[];
  /**
   * Manuelle Uebersteuerung per Handy. Sie gilt bis zum naechsten
   * Zeitplan-Wechsel – sonst muesste man sie von Hand zuruecknehmen.
   */
  manualOverride: { active: boolean; on: boolean } | null;
}

/**
 * Nachtabsenkung.
 *
 * Nicht dasselbe wie der Zeitplan aus `power`: der schaltet den Bildschirm
 * ganz ab. Hier bleibt der Spiegel an, nimmt aber eine Stufe zurueck – keine
 * deckende Flaeche, kein Akzent, kein Weiterschalten, alle Werte auf Grau.
 *
 * Der Grund steht in der Szene "Nacht": wer um drei Uhr aufsteht, soll eine
 * Uhrzeit lesen koennen und nicht geblendet werden. Und eine Animation, die im
 * dunklen Zimmer im Augenwinkel laeuft, weckt zuverlaessig auf.
 */
export interface NightModeSettings {
  enabled: boolean;
  /** "HH:MM" – ab hier ist die Absenkung aktiv. */
  from: string;
  /** "HH:MM" – ab hier wieder nicht. Ueber Mitternacht hinweg erlaubt. */
  to: string;
}

export const DEFAULT_NIGHT_MODE: NightModeSettings = { enabled: true, from: '22:30', to: '06:00' };

/** "HH:MM" in Minuten seit Mitternacht, oder `null` bei Unsinn. */
function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function normalizeClock(value: unknown, fallback: string): string {
  const minutes = parseClock(value);
  if (minutes === null) return fallback;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function normalizeNightMode(value: unknown): NightModeSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<NightModeSettings>;
  return {
    enabled: source.enabled === undefined ? DEFAULT_NIGHT_MODE.enabled : source.enabled !== false,
    from: normalizeClock(source.from, DEFAULT_NIGHT_MODE.from),
    to: normalizeClock(source.to, DEFAULT_NIGHT_MODE.to),
  };
}

/**
 * Laeuft die Nachtabsenkung gerade?
 *
 * Das Fenster darf ueber Mitternacht gehen – das ist sogar der Normalfall
 * (22:30 bis 06:00). Sind beide Zeiten gleich, ist das Fenster leer und nicht
 * etwa 24 Stunden lang: "von 6 bis 6" heisst nicht "immer".
 */
export function isNightNow(settings: NightModeSettings, now: Date = new Date()): boolean {
  if (!settings.enabled) return false;
  const from = parseClock(settings.from);
  const to = parseClock(settings.to);
  if (from === null || to === null || from === to) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return to < from ? minutes >= from || minutes < to : minutes >= from && minutes < to;
}

/**
 * Laeuft die Nachtabsenkung gerade – nach der Uhr des Spiegels?
 *
 * `isNightNow` rechnet mit der Ortszeit dessen, der fragt. Auf dem Spiegel ist
 * das richtig; in der Handy-App nicht zwingend, denn wer aus einer anderen
 * Zeitzone auf seinen Spiegel schaut, bekaeme sonst eine Auskunft ueber sein
 * eigenes Fenster statt ueber das, was zu Hause an der Wand passiert.
 *
 * Gerechnet wird nur mit Stunde und Minute: die Absenkung kennt keine Tage,
 * und ein Datum ueber Zeitzonen hinweg zu schieben waere eine Fehlerquelle
 * ohne Gegenwert.
 */
export function isNightIn(
  settings: NightModeSettings,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  let wall: string;
  try {
    wall = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    // Eine unbekannte Zeitzone ist kein Grund, gar nichts zu sagen.
    return isNightNow(settings, now);
  }
  const minutes = parseClock(wall);
  if (minutes === null) return isNightNow(settings, now);
  const atMirror = new Date(now);
  atMirror.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return isNightNow(settings, atMirror);
}

export interface DisplaySettings {
  /** 0..100. Wird per ddcutil gesetzt, sonst per CSS-Overlay abgedunkelt. */
  brightness: number;
  /** Absenkung in den Nachtstunden. */
  nightMode: NightModeSettings;
  /**
   * Drehung des Inhalts im Uhrzeigersinn – fuer hochkant aufgehaengte Spiegel.
   *
   * Sie steht bewusst in der Konfiguration und nicht nur in der Handy-App:
   * gekoppelt wird ueber einen Code, der auf dem Spiegel erscheint. Steht der
   * quer auf einem hochkanten Bildschirm, ist er kaum zu lesen – die Drehung
   * muss also schon vor der ersten Kopplung stimmen. Der Installer setzt sie
   * dafuer mit `--rotate`.
   */
  rotation: Rotation;
  /**
   * Mitgelieferte Schriftfamilie. Alle Kandidaten sind runde, freundliche
   * Schnitte unter der SIL Open Font License und werden lokal ausgeliefert –
   * der Spiegel laedt nie eine Schrift aus dem Netz nach.
   */
  fontFamily: FontId;
  /** Layout alle paar Minuten um wenige Pixel verschieben. */
  burnInProtection: boolean;
  /**
   * Raster, in dem die Bloecke liegen – fuer alle Screens dasselbe.
   *
   * Global und nicht je Screen: das Raster beschreibt die Flaeche an der Wand,
   * nicht deren Inhalt. Zwei Screens mit unterschiedlichem Raster wuerden beim
   * Weiterschalten sichtbar springen, und ein Block liesse sich nicht mehr von
   * einem Screen auf den anderen schieben, ohne die Groesse zu wechseln.
   */
  grid: GridSize;
  /**
   * Rand der bespielbaren Flaeche je Seite, in Prozent.
   *
   * Vier Werte und nicht einer, weil der Bildschirm hinter dem Spiegel selten
   * mittig im Rahmen sitzt – Begruendung in insets.ts. Eingestellt wird das im
   * zweiten Schritt der Einrichtung, an einem Rahmen, den der Spiegel dabei
   * anzeigt.
   */
  insets: ScreenInsets;
}

export type UpdateChannel = 'stable' | 'beta';

export interface UpdateSettings {
  /** "owner/repo" auf GitHub. */
  repository: string;
  channel: UpdateChannel;
  autoUpdate: boolean;
  checkIntervalMinutes: number;
}

export interface MirrorConfig {
  schemaVersion: number;
  deviceName: string;
  locale: string;
  timezone: string;
  /**
   * Anordnungen, die der Spiegel der Reihe nach zeigt. Immer mindestens eine.
   * Die Reihenfolge in der Liste ist die Reihenfolge beim Weiterschalten.
   */
  screens: MirrorScreen[];
  instances: ModuleInstance[];
  display: DisplaySettings;
  power: PowerSettings;
  update: UpdateSettings;
  /**
   * Wie weit die Einrichtung ist. Steht hier und nicht in einer der beiden
   * Oberflaechen, weil Spiegel und Handy denselben Schritt zeigen muessen.
   */
  setup: SetupState;
}

export function createDefaultConfig(): MirrorConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceName: 'Spiegel',
    locale: 'de-DE',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Vienna',
    screens: [createScreen('screen-1', 'Screen 1')],
    instances: [
      {
        id: 'clock-1',
        moduleId: 'clock',
        screenId: 'screen-1',
        x: 2,
        y: 0,
        zone: 'head',
        size: 'l',
        enabled: true,
        visible: true,
        priority: false,
        config: {},
      },
      {
        id: 'weather-1',
        moduleId: 'weather',
        screenId: 'screen-1',
        x: 4,
        y: 0,
        zone: 'main',
        size: 'l',
        enabled: true,
        visible: true,
        priority: false,
        config: {},
      },
    ],
    display: {
      brightness: 100,
      nightMode: { ...DEFAULT_NIGHT_MODE },
      rotation: DEFAULT_ROTATION,
      fontFamily: DEFAULT_FONT,
      burnInProtection: true,
      grid: defaultGridForRotation(DEFAULT_ROTATION),
      insets: createDefaultInsets(),
    },
    power: {
      scheduleEnabled: false,
      rules: [
        { id: 'werktags', days: [1, 2, 3, 4, 5], on: '06:00', off: '23:00' },
        { id: 'wochenende', days: [0, 6], on: '08:00', off: '23:30' },
      ],
      manualOverride: null,
    },
    update: {
      repository: '',
      channel: 'stable',
      autoUpdate: true,
      checkIntervalMinutes: 15,
    },
    setup: createDefaultSetup(),
  };
}
