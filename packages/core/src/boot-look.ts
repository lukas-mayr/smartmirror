import { EventEmitter } from 'node:events';
import type { BootLookStatus } from '@mirror/sdk';
import { readJson } from './atomic-file.js';
import { createLogger } from './logger.js';
import { bootLookStatusFile } from './paths.js';

const log = createLogger('bootlook');

/**
 * Wie oft nachgesehen wird.
 *
 * Selten, weil die Datei sich hoechstens einmal pro Start aendert: der Dienst
 * mirror-bootlook.service schreibt sie beim Booten, und der Updater loest ihn
 * zusaetzlich aus, wenn er ihn neu einspielt. Genau dieser zweite Fall ist der
 * Grund, warum ueberhaupt nachgesehen wird und nicht nur einmal gelesen: der
 * Core laeuft dann schon.
 */
const POLL_MS = 30_000;

const PLYMOUTH_STATES: BootLookStatus['plymouth'][] = ['ready', 'installed', 'missing'];

/**
 * Liest, wie der Spiegel beim Booten aussieht.
 *
 * Nur lesend – geschrieben wird die Datei von deploy/mirror-bootlook.sh, das
 * als root laeuft. Dieselbe Trennung wie beim Updater: der Core sagt, was zu
 * sehen ist, und nicht, was zu tun ist.
 */
export class BootLookBridge extends EventEmitter {
  #status: BootLookStatus | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastRaw = '';

  get status(): BootLookStatus | null {
    return this.#status;
  }

  start(): void {
    void this.#poll();
    this.#timer = setInterval(() => void this.#poll(), POLL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #poll(): Promise<void> {
    try {
      const raw = await readJson<unknown>(bootLookStatusFile);
      const serialized = JSON.stringify(raw ?? null);
      if (serialized === this.#lastRaw) return;
      this.#lastRaw = serialized;
      this.#status = normalize(raw);
      this.emit('status', this.#status);
    } catch (error) {
      log.warn('Zustand des Startbildschirms nicht lesbar', error);
    }
  }
}

/**
 * Die Datei kommt aus einem Shell-Skript, nicht aus dem Typsystem.
 *
 * Was dort steht, wird deshalb hier auf die Form gebracht, statt darauf zu
 * vertrauen – eine halb geschriebene oder aeltere Fassung soll die App nicht
 * durcheinanderbringen, sondern nur nichts anzeigen.
 */
function normalize(value: unknown): BootLookStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Partial<Record<keyof BootLookStatus, unknown>>;
  if (typeof source.appliedAt !== 'string') return null;
  return {
    appliedAt: source.appliedAt,
    pendingReboot: source.pendingReboot === true,
    changed: Array.isArray(source.changed) ? source.changed.filter((entry): entry is string => typeof entry === 'string') : [],
    plymouth: PLYMOUTH_STATES.includes(source.plymouth as BootLookStatus['plymouth'])
      ? (source.plymouth as BootLookStatus['plymouth'])
      : 'missing',
  };
}
