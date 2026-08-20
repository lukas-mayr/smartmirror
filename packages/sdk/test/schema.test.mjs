import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, defaultsOf } from '../dist/schema.js';

const clockSchema = {
  type: 'object',
  properties: {
    format24h: { type: 'boolean', default: true },
    showSeconds: { type: 'boolean', default: false },
    size: { type: 'string', enum: ['s', 'm', 'l'], default: 'l' },
    days: { type: 'integer', minimum: 0, maximum: 7, default: 4 },
  },
};

test('fuellt fehlende Felder mit Defaults', () => {
  const { value, valid } = validate(clockSchema, {});
  assert.equal(valid, true);
  assert.deepEqual(value, { format24h: true, showSeconds: false, size: 'l', days: 4 });
});

test('wandelt Formular-Strings in die richtigen Typen', () => {
  // Die Remote-Oberflaeche schickt HTML-Inputs; sie soll nicht selbst casten muessen.
  const { value } = validate(clockSchema, { format24h: 'false', days: '5' });
  assert.equal(value.format24h, false);
  assert.equal(value.days, 5);
});

test('begrenzt Zahlen auf den erlaubten Bereich', () => {
  assert.equal(validate(clockSchema, { days: 99 }).value.days, 7);
  assert.equal(validate(clockSchema, { days: -3 }).value.days, 0);
});

test('meldet unerlaubte Auswahlwerte', () => {
  const { valid, issues } = validate(clockSchema, { size: 'riesig' });
  assert.equal(valid, false);
  assert.match(issues[0].message, /keine erlaubte Auswahl/);
});

test('verwirft unbekannte Schluessel', () => {
  // Sonst sammelt die Konfiguration ueber Versionswechsel hinweg Altlasten an.
  const { value } = validate(clockSchema, { size: 'm', veralteterSchluessel: 'weg damit' });
  assert.equal('veralteterSchluessel' in value, false);
  assert.equal(value.size, 'm');
});

test('defaultsOf liefert das komplette Standardobjekt', () => {
  assert.deepEqual(defaultsOf(clockSchema), { format24h: true, showSeconds: false, size: 'l', days: 4 });
});

test('meldet fehlende Pflichtfelder', () => {
  const schema = { type: 'object', properties: { ort: { type: 'string' } }, required: ['ort'] };
  const { valid, issues } = validate(schema, {});
  assert.equal(valid, false);
  assert.match(issues[0].message, /Pflichtfeld/);
});
