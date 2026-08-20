import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Minisign-Signaturpruefung, in reinem Node umgesetzt.
 *
 * Warum ueberhaupt Signaturen: Ohne sie genuegt es, das GitHub-Konto zu
 * uebernehmen oder DNS zu manipulieren, um beliebigen Code auf dem Pi
 * auszufuehren – ein Geraet mit Kamerablick auf das Badezimmer. Eine
 * Pruefsumme allein hilft nicht, weil sie aus derselben Quelle kommt wie die
 * Datei.
 *
 * Warum nicht das minisign-Binary aufrufen: Der Updater soll ohne zusaetzliche
 * apt-Pakete auskommen. Node bringt Ed25519 und BLAKE2b mit, mehr braucht es
 * fuer das Format nicht.
 *
 * Format (https://jedisct1.github.io/minisign/):
 *   Zeile 2 der .minisig  = base64( alg[2] || key_id[8] || signature[64] )
 *   Zeile 4 der .minisig  = base64( global_signature[64] ) ueber signature || trusted_comment
 *   Zeile 2 der .pub      = base64( alg[2] || key_id[8] || public_key[32] )
 */

export interface MinisignVerifyResult {
  ok: boolean;
  reason?: string;
  trustedComment?: string;
}

interface PublicKey {
  keyId: Buffer;
  key: Buffer;
}

export function parsePublicKey(content: string): PublicKey {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const payload = lines[lines.length - 1];
  if (!payload) throw new Error('Leerer Public Key');
  const raw = Buffer.from(payload.trim(), 'base64');
  if (raw.length !== 42) throw new Error(`Public Key hat unerwartete Laenge (${raw.length} statt 42)`);
  if (raw.subarray(0, 2).toString('utf8') !== 'Ed') {
    throw new Error('Nur Ed25519-Schluessel werden unterstuetzt');
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

export function verifySignature(
  fileContent: Buffer,
  signatureFile: string,
  publicKeyFile: string,
): MinisignVerifyResult {
  let publicKey: PublicKey;
  try {
    publicKey = parsePublicKey(publicKeyFile);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const lines = signatureFile.split(/\r?\n/);
  const signatureLine = lines[1]?.trim();
  const trustedCommentLine = lines[2] ?? '';
  const globalSignatureLine = lines[3]?.trim();

  if (!signatureLine || !globalSignatureLine) {
    return { ok: false, reason: 'Signaturdatei ist unvollstaendig' };
  }
  if (!trustedCommentLine.startsWith('trusted comment: ')) {
    return { ok: false, reason: 'Signaturdatei enthaelt keinen trusted comment' };
  }
  const trustedComment = trustedCommentLine.slice('trusted comment: '.length);

  const signatureBlob = Buffer.from(signatureLine, 'base64');
  if (signatureBlob.length !== 74) {
    return { ok: false, reason: `Signatur hat unerwartete Laenge (${signatureBlob.length} statt 74)` };
  }

  const algorithm = signatureBlob.subarray(0, 2).toString('utf8');
  const keyId = signatureBlob.subarray(2, 10);
  const signature = signatureBlob.subarray(10);

  if (!keyId.equals(publicKey.keyId)) {
    return {
      ok: false,
      reason: `Signatur stammt von einem anderen Schluessel (${keyId.toString('hex')} statt ${publicKey.keyId.toString('hex')})`,
    };
  }

  // "ED" = vorgehashter Inhalt (BLAKE2b-512), "Ed" = Rohinhalt.
  let message: Buffer;
  if (algorithm === 'ED') {
    message = createHash('blake2b512').update(fileContent).digest();
  } else if (algorithm === 'Ed') {
    message = fileContent;
  } else {
    return { ok: false, reason: `Unbekannter Signaturalgorithmus "${algorithm}"` };
  }

  const key = toEd25519PublicKey(publicKey.key);
  if (!cryptoVerify(null, message, key, signature)) {
    return { ok: false, reason: 'Signatur passt nicht zum Inhalt' };
  }

  // Der trusted comment ist nur dann vertrauenswuerdig, wenn auch die globale
  // Signatur stimmt – sonst koennte ihn jemand austauschen.
  const globalSignature = Buffer.from(globalSignatureLine, 'base64');
  const globalMessage = Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]);
  if (!cryptoVerify(null, globalMessage, key, globalSignature)) {
    return { ok: false, reason: 'Globale Signatur (trusted comment) ist ungueltig' };
  }

  return { ok: true, trustedComment };
}

/** Wickelt einen rohen 32-Byte-Ed25519-Schluessel in die von Node erwartete SPKI-Struktur. */
function toEd25519PublicKey(raw: Buffer) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: 'der',
    type: 'spki',
  });
}
