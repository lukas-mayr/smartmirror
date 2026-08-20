import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readJson, sha256, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { authFile } from './paths.js';

const log = createLogger('auth');

const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

interface StoredClient {
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

/**
 * Kopplung statt Passwort.
 *
 * Wer ein neues Handy anmelden will, braucht Sichtkontakt zum Spiegel: dort
 * steht der sechsstellige Code. Das ist fuer ein Geraet im eigenen WLAN die
 * angemessene Huerde und erspart ein Passwort, das ohnehin niemand aendert.
 */
export class AuthStore {
  #clients: StoredClient[] = [];
  #pending: PairingCode | null = null;
  #failedAttempts = 0;
  #lockedUntil = 0;

  async load(): Promise<void> {
    const file = await readJson<AuthFile>(authFile);
    this.#clients = file?.clients ?? [];
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
  async redeem(code: string, clientName: string): Promise<string | null> {
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
    this.#clients.push({
      tokenHash: sha256(token),
      name: clientName.slice(0, 64) || 'Unbenannt',
      pairedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    this.#pending = null;
    await this.#persist();
    log.info(`Neues Geraet gekoppelt: ${clientName}`);
    return token;
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const hash = sha256(token);
    const client = this.#clients.find((entry) => entry.tokenHash === hash);
    if (!client) return false;
    client.lastSeen = new Date().toISOString();
    return true;
  }

  listClients(): { name: string; pairedAt: string; lastSeen: string }[] {
    return this.#clients.map(({ name, pairedAt, lastSeen }) => ({ name, pairedAt, lastSeen }));
  }

  async revokeAll(): Promise<void> {
    this.#clients = [];
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await writeJsonAtomic(authFile, { clients: this.#clients } satisfies AuthFile);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
