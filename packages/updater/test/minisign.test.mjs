import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { verifySignature } from '../dist/minisign.js';

/**
 * Baut Minisign-Artefakte nach der Formatspezifikation nach, damit die
 * Pruefung ohne installiertes minisign-Binary testbar ist.
 * Siehe https://jedisct1.github.io/minisign/
 */
function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = randomBytes(8);
  const pubFile = [
    'untrusted comment: minisign public key',
    Buffer.concat([Buffer.from('Ed'), keyId, rawPublic]).toString('base64'),
    '',
  ].join('\n');
  return { privateKey, keyId, pubFile };
}

function makeSignature({ privateKey, keyId }, content, trustedComment = 'timestamp:1 file:test.tar.gz') {
  const digest = createHash('blake2b512').update(content).digest();
  const signature = cryptoSign(null, digest, privateKey);
  const globalSignature = cryptoSign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
  return [
    'untrusted comment: signature from minisign secret key',
    Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
}

test('akzeptiert eine gueltige Signatur', () => {
  const keys = makeKeypair();
  const content = Buffer.from('das ist ein release-archiv');
  const result = verifySignature(content, makeSignature(keys, content), keys.pubFile);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.trustedComment, 'timestamp:1 file:test.tar.gz');
});

test('lehnt veraenderten Inhalt ab', () => {
  const keys = makeKeypair();
  const content = Buffer.from('das ist ein release-archiv');
  const signature = makeSignature(keys, content);
  const tampered = Buffer.from('das ist ein BOESES release-archiv');
  const result = verifySignature(tampered, signature, keys.pubFile);
  assert.equal(result.ok, false);
  assert.match(result.reason, /passt nicht zum Inhalt/);
});

test('lehnt einen veraenderten trusted comment ab', () => {
  const keys = makeKeypair();
  const content = Buffer.from('inhalt');
  const signature = makeSignature(keys, content).replace(
    'trusted comment: timestamp:1 file:test.tar.gz',
    'trusted comment: timestamp:1 file:harmlos.tar.gz',
  );
  const result = verifySignature(content, signature, keys.pubFile);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Globale Signatur/);
});

test('lehnt die Signatur eines fremden Schluessels ab', () => {
  const mine = makeKeypair();
  const attacker = makeKeypair();
  const content = Buffer.from('inhalt');
  const result = verifySignature(content, makeSignature(attacker, content), mine.pubFile);
  assert.equal(result.ok, false);
  assert.match(result.reason, /anderen Schluessel/);
});

test('lehnt eine Signatur ab, die nur die Key-ID faelscht', () => {
  // Angreifer signiert mit eigenem Schluessel, gibt aber die richtige Key-ID an.
  const mine = makeKeypair();
  const attacker = { ...makeKeypair(), keyId: mine.keyId };
  const content = Buffer.from('inhalt');
  const result = verifySignature(content, makeSignature(attacker, content), mine.pubFile);
  assert.equal(result.ok, false);
  assert.match(result.reason, /passt nicht zum Inhalt/);
});

test('lehnt eine unvollstaendige Signaturdatei ab', () => {
  const keys = makeKeypair();
  const result = verifySignature(Buffer.from('x'), 'untrusted comment: nur eine zeile\n', keys.pubFile);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unvollstaendig/);
});
