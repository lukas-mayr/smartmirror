import { EventEmitter } from 'node:events';
import { normalizeWifiStatus, type WifiPending, type WifiStatus } from '@mirror/sdk';
import { readJson, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { wifiRequestFile, wifiStatusFile } from './paths.js';

const log = createLogger('wifi');

/**
 * Wie oft nachgesehen wird.
 *
 * Haeufiger als beim Startbild und seltener als noetig waere: der Root-Dienst
 * laeuft alle 30 Sekunden von selbst, und beim Verbinden zaehlt jede Sekunde,
 * in der jemand vor dem Spiegel auf eine Antwort wartet.
 */
const POLL_MS = 3_000;

/**
 * Wie lange ein Auftrag unterwegs sein darf, bevor er als unbeantwortet gilt.
 *
 * Grosszuegiger als beim Updater, weil hier tatsaechlich etwas dauert: ein
 * Verbindungsversuch wartet bis zu 45 Sekunden auf das Netz, davor liegt
 * womoeglich noch ein Suchlauf. Erst danach ist Schweigen ein Befund.
 *
 * Dass es die Grenze ueberhaupt gibt, ist die Lehre aus dem Updater: dort hing
 * ein Knopf an einer Path-Unit, die auf einem Geraet im Feld nicht feuerte,
 * und die App sagte fuer immer "suche nach Updates …". Ein Knopf, der nichts
 * tut und nichts sagt, ist schlimmer als eine Fehlermeldung.
 */
const REQUEST_GRACE_MS = 90_000;

export interface WifiRequest {
  action: 'scan' | 'connect' | 'forget' | 'hotspot';
  ssid?: string;
  passphrase?: string;
  on?: boolean;
  requestedAt: string;
}

export interface WifiBridgeOptions {
  /** Abstand der Nachschau. Kuerzer nur in Tests – die SD-Karte dankt es. */
  pollMs?: number;
  /** Wie lange ein Auftrag unterwegs sein darf, bevor er als tot gilt. */
  graceMs?: number;
}

/**
 * Bindeglied zum Root-Dienst, der das WLAN schaltet.
 *
 * Der Umweg ueber zwei Dateien ist derselbe wie beim Neustart und beim
 * Updater, und aus demselben Grund: der Core laeuft unprivilegiert. Ein
 * "nmcli" von hier aus scheitert an polkit, und ihm das Recht zu geben hiesse,
 * dem einzigen ans Netz gebundenen Dienst die Kontrolle ueber genau dieses
 * Netz zu geben.
 *
 * Das Passwort geht durch diese Bruecke und bleibt nirgends liegen: der Core
 * schreibt es in die Auftragsdatei, der Root-Dienst loescht sie, bevor er
 * etwas tut, und legt es in ein Profil des NetworkManagers. Zurueck kommt es
 * nie – der Bericht kennt Netznamen und Signalstaerken, keine Geheimnisse.
 */
export class WifiBridge extends EventEmitter {
  #pollMs: number;
  #graceMs: number;
  #status: WifiStatus | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** Wann zuletzt etwas angefordert wurde. 0 heisst: nichts ist unterwegs. */
  #requestedAt = 0;
  /** Zeitstempel des offenen Auftrags, so wie er in der Datei steht. */
  #requestStamp: string | null = null;
  #pending: WifiPending | null = null;

  constructor(options: WifiBridgeOptions = {}) {
    super();
    this.#pollMs = options.pollMs ?? POLL_MS;
    this.#graceMs = options.graceMs ?? REQUEST_GRACE_MS;
  }

  get status(): WifiStatus | null {
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

  async requestScan(): Promise<void> {
    await this.#request({ action: 'scan', requestedAt: new Date().toISOString() }, 'scan');
  }

  async requestConnect(ssid: string, passphrase: string): Promise<void> {
    await this.#request(
      { action: 'connect', ssid, passphrase, requestedAt: new Date().toISOString() },
      'connect',
    );
  }

  async requestForget(ssid: string): Promise<void> {
    await this.#request({ action: 'forget', ssid, requestedAt: new Date().toISOString() }, 'forget');
  }

  async requestHotspot(on: boolean): Promise<void> {
    await this.#request({ action: 'hotspot', on, requestedAt: new Date().toISOString() }, 'hotspot');
  }

  async #request(request: WifiRequest, pending: WifiPending): Promise<void> {
    // Nicht protokolliert wird, was in der Anfrage steht: das Journal ist
    // lesbar, und in "connect" steckt ein Passwort.
    log.info(`WLAN-Auftrag "${request.action}" abgelegt.`);
    await writeJsonAtomic(wifiRequestFile, request);
    this.#requestedAt = Date.now();
    this.#requestStamp = request.requestedAt;
    this.#pending = pending;

    // Sofort melden, dass etwas laeuft. Der Root-Dienst braucht bis zu
    // dreissig Sekunden, bis der Timer ihn holt – ohne diese Zeile bliebe der
    // Knopf so lange ohne jede Reaktion, und das sieht aus wie kaputt.
    this.#veroeffentliche(this.#status, pending);
  }

  async #poll(): Promise<void> {
    try {
      const raw = await readJson<unknown>(wifiStatusFile);
      const status = normalizeWifiStatus(raw);
      if (!status) return;

      // Beantwortet der Bericht genau den Auftrag, der unterwegs ist? Der
      // Root-Dienst schreibt dafuer dessen Zeitstempel zurueck. Ihn zu
      // vergleichen ist verlaesslicher als "die Datei hat sich geaendert": der
      // Dienst laeuft alle dreissig Sekunden und schreibt dabei ohnehin.
      const beantwortet = this.#requestStamp !== null && status.answeredAt === this.#requestStamp;
      if (beantwortet) {
        this.#requestedAt = 0;
        this.#requestStamp = null;
        this.#pending = null;
      } else if (this.#requestedAt !== 0 && Date.now() - this.#requestedAt > this.#graceMs) {
        // Und wenn sich niemand meldet, das auch sagen.
        this.#requestedAt = 0;
        this.#requestStamp = null;
        this.#pending = null;
        this.#veroeffentliche(
          { ...status, lastError: 'Der WLAN-Dienst hat auf die Anfrage nicht reagiert.' },
          null,
        );
        return;
      }

      this.#veroeffentliche(status, this.#pending);
    } catch (error) {
      log.warn('WLAN-Status nicht lesbar', error);
    }
  }

  /** Meldet einen neuen Zustand – aber nur, wenn er wirklich neu ist. */
  #veroeffentliche(status: WifiStatus | null, pending: WifiPending | null): void {
    const next = status === null ? null : { ...status, pending };
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    this.#status = next;
    this.emit('status', this.#status);
  }
}
