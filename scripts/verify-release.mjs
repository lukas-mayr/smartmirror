#!/usr/bin/env node
/**
 * Prueft ein signiertes Release mit genau dem Code, den auch der Pi benutzt.
 *
 *   node scripts/verify-release.mjs <archiv> <archiv.minisig> <minisign.pub>
 *
 * Dieser Schritt laeuft in der CI direkt nach dem Signieren. Er ist die
 * Bruecke zwischen dem echten minisign-Werkzeug und unserer eigenen
 * Implementierung: weichen die beiden je voneinander ab, scheitert die
 * Veroeffentlichung hier – und nicht spaeter auf einem Spiegel, der sich dann
 * kein Update mehr installieren laesst.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { verifySignature } from '../packages/updater/dist/minisign.js';

const [archivePath, signaturePath, publicKeyPath, checksumPath] = process.argv.slice(2);

if (!archivePath || !signaturePath || !publicKeyPath) {
  console.error('Aufruf: verify-release.mjs <archiv> <archiv.minisig> <minisign.pub> [archiv.sha256]');
  process.exit(2);
}

const archive = await readFile(archivePath);
const signature = await readFile(signaturePath, 'utf8');
const publicKey = await readFile(publicKeyPath, 'utf8');

const result = verifySignature(archive, signature, publicKey);
if (!result.ok) {
  console.error(`Signaturpruefung fehlgeschlagen: ${result.reason}`);
  process.exit(1);
}
console.log(`Signatur gueltig  ·  ${result.trustedComment ?? '(kein trusted comment)'}`);

if (checksumPath) {
  const expected = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(archive).digest('hex');
  if (expected !== actual) {
    console.error(`Pruefsumme stimmt nicht:\n  erwartet ${expected}\n  erhalten ${actual}`);
    process.exit(1);
  }
  console.log(`Pruefsumme stimmt  ·  ${basename(archivePath)}`);
}

// Gegenprobe: eine veraenderte Datei muss abgelehnt werden. Ein Verifizierer,
// der immer "gueltig" sagt, ist schlimmer als gar keiner.
const tampered = Buffer.from(archive);
tampered[Math.floor(tampered.length / 2)] ^= 0xff;
if (verifySignature(tampered, signature, publicKey).ok) {
  console.error('Der Verifizierer akzeptiert manipulierte Daten – Veroeffentlichung abgebrochen.');
  process.exit(1);
}
console.log('Gegenprobe bestanden  ·  manipuliertes Archiv wird abgelehnt');
