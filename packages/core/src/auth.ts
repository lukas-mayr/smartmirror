import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PairedDevice } from '@mirror/sdk';
import { readJson, sha256, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { authFile } from './paths.js';

const log = createLogger('auth');

const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
/**
 * "Zuletzt gesehen" wird bei jedem Lebenszeichen neu gesetzt – geschrieben
 * aber nur alle paar Minuten. Sonst schriebe ein Handy in der Tasche die
 * SD-Karte alle zwanzig Sekunden voll.
 */
const LAST_SEEN_WRITE_MS = 10 * 60_000;

interface StoredClient {
  id: string;
  /** Nur der Hash – ein gestohlenes auth.json gibt keine gueltigen Token her. */
  tokenHash: string;
  name: string;
  pairedAt: string;
  lastSeen: string;
}

interface AuthFile {
  clients: StoredClient[];
}

export interface PairingCode {
  code: string;
  expiresAt: Date;
}

/** Ein gekoppeltes Geraet, wie es nach aussen gereicht wird – ohne Tokenhash. */
export type PairedClient = Omit<PairedDevice, 'online'>;

/**
 * Kopplung statt Passwort.
 *
 * Wer ein neues Handy anmelden will, braucht Sichtkontakt zum Spiegel: dort
 * steht der sechsstellige Code. Das ist fuer ein Geraet im eigenen WLAN die
 * angemessene Huerde und erspart ein Passwort, das ohnehin niemand aendert.
 *
 * Gekoppelt wird nicht *ein* Geraet, sondern beliebig viele: im Haushalt hat
 * jeder ein Handy, und auf einem iPhone sind Safari und die zum Startbildschirm
 * hinzugefuegte App zwei getrennte Speicher – also auch zwei Geraete. Jedes
 * bekommt ein eigenes Token und kann einzeln wieder entzogen werden.
 */
export class AuthStore {
  #clients: StoredClient[] = [];
  #pending: PairingCode | null = null;
  #failedAttempts = 0;
  #lockedUntil = 0;
  #lastSeenWrittenAt = 0;

  async load(): Promise<void> {
    const file = await readJson<AuthFile>(authFile);
    const clients = file?.clients ?? [];
    // Geraete aus aelteren Versionen haben keine Id. Ohne sie liesse sich in
    // der Liste keines einzeln entziehen – also eine nachtragen.
    let migrated = false;
    this.#clients = clients.map((client) => {
      if (typeof client.id === 'string' && client.id) return client;
      migrated = true;
      return { ...client, id: randomUUID() };
    });
    if (migrated) await this.#persist();
    log.info(`${this.#clients.length} gekoppelte Geraete geladen.`);
  }

  get hasPairedClients(): boolean {
    return this.#clients.length > 0;
  }

  get pendingCode(): PairingCode | null {
    if (this.#pending && this.#pending.expiresAt.getTime() < Date.now()) this.#pending = null;
    return this.#pending;
  }

  /** Erzeugt einen Code und laesst ihn auf dem Spiegel anzeigen. */
  startPairing(): PairingCode {
    // Ein schon offener Code wird weitergereicht statt ersetzt: sonst zoege
    // ein zweites Handy dem ersten den Code unter den Fingern weg.
    const open = this.pendingCode;
    if (open) return open;

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.#pending = { code, expiresAt: new Date(Date.now() + CODE_TTL_MS) };
    this.#failedAttempts = 0;
    log.info('Kopplungscode erzeugt, gueltig fuer 5 Minuten.');
    return this.#pending;
  }

  cancelPairing(): void {
    this.#pending = null;
  }

  /** Tauscht einen Code gegen ein dauerhaftes Token. */
  async redeem(code: string, clientName: string): Promise<{ token: string; device: PairedClient } | null> {
    if (Date.now() < this.#lockedUntil) {
      log.warn('Kopplung vorruebergehend gesperrt (zu viele Fehlversuche).');
      return null;
    }
    const pending = this.pendingCode;
    if (!pending || !constantTimeEquals(code, pending.code)) {
      this.#failedAttempts += 1;
      if (this.#failedAttempts >= MAX_ATTEMPTS) {
        // Sechs Stellen sind ohne Bremse in Sekunden durchprobiert.
        this.#pending = null;
        this.#lockedUntil = Date.now() + 60_000;
        this.#failedAttempts = 0;
        log.warn('Kopplungscode nach zu vielen Fehlversuchen verworfen.');
      }
      return null;
    }

    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const client: StoredClient = {
      id: randomUUID(),
      tokenHash: sha256(token),
      name: uniqueName(cleanName(clientName), this.#clients),
      pairedAt: now,
      lastSeen: now,
    };
    this.#clients.push(client);
    this.#pending = null;
    await this.#persist();
    log.info(`Neues Geraet gekoppelt: ${client.name} (${this.#clients.length} insgesamt).`);
    return { token, device: toPairedClient(client) };
  }

  /**
   * Prueft ein Token und gibt das dazugehoerige Geraet zurueck.
   *
   * Gibt die Id mit heraus, damit der Server weiss, *welches* Geraet gerade
   * haengt: nur so kann die Liste "dieses Geraet" markieren und ein Entzug die
   * betroffene Verbindung gezielt beenden.
   */
  identify(token: string | undefined): PairedClient | null {
    if (!token) return null;
    const hash = sha256(token);
    const client = this.#clients.find((entry) => entry.tokenHash === hash);
    if (!client) return null;
    client.lastSeen = new Date().toISOString();
    this.#persistLastSeenOccasionally();
    return toPairedClient(client);
  }

  /** Meldet ein Lebenszeichen, ohne dafuer jedes Mal zu schreiben. */
  touch(deviceId: string): void {
    const client = this.#clients.find((entry) => entry.id === deviceId);
    if (!client) return;
    client.lastSeen = new Date().toISOString();
    this.#persistLastSeenOccasionally();
  }

  listClients(): PairedClient[] {
    return this.#clients.map(toPairedClient);
  }

  async rename(deviceId: string, name: string): Promise<boolean> {
    const client = this.#clients.find((entry) => entry.id === deviceId);
    if (!client) return false;
    const next = cleanName(name);
    if (next === client.name) return true;
    client.name = uniqueName(next, this.#clients.filter((entry) => entry !== client));
    await this.#persist();
    return true;
  }

  /** Entzieht genau einem Geraet die Kopplung. */
  async revoke(deviceId: string): Promise<boolean> {
    const before = this.#clients.length;
    this.#clients = this.#clients.filter((entry) => entry.id !== deviceId);
    if (this.#clients.length === before) return false;
    await this.#persist();
    log.info(`Geraet entkoppelt (${this.#clients.length} verbleiben).`);
    return true;
  }

  async revokeAll(): Promise<void> {
    this.#clients = [];
    await this.#persist();
  }

  #persistLastSeenOccasionally(): void {
    if (Date.now() - this.#lastSeenWrittenAt < LAST_SEEN_WRITE_MS) return;
    this.#lastSeenWrittenAt = Date.now();
    void this.#persist().catch((error: unknown) => log.warn('Konnte auth.json nicht schreiben', error));
  }

  async #persist(): Promise<void> {
    this.#lastSeenWrittenAt = Date.now();
    await writeJsonAtomic(authFile, { clients: this.#clients } satisfies AuthFile);
  }
}

function toPairedClient(client: StoredClient): PairedClient {
  const { id, name, pairedAt, lastSeen } = client;
  return { id, name, pairedAt, lastSeen };
}

function cleanName(name: string): string {
  return name.trim().slice(0, 64) || 'Unbenannt';
}

/**
 * Zwei iPhones heissen beim Koppeln gleich – in der Liste waere dann nicht zu
 * erkennen, welches man gerade entzieht. Also durchnummerieren.
 */
function uniqueName(name: string, others: readonly StoredClient[]): string {
  const taken = new Set(others.map((entry) => entry.name));
  if (!taken.has(name)) return name;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
  return name;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
