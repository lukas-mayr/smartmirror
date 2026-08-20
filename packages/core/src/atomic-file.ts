import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Atomares Schreiben: erst in eine Temporaerdatei, fsync, dann rename.
 *
 * Ein Spiegel verliert seinen Strom irgendwann mitten im Schreiben – ohne das
 * hier haette man danach eine halbe config.json und einen Spiegel, der nicht
 * mehr startet.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
