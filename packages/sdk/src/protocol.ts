import type { MirrorConfig, ModuleInstance } from './config.js';
import type { ModuleDescriptor } from './manifest.js';

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
  | { t: 'admin:setLayout'; instances: Pick<ModuleInstance, 'id' | 'zone' | 'order' | 'enabled'>[] }
  | { t: 'admin:addInstance'; moduleId: string; zone: string }
  | { t: 'admin:removeInstance'; instanceId: string }
  | { t: 'admin:setSettings'; patch: Partial<Pick<MirrorConfig, 'deviceName' | 'locale' | 'timezone' | 'display' | 'power' | 'update' | 'setup'>> }
  | { t: 'admin:setSecret'; moduleId: string; key: string; value: string }
  | { t: 'admin:power'; on: boolean }
  | { t: 'admin:checkUpdate' }
  | { t: 'admin:applyUpdate'; version?: string }
  | { t: 'ping' };

/* ------------------------------- Server → Client ------------------------------- */

export type ServerMessage
  = { t: 'welcome'; serverVersion: string; authenticated: boolean; needsPairing: boolean }
  | { t: 'snapshot'; config: MirrorConfig; modules: ModuleDescriptor[]; state: Record<string, ModuleStateEnvelope>; power: { on: boolean }; update: UpdateStatus; viewport: Viewport | null }
  | { t: 'state:patch'; envelope: ModuleStateEnvelope }
  | { t: 'config:update'; config: MirrorConfig }
  | { t: 'modules:update'; modules: ModuleDescriptor[] }
  | { t: 'display:power'; on: boolean }
  | { t: 'display:viewport'; viewport: Viewport | null }
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
