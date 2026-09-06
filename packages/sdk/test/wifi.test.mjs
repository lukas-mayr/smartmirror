import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPassphrase,
  isValidSsid,
  normalizeNetwork,
  normalizeWifiStatus,
} from '../dist/wifi.js';

/*
 * Der WLAN-Bericht kommt aus einem Shell-Skript und nicht aus dem Typsystem.
 * Was dort steht, wird deshalb hier auf die Form gebracht statt geglaubt – eine
 * halb geschriebene oder aeltere Fassung soll die App weniger zeigen lassen und
 * nicht durcheinanderbringen.
 */

const jetzt = '2026-01-01T12:00:00.000Z';

test('ohne Zeitstempel ist es kein Bericht', () => {
  assert.equal(normalizeWifiStatus(null), null);
  assert.equal(normalizeWifiStatus({ state: 'online' }), null);
  assert.equal(normalizeWifiStatus('kaputt'), null);
});

test('ein unbekannter Zustand gilt als "nichts zu steuern"', () => {
  // Lieber gar keine WLAN-Karte in der App als eine, die nichts bewirkt.
  assert.equal(normalizeWifiStatus({ updatedAt: jetzt, state: 'erfunden' }).state, 'unavailable');
  assert.equal(normalizeWifiStatus({ updatedAt: jetzt }).state, 'unavailable');
});

test('sortiert die Netze nach Signalstaerke', () => {
  const status = normalizeWifiStatus({
    updatedAt: jetzt,
    state: 'offline',
    networks: [
      { ssid: 'Weit weg', signal: 22, secured: true },
      { ssid: 'Heimnetz', signal: 88, secured: true, known: true },
      { ssid: 'Nachbar', signal: 55, secured: true },
    ],
  });
  // Die Liste wird auf einem Handy gelesen, das jemand vor dem Spiegel haelt:
  // das eigene Netz ist fast immer das staerkste.
  assert.deepEqual(status.networks.map((netz) => netz.ssid), ['Heimnetz', 'Nachbar', 'Weit weg']);
  assert.equal(status.networks[0].known, true);
});

test('wirft namenlose und doppelte Netze weg', () => {
  const status = normalizeWifiStatus({
    updatedAt: jetzt,
    state: 'offline',
    networks: [
      { ssid: 'Heimnetz', signal: 80 },
      // Zwei Zugangspunkte, ein Netz. Gezaehlt wird das Netz.
      { ssid: 'Heimnetz', signal: 40 },
      // Ein verstecktes Netz meldet sich ohne Namen – es liesse sich weder
      // antippen noch benennen.
      { ssid: '', signal: 70 },
      { signal: 70 },
      'kein Objekt',
    ],
  });
  assert.deepEqual(status.networks.map((netz) => netz.ssid), ['Heimnetz']);
  assert.equal(status.networks[0].signal, 80);
});

test('begrenzt die Signalstaerke auf einen Prozentwert', () => {
  const status = normalizeWifiStatus({ updatedAt: jetzt, state: 'online', signal: 480 });
  assert.equal(status.signal, 100);
  assert.equal(normalizeWifiStatus({ updatedAt: jetzt, signal: 'viel' }).signal, null);
});

test('ein Einrichtungs-WLAN ohne Namen ist keines', () => {
  assert.equal(normalizeWifiStatus({ updatedAt: jetzt, hotspot: { active: true } }).hotspot, null);
  const status = normalizeWifiStatus({
    updatedAt: jetzt,
    hotspot: { active: true, ssid: 'Smartmirror-ab12', passphrase: 'kurzpass' },
  });
  // Ohne Adresse waere es nicht zu erreichen; die vergibt NetworkManager fest.
  assert.equal(status.hotspot.address, '10.42.0.1');
});

test('normalizeNetwork laesst das Einrichtungs-WLAN an, solange niemand widerspricht', () => {
  // Der Fall, in dem es hilft, ist genau der, in dem niemand es mehr
  // einschalten koennte.
  assert.equal(normalizeNetwork(undefined).setupHotspot, true);
  assert.equal(normalizeNetwork({}).setupHotspot, true);
  assert.equal(normalizeNetwork({ setupHotspot: false }).setupHotspot, false);
});

test('ein Netzname hat 1 bis 32 Byte und keine Steuerzeichen', () => {
  assert.equal(isValidSsid('Heimnetz'), true);
  assert.equal(isValidSsid(''), false);
  assert.equal(isValidSsid('a'.repeat(33)), false);
  // Umlaute zaehlen doppelt: die Grenze steht in Byte und nicht in Zeichen.
  assert.equal(isValidSsid('ä'.repeat(17)), false);
  assert.equal(isValidSsid('ä'.repeat(16)), true);
  // Eine neue Zeile waere in der Profildatei, die daraus entsteht, eine neue
  // Einstellung.
  assert.equal(isValidSsid('Heim\nautoconnect=false'), false);
  assert.equal(isValidSsid(42), false);
});

test('ein WLAN-Passwort hat 8 bis 63 Zeichen – oder ist gar keines', () => {
  assert.equal(isValidPassphrase('geheim12'), true);
  assert.equal(isValidPassphrase('kurz'), false);
  assert.equal(isValidPassphrase('x'.repeat(64)), false);
  // Genau 64 Hex-Zeichen sind der fertig gerechnete Schluessel.
  assert.equal(isValidPassphrase('a'.repeat(64)), true);
  // Leer heisst "offenes Netz" – oder "nimm das gespeicherte".
  assert.equal(isValidPassphrase(''), true);
  assert.equal(isValidPassphrase('geheim12\npsk=anders'), false);
});
