import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultConfig,
  isLocalOutletHost,
  normalizeOutlet,
  normalizeOutletHost,
} from '../dist/config.js';
import { assertValidManifest } from '../dist/manifest.js';

test('Adresse: was im Netz erreichbar ist, bleibt stehen', () => {
  assert.equal(normalizeOutletHost('192.168.1.60'), '192.168.1.60');
  assert.equal(normalizeOutletHost('  192.168.1.60  '), '192.168.1.60');
  assert.equal(normalizeOutletHost('steckdose.local'), 'steckdose.local');
  assert.equal(normalizeOutletHost('192.168.1.60:8080'), '192.168.1.60:8080');
});

test('Adresse: aus der Adresszeile kopiert, ist trotzdem eine Adresse', () => {
  // Genau das passiert, wenn jemand die Dose im Browser aufruft und den Link
  // aus der Zeile holt.
  assert.equal(normalizeOutletHost('http://192.168.1.60/'), '192.168.1.60');
  assert.equal(normalizeOutletHost('http://192.168.1.60/report'), '192.168.1.60');
});

test('Adresse: alles andere wird zu nichts', () => {
  // Ein halb verstandener Wert waere schlimmer als ein leeres Feld: er sieht
  // eingerichtet aus und schaltet nie.
  assert.equal(normalizeOutletHost('192.168.1.60 und die andere'), '');
  assert.equal(normalizeOutletHost('192.168.1.60:99999'), '');
  assert.equal(normalizeOutletHost(''), '');
  assert.equal(normalizeOutletHost(42), '');
});

test('ohne Adresse faellt der Schalter zurueck', () => {
  const outlet = normalizeOutlet({ enabled: true, host: '', scope: 'mirror' });
  assert.equal(outlet.enabled, false);
  assert.equal(outlet.scope, 'mirror');
});

test('ein unbekannter Umfang ist der harmlosere', () => {
  // "display" schaltet nur den Bildschirm. Wer die Datei von Hand editiert und
  // sich vertippt, soll nicht ploetzlich den Spiegel vom Strom nehmen.
  assert.equal(normalizeOutlet({ enabled: true, host: '10.0.0.5', scope: 'alles' }).scope, 'display');
});

test('voreingestellt ist keine Steckdose', () => {
  const config = createDefaultConfig();
  assert.deepEqual(config.power.outlet, { enabled: false, host: '', scope: 'display' });
});

test('private Netze gelten als eigenes Netz', () => {
  for (const host of ['192.168.1.60', '10.0.0.5', '172.16.0.1', '172.31.255.254', '127.0.0.1', '169.254.1.1']) {
    assert.equal(isLocalOutletHost(host), true, host);
  }
});

test('oeffentliche Adressen nicht', () => {
  // Der Spiegel darf nach draussen sprechen – aber nur zu Adressen, die im
  // Quelltext stehen. Diese hier tippt jemand ein.
  for (const host of ['8.8.8.8', '172.32.0.1', '93.184.216.34', 'example.com', 'evil.example.com']) {
    assert.equal(isLocalOutletHost(host), false, host);
  }
});

test('Namen aus dem Heimnetz gelten', () => {
  for (const host of ['steckdose', 'steckdose.local', 'dose.lan', 'dose.fritz.box', 'dose.home.arpa']) {
    assert.equal(isLocalOutletHost(host), true, host);
  }
});

test('der Port aendert nichts an der Herkunft', () => {
  assert.equal(isLocalOutletHost('192.168.1.60:8080'), true);
  assert.equal(isLocalOutletHost('example.com:80'), false);
});

test('krumme IPv4-Adressen zaehlen nicht als privat', () => {
  assert.equal(isLocalOutletHost('192.168.1.999'), false);
  assert.equal(isLocalOutletHost(''), false);
});

test('kein Modul kann den Eimer des Steckdosen-Tokens tragen', () => {
  // Der Token liegt im selben verschluesselten Speicher wie die
  // Modul-Geheimnisse, aber unter "core:power". Traegt diese Zusicherung
  // nicht mehr, koennte ein Modul ihn lesen – deshalb steht sie als Test da
  // und nicht nur als Kommentar.
  assert.throws(
    () => assertValidManifest({ id: 'core:power', name: 'x', version: '1.0.0' }, 'test'),
    /kebab-case/,
  );
});
