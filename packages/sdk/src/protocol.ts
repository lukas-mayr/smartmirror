import type { MirrorConfig } from './config.js';
import type { Zone } from './design.js';
import type { WidgetSize } from './layout.js';
import type { ModuleDescriptor } from './manifest.js';
import type { MirrorScreen } from './screens.js';

/**
 * Kantenlaengen der bespielbaren Buehne in Pixeln, wie die Anzeige sie sieht.
 *
 * Bereits gedreht: bei 90 oder 270 Grad sind Breite und Hoehe getauscht. Die
 * Handy-App braucht das, um beim Ausrichten neben "2,5 %" auch "≈ 27 px"
 * zeigen zu koennen – Prozent allein sagt niemandem, ob er gerade um eine
 * Haaresbreite oder um zwei Zentimeter verschiebt.
 */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * Aenderung an einem Block. Alles ausser der Id ist optional: die Handy-App
 * schiebt beim Ziehen nur Koordinaten, beim Antippen nur den Schalter – und
 * beides darf sich nicht gegenseitig ueberschreiben.
 */
export interface LayoutPatch {
  id: string;
  screenId?: string;
  x?: number;
  y?: number;
  /** Nur wirksam, wenn der Screen als Szene angeordnet ist. */
  zone?: Zone;
  size?: WidgetSize;
  enabled?: boolean;
}

/** Die PWA ("remote") darf konfigurieren, die Anzeige ("shell") nur lesen. */
export type ClientType = 'shell' | 'remote';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'rolled-back'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  /** 0..1, nur waehrend des Downloads gesetzt. */
  progress?: number;
  lastCheck?: string;
  lastError?: string;
  /** Versionen, die den Healthcheck gerissen haben und uebersprungen werden. */
  blocked: readonly string[];
}

/**
 * Bitte eines Moduls an den Nutzer: ein Schritt, den nur er tun kann.
 *
 * Entstanden an der Anmeldung bei fremden Diensten. Ein Modul kann keinen
 * Browser oeffnen und keine Zustimmung erteilen – es kann nur sagen, was zu
 * tun ist, und wo. Die Handy-App zeigt das im Einstellungsblatt des Blocks.
 */
export interface ModuleAction {
  /** Was zu tun ist, in einem Satz. */
  label: string;
  /** Adresse, die die Handy-App zum Antippen anbietet. */
  url?: string;
}

export interface ModuleStateEnvelope {
  instanceId: string;
  /** Freier Modul-State. Wird flach ueber den bestehenden State gemerged. */
  patch: Record<string, unknown>;
  /** Modul meldet einen Fehlerzustand – die Shell zeigt ihn dezent an. */
  error?: string | null;
  /** Offener Schritt fuer den Nutzer. Nur die Handy-App zeigt ihn. */
  action?: ModuleAction | null;
  /** ISO-Zeitstempel der letzten erfolgreichen Aktualisierung. */
  updatedAt?: string;
}

/**
 * Ein gekoppeltes Geraet, wie die Handy-App es in der Liste zeigt.
 *
 * Bewusst ohne Token und ohne dessen Hash: die Liste geht an jedes gekoppelte
 * Geraet, und keines davon braucht das Geheimnis eines anderen.
 */
export interface PairedDevice {
  id: string;
  name: string;
  /** ISO-Zeitstempel der Kopplung. */
  pairedAt: string;
  /** ISO-Zeitstempel der letzten gesehenen Verbindung. */
  lastSeen: string;
  /** Haengt das Geraet gerade am Spiegel? */
  online: boolean;
}

/**
 * Stand der offenen Kopplung: der Code steht auf dem Spiegel, hier steht nur,
 * dass und bis wann einer offen ist. Der Code selbst geht nie an ein
 * ungekoppeltes Handy – sonst waere der Sichtkontakt zum Spiegel keine Huerde
 * mehr.
 */
export interface PairingState {
  open: boolean;
  expiresAt: string | null;
}

/* ------------------------------- Client → Server ------------------------------- */

