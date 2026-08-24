import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_ATTRIBUTE, isHolding, setHold } from '../dist/hold.js';

/** Ein Host-Element, soweit die Bitte davon Gebrauch macht. */
const host = () => ({ dataset: {} });

test('setzt die Bitte und nimmt sie zurueck', () => {
  const element = host();
  assert.equal(isHolding(element), false);
  setHold(element, true);
  assert.equal(element.dataset[HOLD_ATTRIBUTE], '1');
  assert.equal(isHolding(element), true);
  setHold(element, false);
  assert.equal(HOLD_ATTRIBUTE in element.dataset, false);
  assert.equal(isHolding(element), false);
});

test('schreibt nur, wenn sich etwas aendert', () => {
  /*
   * Die Anzeige hoert auf Aenderungen dieses Attributs. Ein Modul, das
   * viermal je Sekunde zeichnet, wuerde ihr sonst viermal je Sekunde dieselbe
   * Nachricht schicken – und ein Screen-Timer, der dabei jedes Mal neu
   * gestellt wird, laeuft nie ab.
   */
  const writes = [];
  const element = {
    dataset: new Proxy({}, {
      set(target, key, value) {
        writes.push(['set', key]);
        return Reflect.set(target, key, value);
      },
      deleteProperty(target, key) {
        writes.push(['delete', key]);
        return Reflect.deleteProperty(target, key);
      },
    }),
  };

  setHold(element, true);
  setHold(element, true);
  setHold(element, true);
  setHold(element, false);
  setHold(element, false);

  assert.deepEqual(writes, [['set', HOLD_ATTRIBUTE], ['delete', HOLD_ATTRIBUTE]]);
});

test('ein fremder Wert im Attribut haelt nichts an', () => {
  // Nur "1" zaehlt: sonst hielte ein Modul, das dort irgendetwas ablegt, den
  // Spiegel versehentlich fest.
  assert.equal(isHolding({ dataset: { [HOLD_ATTRIBUTE]: '' } }), false);
  assert.equal(isHolding({ dataset: { [HOLD_ATTRIBUTE]: 'true' } }), false);
});
