import { EventEmitter } from 'node:events';
import type { UpdateStatus } from '@mirror/sdk';
import { readJson, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { appVersion, updateRequestFile, updateStatusFile } from './paths.js';
import { requestUpdaterRun } from './system-bridge.js';

const log = createLogger('update');

const POLL_MS = 5_000;

/**
 * Wie lange eine Anfrage unterwegs sein darf, bevor sie als unbeantwortet gilt.
 *
 * Der Updater meldet sich, indem er seine Statusdatei schreibt - mit frischem
 * `lastCheck`, also bei jedem Lauf anders. Bleibt sie eine Minute lang Byte
 * fuer Byte dieselbe, ist er nicht gelaufen. Genau das passierte auf einem
 * Geraet im Feld, und weil der Core seinen optimistischen Zustand nie
 * zuruecknahm, stand dort fuer immer "suche nach Updates ...".
 *
 * Eine Minute ist reichlich: der Dienst startet in Sekunden. Sie ist so
 * bemessen, dass ein langsamer Start nicht faelschlich als Ausfall gilt.
 */
const REQUEST_GRACE_MS = 60_000;

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
export interface UpdateBridgeOptions {
  /** Abstand der Nachschau. Kuerzer nur in Tests – die SD-Karte dankt es. */
  pollMs?: number;
  /** Wie lange eine Anfrage unterwegs sein darf, bevor sie als tot gilt. */
  graceMs?: number;
}

export class UpdateBridge extends EventEmitter {
  #pollMs: number;
  #graceMs: number;
  #status: UpdateStatus = {
    phase: 'idle',
    currentVersion: appVersion(),
    blocked: [],
  };
  #timer: NodeJS.Timeout | null = null;
  #lastRaw = '';
  /** Wann zuletzt etwas angefordert wurde. 0 heisst: nichts ist unterwegs. */
  #requestedAt = 0;

  constructor(options: UpdateBridgeOptions = {}) {
    super();
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#graceMs = options.graceMs ?? REQUEST_GRACE_MS;
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  start(): void {
    void this.#poll();
    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
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

    // Zweiter Weg zum Updater, und der verlaesslichere: mirror-system.service
    // haengt zusaetzlich an einem Timer. Die Path-Unit unten bleibt der
    // schnelle Weg – wenn sie denn feuert.
    await requestUpdaterRun().catch((error: unknown) =>
      log.warn('Updater liess sich nicht anstossen', error),
    );
    this.#requestedAt = Date.now();

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
      const geschrieben = { ...status, currentVersion: status.currentVersion || appVersion() };

      if (raw !== this.#lastRaw) {
        // Der Updater hat sich gemeldet. Was er sagt, gilt.
        this.#lastRaw = raw;
        this.#requestedAt = 0;
        this.#veroeffentliche(geschrieben);
        return;
      }

      // Ab hier ist die Datei unveraendert.
      //
      // Ohne offene Anfrage ist das der Normalfall und die Datei die Wahrheit.
      // Frueher stand hier nur ein `return` – und genau daran blieb der
      // optimistische Zustand aus #request haengen, ohne je zurueckgenommen zu
      // werden.
      if (this.#requestedAt === 0) {
        this.#veroeffentliche(geschrieben);
        return;
      }

      // Eine Anfrage ist unterwegs: dem Updater einen Moment lassen.
      if (Date.now() - this.#requestedAt < this.#graceMs) return;

      // Und wenn er sich nicht meldet, das auch sagen. Ein Knopf, der nichts
      // tut und nichts sagt, ist schlimmer als eine Fehlermeldung.
      this.#requestedAt = 0;
      this.#veroeffentliche({
        ...geschrieben,
        lastError: 'Der Update-Dienst hat auf die Anfrage nicht reagiert.',
      });
    } catch (error) {
      log.warn('Update-Status nicht lesbar', error);
    }
  }

  /** Meldet einen neuen Zustand – aber nur, wenn er wirklich neu ist. */
  #veroeffentliche(status: UpdateStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.#status)) return;
    this.#status = status;
    this.emit('status', this.#status);
  }
}
