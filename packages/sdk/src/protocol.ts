import type { MirrorConfig } from './config.js';
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

export interface ModuleStateEnvelope {
  instanceId: string;
  /** Freier Modul-State. Wird flach ueber den bestehenden State gemerged. */
  patch: Record<string, unknown>;
  /** Modul meldet einen Fehlerzustand – die Shell zeigt ihn dezent an. */
  error?: string | null;
  /** ISO-Zeitstempel der letzten erfolgreichen Aktualisierung. */
  updatedAt?: string;
}

/* ------------------------------- Client → Server ------------------------------- */

export type ClientMessage =
  | { t: 'hello'; clientType: ClientType; token?: string; appVersion: string }
  | { t: 'pair:request'; code: string; clientName: string }
  | { t: 'shell:ready'; appVersion: string }
  | { t: 'shell:viewport'; viewport: Viewport }
  | { t: 'command'; instanceId: string; name: string; payload?: unknown }
  | { t: 'admin:setInstanceConfig'; instanceId: string; config: Record<string, unknown> }
  | { t: 'admin:setLayout'; instances: LayoutPatch[] }
  | { t: 'admin:addInstance'; moduleId: string; screenId?: string; size?: WidgetSize; x?: number; y?: number }
  | { t: 'admin:removeInstance'; instanceId: string }
  | { t: 'admin:addScreen'; name?: string }
  | { t: 'admin:removeScreen'; screenId: string }
  | { t: 'admin:setScreen'; screenId: string; patch: Partial<Pick<MirrorScreen, 'name' | 'durationSeconds'>> }
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
  | { t: 'admin:checkUpdate' }
  | { t: 'admin:applyUpdate'; version?: string }
  | { t: 'ping' };

/* ------------------------------- Server → Client ------------------------------- */

export type ServerMessage
  = { t: 'welcome'; serverVersion: string; authenticated: boolean; needsPairing: boolean }
  | { t: 'snapshot'; config: MirrorConfig; modules: ModuleDescriptor[]; state: Record<string, ModuleStateEnvelope>; power: { on: boolean }; update: UpdateStatus; viewport: Viewport | null; previewScreenId: string | null }
  | { t: 'state:patch'; envelope: ModuleStateEnvelope }
  | { t: 'config:update'; config: MirrorConfig }
  | { t: 'modules:update'; modules: ModuleDescriptor[] }
  | { t: 'display:power'; on: boolean }
  | { t: 'display:viewport'; viewport: Viewport | null }
  | { t: 'display:previewScreen'; screenId: string | null }
  | { t: 'update:status'; status: UpdateStatus }
  | { t: 'pair:result'; ok: true; token: string }
  | { t: 'pair:code'; code: string; expiresAt: string }
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
