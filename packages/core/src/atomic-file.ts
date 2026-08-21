import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Atomares Schreiben: erst in eine Temporaerdatei, fsync, dann rename, dann
 * das Verzeichnis synchronisieren.
 *
 * Ein Spiegel verliert seinen Strom irgendwann mitten im Schreiben – ohne das
 * hier haette man danach eine halbe config.json und einen Spiegel, der nicht
 * mehr startet. Beim Spiegel ist das kein Ausnahmefall: ausgeschaltet wird er
 * ueblicherweise am Stecker.
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

  await syncDirectory(dirname(file));
}

/**
 * Synchronisiert den Verzeichniseintrag.
 *
 * Der fsync oben sichert nur den *Inhalt* der Temporaerdatei. Dass sie danach
 * unter ihrem endgueltigen Namen zu finden ist, steht im Verzeichnis – und das
 * liegt bis hierher noch im Schreibpuffer. Ohne diesen Schritt kann nach einem
 * Stromausfall ein Eintrag auf eine Datei zeigen, die es so nie gab.
 */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Nicht jedes Dateisystem laesst ein Verzeichnis oeffnen oder
    // synchronisieren. Dann bleibt es beim geschriebenen Inhalt – immer noch
    // besser als gar kein Schreiben.
  }
}

/**
 * Liest JSON. Eine fehlende Datei ist kein Fehler – und eine unlesbare auch
 * nicht mehr.
 *
 * Bis hierher flog bei kaputtem JSON der Fehler bis in den Start des Core,
 * der Prozess endete mit Code 1, und systemd startete ihn alle drei Sekunden
 * neu: ein Spiegel, den eine einzige beschaedigte Datei dauerhaft schwarz
 * haelt. Ein Spiegel mit Standardwerten ist besser als keiner. Das Kaputte
 * wandert daneben und geht nicht verloren – es ist die einzige Kopie der
 * Einstellungen, und wer sie retten will, soll sie noch vorfinden.
 */
export async function readJson<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    await rename(file, `${file}.defekt`).catch(() => {});
    return null;
  }
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
