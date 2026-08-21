import { DEFAULT_FONT, type FontId } from './fonts.js';
import { createDefaultInsets, type ScreenInsets } from './insets.js';
import { DEFAULT_GRID, type GridSize, type WidgetSize } from './layout.js';
import { DEFAULT_ROTATION, type Rotation } from './rotation.js';
import { createScreen, type MirrorScreen } from './screens.js';
import { createDefaultSetup, type SetupState } from './setup.js';

/** Aktuelle Version des Config-Formats. Erhoehen = Migration schreiben. */
export const CONFIG_SCHEMA_VERSION = 4;

export interface ModuleInstance {
  /** Stabil ueber die Lebensdauer der Instanz, z.B. "weather-1". */
  id: string;
  moduleId: string;
  /** Auf welchem Screen der Block liegt. */
  screenId: string;
  /** Nullbasierte Rasterkoordinaten der linken oberen Ecke. */
  x: number;
  y: number;
  size: WidgetSize;
  enabled: boolean;
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

export interface DisplaySettings {
  /** 0..100. Wird per ddcutil gesetzt, sonst per CSS-Overlay abgedunkelt. */
  brightness: number;
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
        size: 'l',
        enabled: true,
        config: {},
      },
      {
        id: 'weather-1',
        moduleId: 'weather',
        screenId: 'screen-1',
        x: 4,
        y: 0,
        size: 'l',
        enabled: true,
        config: {},
      },
    ],
    display: {
      brightness: 100,
      rotation: DEFAULT_ROTATION,
      fontFamily: DEFAULT_FONT,
      burnInProtection: true,
      grid: { ...DEFAULT_GRID },
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
