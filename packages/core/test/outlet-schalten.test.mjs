import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createDefaultConfig } from '@mirror/sdk';
import { PowerController } from '../dist/power.js';

/**
 * Eine Steckdose zum Anfassen: sie merkt sich ihr Relais und zaehlt mit, wie
 * oft geschaltet wurde.
 */
async function fakeSwitch() {
  const state = { relay: true, switches: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://dose');
    if (url.pathname === '/relay') {
      state.relay = url.searchParams.get('state') === '1';
      state.switches += 1;
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ power: 8.2, relay: state.relay }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.host = `127.0.0.1:${server.address().port}`;
  state.close = async () => {
    server.close();
    await once(server, 'close');
  };
  return state;
}

/**
 * Zwei Zeitplaene, die von der Uhr unabhaengig sind: ohne Regeln ist immer an,
 * eine Regel ohne Wochentage trifft nie zu und heisst damit immer aus.
 */
const configFor = (dose, scope, on) => {
  const config = createDefaultConfig();
  config.power.scheduleEnabled = true;
  config.power.rules = on ? [] : [{ id: 'nie', days: [], on: '00:00', off: '23:59' }];
  config.power.outlet = { enabled: true, host: dose.host, scope };
  return config;
};

/** Wartet, bis etwas eintritt – die Steckdose wird nebenlaeufig bedient. */
async function bis(bedingung, was) {
  for (let versuch = 0; versuch < 200; versuch += 1) {
    if (bedingung()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(was);
}

test('haengt der Bildschirm daran, folgt die Dose dem Zeitplan in beide Richtungen', async () => {
  const dose = await fakeSwitch();
  const power = new PowerController(configFor(dose, 'display', true));
  try {
    await power.start();
    await bis(() => power.outletStatus.reachable, 'Die Steckdose haette antworten muessen.');
    assert.equal(dose.relay, true);

    power.onConfigChange(configFor(dose, 'display', false));
    await bis(() => dose.relay === false, 'Der Zeitplan haette die Dose ausschalten muessen.');

    power.onConfigChange(configFor(dose, 'display', true));
    await bis(() => dose.relay === true, 'Der Zeitplan haette die Dose wieder einschalten muessen.');
  } finally {
    power.stop();
    await dose.close();
  }
});

test('haengt der Spiegel selbst daran, schaltet nur der Zeitplan ihn aus', async () => {
  const dose = await fakeSwitch();
  const power = new PowerController(configFor(dose, 'mirror', true));
  try {
    await power.start();
    await bis(() => power.outletStatus.reachable, 'Die Steckdose haette antworten muessen.');

    // Ein Griff ans Handy darf den Spiegel nicht vom Strom nehmen: dieselbe
    // App bekaeme ihn danach nicht wieder an.
    await power.setManual(false);
    assert.equal(dose.relay, true);
    assert.equal(dose.switches, 0);

    // Der Zeitplan darf es – das ist der Sinn der Einstellung.
    power.onConfigChange(configFor(dose, 'mirror', false));
    await bis(() => dose.relay === false, 'Der Zeitplan haette die Dose ausschalten muessen.');
  } finally {
    power.stop();
    await dose.close();
  }
});

test('wer waehrend eines Aus-Fensters einschaltet, bleibt an', async () => {
  // Sonst entstuende die Schleife: einschalten, hochfahren, sich sofort selbst
  // wieder abschalten – und der Spiegel waere nie zu sehen.
  const dose = await fakeSwitch();
  const power = new PowerController(configFor(dose, 'mirror', false));
  try {
    await power.start();
    await bis(() => power.outletStatus.checkedAt !== null, 'Die Steckdose haette antworten muessen.');
    assert.equal(power.isOn, false);
    assert.equal(dose.relay, true);
    assert.equal(dose.switches, 0);
  } finally {
    power.stop();
    await dose.close();
  }
});

test('eine unerreichbare Dose haelt den Spiegel nicht auf', async () => {
  const config = createDefaultConfig();
  config.power.outlet = { enabled: true, host: '127.0.0.1:1', scope: 'display' };
  const power = new PowerController(config);
  try {
    await power.start();
    await bis(() => power.outletStatus.error !== null, 'Der Fehler haette in der App stehen muessen.');
    assert.equal(power.outletStatus.reachable, false);
    // Das Display leuchtet trotzdem – die Dose ist eine Zugabe, keine Bedingung.
    assert.equal(power.isOn, true);
  } finally {
    power.stop();
  }
});
