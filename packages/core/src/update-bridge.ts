import { EventEmitter } from 'node:events';
import type { UpdateStatus } from '@mirror/sdk';
import { readJson, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { appVersion, updateRequestFile, updateStatusFile } from './paths.js';

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

    // Ausgeloest wird der Updater von mirror-updater.path, das auf genau diese
    // Datei wartet. Frueher stand hier ein "systemctl start" – das konnte nie
    // funktionieren: der Core laeuft unprivilegiert, und polkit beantwortet
    // jeden Versuch mit "Interactive authentication required". Der Fehler fiel
    // in ein leeres catch, und der Knopf in der App wirkte erst, wenn der
    // Timer von sich aus lief: bis zu zwanzig Minuten spaeter.
    //
    // Die Phase hier schon zu setzen ist der Rest desselben Problems: der
    // Updater braucht einen Moment, bis er seinen Status geschrieben hat, und
    // #poll sieht ihn erst danach. Ohne diese Zeile bliebe der Knopf mehrere
    // Sekunden ohne Reaktion. Bleibt der Ausloeser aus, ruecken der naechste
    // Timer-Lauf und der naechste Poll die Phase wieder zurecht.
    this.#status = { ...this.#status, phase: 'checking', lastError: undefined };
    this.emit('status', this.#status);
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
