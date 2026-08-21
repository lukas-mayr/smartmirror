import { DEFAULT_FONT, type FontId } from './fonts.js';
import { DEFAULT_ROTATION, type Rotation } from './rotation.js';
import type { Zone } from './zones.js';

/** Aktuelle Version des Config-Formats. Erhoehen = Migration schreiben. */
export const CONFIG_SCHEMA_VERSION = 2;

export interface ModuleInstance {
  /** Stabil ueber die Lebensdauer der Instanz, z.B. "weather-1". */
  id: string;
  moduleId: string;
  zone: Zone;
  /** Reihenfolge innerhalb der Zone, aufsteigend. */
  order: number;
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
  /** Innenabstand in Prozent – der Spiegelrahmen verdeckt die Raender. */
  paddingPercent: number;
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
  instances: ModuleInstance[];
  display: DisplaySettings;
  power: PowerSettings;
  update: UpdateSettings;
}

export function createDefaultConfig(): MirrorConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceName: 'Spiegel',
    locale: 'de-DE',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Vienna',
    instances: [
      {
        id: 'clock-1',
        moduleId: 'clock',
        zone: 'top-center',
        order: 0,
        enabled: true,
        config: {},
      },
      {
        id: 'weather-1',
        moduleId: 'weather',
        zone: 'top-right',
        order: 0,
        enabled: true,
        config: {},
      },
    ],
    display: {
      brightness: 100,
      rotation: DEFAULT_ROTATION,
      fontFamily: DEFAULT_FONT,
      burnInProtection: true,
      paddingPercent: 4,
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
  };
}
