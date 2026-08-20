import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpdateStatus } from '@mirror/sdk';
import { readJson, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { appVersion, updateRequestFile, updateStatusFile } from './paths.js';

const run = promisify(execFile);
const log = createLogger('update');

const POLL_MS = 5_000;

export interface UpdateRequest {
  action: 'check' | 'apply';
  version?: string;
  requestedAt: string;
}

/**
 * Bindeglied zum Updater, der als eigener Dienst laeuft.
 *
 * Die Trennung ist Absicht: der Updater ersetzt genau die Dateien, aus denen
 * der Core laeuft, und startet ihn neu. Liefe er im Core-Prozess, wuerde er
 * sich selbst unter den Fuessen wegziehen. Kommuniziert wird deshalb ueber
 * zwei Dateien im Datenverzeichnis statt ueber einen Funktionsaufruf.
 */
export class UpdateBridge extends EventEmitter {
  #status: UpdateStatus = {
    phase: 'idle',
    currentVersion: appVersion(),
    blocked: [],
  };
  #timer: NodeJS.Timeout | null = null;
  #lastRaw = '';

  get status(): UpdateStatus {
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

  async requestCheck(): Promise<void> {
    await this.#request({ action: 'check', requestedAt: new Date().toISOString() });
  }

  async requestApply(version?: string): Promise<void> {
    await this.#request({ action: 'apply', version, requestedAt: new Date().toISOString() });
  }

  async #request(request: UpdateRequest): Promise<void> {
    await writeJsonAtomic(updateRequestFile, request);
    // Der Timer wuerde die Anfrage ohnehin einsammeln; das hier macht den
    // Knopf in der App unmittelbar wirksam statt erst in 15 Minuten.
    try {
      await run('systemctl', ['start', 'mirror-updater.service'], { timeout: 5_000 });
    } catch {
      log.debug('systemctl nicht verfuegbar – Updater holt die Anfrage beim naechsten Lauf ab.');
    }
  }

  async #poll(): Promise<void> {
    try {
      const status = await readJson<UpdateStatus>(updateStatusFile);
      if (!status) return;
      const raw = JSON.stringify(status);
      if (raw === this.#lastRaw) return;
      this.#lastRaw = raw;
      this.#status = { ...status, currentVersion: status.currentVersion || appVersion() };
      this.emit('status', this.#status);
    } catch (error) {
      log.warn('Update-Status nicht lesbar', error);
    }
  }
}