export type ClientMessage =
  | { t: 'hello'; clientType: ClientType; token?: string; appVersion: string }
  | { t: 'pair:request'; code: string; clientName: string }
  /**
   * Bitte um einen Kopplungscode auf dem Spiegel. Bewusst eine eigene
   * Nachricht und keine Nebenwirkung des Verbindens: sonst wirft jeder
   * Browser, der die Adresse zufaellig oeffnet, dem Spiegel einen Code
   * ueber den Inhalt.
   */
  | { t: 'pair:start' }
  | { t: 'pair:cancel' }
  | { t: 'shell:ready'; appVersion: string }
  | { t: 'shell:viewport'; viewport: Viewport }
  | { t: 'command'; instanceId: string; name: string; payload?: unknown }
  | { t: 'admin:setInstanceConfig'; instanceId: string; config: Record<string, unknown> }
  | { t: 'admin:setLayout'; instances: LayoutPatch[] }
  | {
      t: 'admin:addInstance';
      moduleId: string;
      screenId?: string;
      size?: WidgetSize;
      x?: number;
      y?: number;
      zone?: Zone;
    }
  | { t: 'admin:removeInstance'; instanceId: string }
  | { t: 'admin:addScreen'; name?: string }
  | { t: 'admin:removeScreen'; screenId: string }
  | {
      t: 'admin:setScreen';
      screenId: string;
      patch: Partial<Pick<MirrorScreen, 'name' | 'durationSeconds' | 'layout'>>;
    }
  | { t: 'admin:reorderScreens'; ids: string[] }
  /**
   * Der Spiegel soll diesen Screen zeigen und nicht weiterschalten, solange am
   * Handy daran gearbeitet wird. Kein Teil der Konfiguration: die Vorschau ist
   * ein Zustand von jetzt und darf einen Neustart nicht ueberleben.
   */
  | { t: 'admin:previewScreen'; screenId: string | null }
  | { t: 'admin:setSettings'; patch: Partial<Pick<MirrorConfig, 'deviceName' | 'locale' | 'timezone' | 'display' | 'power' | 'update' | 'setup'>> }
  | { t: 'admin:setSecret'; moduleId: string; key: string; value: string }
  | { t: 'admin:power'; on: boolean }
  | { t: 'admin:renameDevice'; deviceId: string; name: string }
  | { t: 'admin:revokeDevice'; deviceId: string }
  | { t: 'admin:checkUpdate' }
  | { t: 'admin:applyUpdate'; version?: string }
  | { t: 'ping' };

/* ------------------------------- Server → Client ------------------------------- */

export type ServerMessage
  = {
      t: 'welcome';
      serverVersion: string;
      authenticated: boolean;
      needsPairing: boolean;
      /** Haengt schon mindestens ein Geraet am Spiegel? */
      mirrorPaired: boolean;
      /** Eigene Geraete-Id, sobald angemeldet – die Liste markiert damit "dieses Geraet". */
      deviceId?: string;
      /** Nur fuer ungekoppelte Clients: laeuft gerade eine Kopplung? */
      pairing?: PairingState;
    }
  | { t: 'snapshot'; config: MirrorConfig; modules: ModuleDescriptor[]; state: Record<string, ModuleStateEnvelope>; power: { on: boolean }; update: UpdateStatus; viewport: Viewport | null; previewScreenId: string | null }
  | { t: 'state:patch'; envelope: ModuleStateEnvelope }
  | { t: 'config:update'; config: MirrorConfig }
  | { t: 'modules:update'; modules: ModuleDescriptor[] }
  | { t: 'display:power'; on: boolean }
  | { t: 'display:viewport'; viewport: Viewport | null }
  | { t: 'display:previewScreen'; screenId: string | null }
  | { t: 'update:status'; status: UpdateStatus }
  | { t: 'pair:result'; ok: true; token: string; deviceId: string }
  /** Nur an die Anzeige: der Code zum Abschreiben. Leer heisst "wieder wegnehmen". */
  | { t: 'pair:code'; code: string; expiresAt: string }
  /** An alle anderen: dass eine Kopplung offen ist, ohne den Code selbst. */
  | { t: 'pair:state'; pairing: PairingState }
  | { t: 'devices:update'; devices: PairedDevice[] }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'not-found'
  | 'pairing-failed'
  | 'internal';

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string';
}
