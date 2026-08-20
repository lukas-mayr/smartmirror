import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MirrorConfig } from '@mirror/sdk';
import { downloadAsset, findAsset, findLatestRelease } from './github.js';
import { waitForHealthy } from './health.js';
import {
  activateRelease,
  extractRelease,
  linkTarget,
  parseChecksumFile,
  pruneReleases,
  restartServices,
  rollback,
  sha256Hex,
} from './install.js';
import { verifySignature } from './minisign.js';
import {
  blocklistFile,
  configFile,
  currentLink,
  publicKeyFile,
  requestFile,
  tokenFile,
} from './paths.js';
import { isNewer } from './semver.js';
import { StatusWriter } from './status.js';

const HEALTHCHECK_TIMEOUT_MS = 90_000;
const NETWORK_TIMEOUT_MS = 10 * 60_000;
const DRY_RUN = process.env.MIRROR_DRY_RUN === '1';

function log(message: string): void {
  console.log(`${new Date().toISOString()} [updater] ${message}`);
}

interface UpdateRequest {
  action: 'check' | 'apply';
  version?: string;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function currentVersion(): Promise<string> {
  for (const base of [currentLink, join(currentLink, '..')]) {
    const file = join(base, 'VERSION');
    if (!existsSync(file)) continue;
    try {
      return (await readFile(file, 'utf8')).trim();
    } catch {
      // naechster Kandidat
    }
  }
  return '0.0.0';
}

async function main(): Promise<void> {
  const config = await readJson<MirrorConfig>(configFile);
  const blocked = (await readJson<string[]>(blocklistFile)) ?? [];
  const version = await currentVersion();
  const status = new StatusWriter(version, blocked);

  const request = await readJson<UpdateRequest>(requestFile);
  // Anfrage sofort abraeumen: sonst wiederholt der naechste Lauf sie endlos,
  // auch wenn dieser hier bereits daran gescheitert ist.
  if (request) await rm(requestFile, { force: true });

  if (!config?.update?.repository) {
    log('Kein Repository konfiguriert – nichts zu tun.');
    await status.set('idle', { lastCheck: new Date().toISOString() });
    return;
  }

  const explicitApply = request?.action === 'apply';
  if (!config.update.autoUpdate && !explicitApply) {
    log('Automatische Updates sind ausgeschaltet – pruefe nur.');
  }

  const controller = new AbortController();
  const networkTimeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  const token = existsSync(tokenFile) ? (await readFile(tokenFile, 'utf8')).trim() : process.env.MIRROR_GITHUB_TOKEN;

  try {
    await status.set('checking', { lastError: undefined });
    const release = await findLatestRelease(config.update.repository, config.update.channel, token, controller.signal);
    const checkedAt = new Date().toISOString();

    if (!release) {
      log('Keine passenden Releases gefunden.');
      await status.set('idle', { lastCheck: checkedAt });
      return;
    }

    log(`Aktuell installiert: ${version}, verfuegbar: ${release.version} (${config.update.channel}).`);

    if (!isNewer(release.version, version)) {
      await status.set('idle', { lastCheck: checkedAt, availableVersion: undefined });
      return;
    }
    if (blocked.includes(release.version)) {
      // Diese Version hat den Healthcheck schon einmal gerissen. Sie erneut zu
      // installieren wuerde den Spiegel in eine Update-Schleife schicken.
      log(`Version ${release.version} steht auf der Sperrliste – uebersprungen.`);
      await status.set('idle', { lastCheck: checkedAt, availableVersion: release.version });
      return;
    }

    await status.set('idle', { lastCheck: checkedAt, availableVersion: release.version });
    if (!config.update.autoUpdate && !explicitApply) return;
    if (request?.version && request.version !== release.version) {
      log(`Angefordert war ${request.version}, verfuegbar ist ${release.version} – breche ab.`);
      return;
    }

    /* ------------------------------ Herunterladen ----------------------------- */

    const archiveAsset = findAsset(release, '-arm64.tar.gz');
    const checksumAsset = findAsset(release, '-arm64.tar.gz.sha256');
    const signatureAsset = findAsset(release, '-arm64.tar.gz.minisig');
    if (!archiveAsset || !checksumAsset || !signatureAsset) {
      throw new Error('Release enthaelt nicht alle drei Dateien (Archiv, .sha256, .minisig)');
    }

    await status.set('downloading', { progress: 0 });
    log(`Lade ${archiveAsset.name} (${Math.round(archiveAsset.size / 1_048_576)} MB) …`);
    const archive = await downloadAsset(archiveAsset, token, controller.signal, (received, total) => {
      if (total > 0) void status.progress(received / total);
    });
    const checksumFile = (await downloadAsset(checksumAsset, token, controller.signal)).toString('utf8');
    const signatureFile = (await downloadAsset(signatureAsset, token, controller.signal)).toString('utf8');

    /* -------------------------------- Pruefen -------------------------------- */

    await status.set('verifying', { progress: undefined });

    const expectedHash = parseChecksumFile(checksumFile, archiveAsset.name);
    const actualHash = sha256Hex(archive);
    if (expectedHash !== actualHash) {
      throw new Error(`Pruefsumme stimmt nicht (erwartet ${expectedHash.slice(0, 12)}…, erhalten ${actualHash.slice(0, 12)}…)`);
    }
    log('Pruefsumme stimmt.');

    if (!existsSync(publicKeyFile)) {
      // Ohne hinterlegten Schluessel wird nicht installiert. Ein Update ohne
      // Signaturpruefung ist eine Fernsteuerung fuer jeden, der den Kanal
      // uebernimmt – das ist kein akzeptabler Rueckfall.
      throw new Error(`Kein oeffentlicher Schluessel unter ${publicKeyFile} – Installation abgelehnt`);
    }
    const publicKey = await readFile(publicKeyFile, 'utf8');
    const verification = verifySignature(archive, signatureFile, publicKey);
    if (!verification.ok) {
      throw new Error(`Signaturpruefung fehlgeschlagen: ${verification.reason}`);
    }
    log(`Signatur gueltig. ${verification.trustedComment ?? ''}`);

    /* ------------------------------ Installieren ------------------------------ */

    await status.set('installing');
    await extractRelease(archive, release.version);
    log(`Release ${release.version} entpackt.`);

    if (DRY_RUN) {
      log('Trockenlauf – kein Symlink-Wechsel, kein Neustart.');
      await status.set('idle', { availableVersion: release.version });
      return;
    }

    const { previous } = await activateRelease(release.version);
    log(`current zeigt jetzt auf ${release.version} (vorher: ${previous ?? 'nichts'}).`);

    await status.set('restarting', { currentVersion: release.version });
    await restartServices();

    /* -------------------------- Bewaehrung oder Rueckfall -------------------------- */

    const health = await waitForHealthy(release.version, HEALTHCHECK_TIMEOUT_MS, log);
    if (health.healthy) {
      const removed = await pruneReleases();
      if (removed.length > 0) log(`Alte Releases entfernt: ${removed.join(', ')}`);
      await status.set('idle', {
        currentVersion: release.version,
        availableVersion: undefined,
        progress: undefined,
        lastError: undefined,
      });
      log(`Update auf ${release.version} abgeschlossen.`);
      return;
    }

    log(`Healthcheck fehlgeschlagen: ${health.reason}. Rolle zurueck.`);
    const restored = await rollback();
    if (restored) {
      await restartServices();
      log(`Zurueckgerollt auf ${restored}.`);
    } else {
      log('Kein vorheriges Release vorhanden – kein Rueckfall moeglich.');
    }

    const nextBlocklist = [...new Set([...blocked, release.version])];
    await writeFile(blocklistFile, `${JSON.stringify(nextBlocklist, null, 2)}\n`, 'utf8');

    await status.set('rolled-back', {
      currentVersion: await currentVersion(),
      blocked: nextBlocklist,
      lastError: `Update auf ${release.version} zurueckgerollt: ${health.reason}`,
      progress: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Fehler: ${message}`);
    await status.set('error', { lastError: message, progress: undefined });
    process.exitCode = 1;
  } finally {
    clearTimeout(networkTimeout);
  }
}

await main();
