import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { dataDir, keyFile, secretsFile } from './paths.js';

const log = createLogger('secrets');

interface SecretRecord {
  iv: string;
  tag: string;
  data: string;
}

type SecretFile = Record<string, Record<string, SecretRecord>>;

/**
 * Verschluesselte Ablage fuer Modul-Geheimnisse (API-Keys).
 *
 * Der Schluessel liegt geraetelokal in device.key (0600). Das schuetzt gegen
 * das, was realistisch passiert: ein Backup oder ein SD-Karten-Image, das
 * weitergegeben wird, enthaelt die Keys dann nicht im Klartext. Gegen jemanden
 * mit Root-Zugriff auf dem laufenden Geraet schuetzt es nicht – das kann eine
 * Software, die die Keys selbst benutzen muss, grundsaetzlich nicht.
 */
export class SecretStore {
  #key!: Buffer;
  #secrets: SecretFile = {};

  async load(): Promise<void> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    this.#key = await this.#loadOrCreateKey();
    this.#secrets = (await readJson<SecretFile>(secretsFile)) ?? {};
  }

  /** Welche Keys fuer ein Modul hinterlegt sind – ohne die Werte selbst. */
  listFor(moduleId: string): string[] {
    return Object.keys(this.#secrets[moduleId] ?? {});
  }

  get(moduleId: string, key: string): string | undefined {
    const record = this.#secrets[moduleId]?.[key];
    if (!record) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return decipher.update(record.data, 'base64', 'utf8') + decipher.final('utf8');
    } catch (error) {
      // Passiert, wenn device.key ersetzt wurde. Der Nutzer muss den Key neu
      // eintragen – lauter scheitern als still ein falsches Geheimnis liefern.
      log.error(`Geheimnis ${moduleId}.${key} laesst sich nicht entschluesseln`, error);
      return undefined;
    }
  }

  async set(moduleId: string, key: string, value: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const bucket = (this.#secrets[moduleId] ??= {});
    bucket[key] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    await this.#persist();
  }

  async remove(moduleId: string, key: string): Promise<void> {
    const bucket = this.#secrets[moduleId];
    if (!bucket) return;
    delete bucket[key];
    if (Object.keys(bucket).length === 0) delete this.#secrets[moduleId];
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await writeJsonAtomic(secretsFile, this.#secrets);
    await chmod(secretsFile, 0o600).catch(() => {});
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    try {
      const raw = await readFile(keyFile, 'utf8');
      const key = Buffer.from(raw.trim(), 'base64');
      if (key.length === 32) return key;
      log.warn('device.key hat die falsche Laenge – erzeuge einen neuen Schluessel.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = randomBytes(32);
    await writeFile(keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
    log.info('Neuen Geraeteschluessel erzeugt.');
    return key;
  }
}
