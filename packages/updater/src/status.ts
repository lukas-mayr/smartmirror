import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { UpdatePhase, UpdateStatus } from '@mirror/sdk';
import { dataDir, statusFile } from './paths.js';

/**
 * Schreibt den Zustand fuer den Core, der ihn an die Handy-App weiterreicht.
 * Der Updater und der Core teilen keinen Prozess – diese Datei ist ihre
 * einzige Verbindung.
 */
export class StatusWriter {
  #status: UpdateStatus;

  constructor(currentVersion: string, blocked: readonly string[]) {
    this.#status = { phase: 'idle', currentVersion, blocked };
  }

  get value(): UpdateStatus {
    return this.#status;
  }

  async set(phase: UpdatePhase, patch: Partial<UpdateStatus> = {}): Promise<void> {
    this.#status = { ...this.#status, phase, ...patch };
    await this.flush();
  }

  async progress(fraction: number): Promise<void> {
    // Nur in Zehnerschritten schreiben: der Core pollt ohnehin nur alle paar
    // Sekunden, und die SD-Karte dankt es.
    const rounded = Math.round(fraction * 10) / 10;
    if (this.#status.progress === rounded) return;
    this.#status = { ...this.#status, progress: rounded };
    await this.flush();
  }

  async flush(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    const tmp = join(dirname(statusFile), `.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, `${JSON.stringify(this.#status, null, 2)}\n`, 'utf8');
    await rename(tmp, statusFile);
  }
}
