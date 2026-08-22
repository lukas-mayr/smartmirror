import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidManifest, hostAllowed, MODULE_PERMISSIONS } from '../dist/manifest.js';

const modulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'modules');

/* ----------------------------- Die echten Module --------------------------- */

/*
 * Der wichtigste Test dieser Datei.
 *
 * Ein Manifest wird erst beim Laden geprueft, also auf dem Spiegel und nicht
 * beim Uebersetzen: ein neues Recht im Typ, das der Validator nicht kennt,
 * faellt sonst niemandem auf, bis das Modul am Pi nicht startet. Genau das ist
 * einmal passiert.
 */
test('jedes mitgelieferte Modul hat ein gueltiges Manifest', () => {
  const names = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(modulesDir, name, 'module.json')));

  assert.ok(names.length > 0, 'keine Module gefunden – stimmt der Pfad?');
  for (const name of names) {
    const file = join(modulesDir, name, 'module.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.doesNotThrow(() => assertValidManifest(manifest, file), `Manifest von "${name}"`);
  }
});

/* -------------------------------- Rechte ---------------------------------- */

const base = { id: 'test', name: 'Test', version: '1.0.0' };

test('kennt jedes Recht aus der Liste', () => {
  // Die Liste ist die einzige Quelle: was darin steht, muss der Validator
  // annehmen, sonst laufen Typ und Pruefung auseinander.
  for (const permission of MODULE_PERMISSIONS) {
    const manifest = {
      ...base,
      permissions: [permission],
      ...(permission === 'network' ? { network: { allow: ['example.com'] } } : {}),
    };
    assert.doesNotThrow(() => assertValidManifest(manifest, 'test'), permission);
  }
});

test('lehnt ein erfundenes Recht ab', () => {
  assert.throws(
    () => assertValidManifest({ ...base, permissions: ['alles'] }, 'test'),
    /unbekannte Permission "alles"/,
  );
});

/* ------------------------------ Host-Allowlist ----------------------------- */

test('verlangt zu "network" eine Quelle fuer die Allowlist', () => {
  assert.throws(
    () => assertValidManifest({ ...base, permissions: ['network'] }, 'test'),
    /Host-Allowlist/,
  );
  assert.throws(
    () => assertValidManifest({ ...base, permissions: ['network'], network: { allow: [] } }, 'test'),
    /Host-Allowlist/,
  );
});

test('laesst eine leere feste Liste zu, wenn Felder benannt sind', () => {
  // Ein Kalendermodul kennt seine Adressen nicht im Voraus – es benennt aber,
  // aus welchem Feld sie kommen, und das ist die verlangte Angabe.
  assert.doesNotThrow(() =>
    assertValidManifest(
      { ...base, permissions: ['network'], network: { allow: [], allowFromConfig: ['calendars'] } },
      'test',
    ),
  );
});

test('erlaubt genau die Hosts, die in der Konfiguration stehen', () => {
  const manifest = { ...base, network: { allow: [], allowFromConfig: ['calendars'] } };
  const config = {
    calendars: 'Familie | https://p42-calendars.icloud.com/published/2/abc\nhttps://gemeinde.ch/muell.ics',
  };
  assert.equal(hostAllowed(manifest, 'p42-calendars.icloud.com', config), true);
  assert.equal(hostAllowed(manifest, 'gemeinde.ch', config), true);
  // Was nicht eingetragen ist, bleibt zu – auch eine Nachbardomain.
  assert.equal(hostAllowed(manifest, 'boese.example', config), false);
  assert.equal(hostAllowed(manifest, 'p42-calendars.icloud.com', {}), false);
});

test('liest keine Felder, die das Manifest nicht benennt', () => {
  // Sonst koennte ein Modul sich ueber ein beliebiges Textfeld freischalten.
  const manifest = { ...base, network: { allow: [], allowFromConfig: ['calendars'] } };
  assert.equal(hostAllowed(manifest, 'example.com', { notizen: 'https://example.com/x' }), false);
});
