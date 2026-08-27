import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig, normalizeOutlet, normalizeOutletHost } from '../dist/config.js';

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
