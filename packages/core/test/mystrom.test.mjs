import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OutletError, readReport, setRelay } from '../dist/mystrom.js';

/** Eine Steckdose, die nur so viel kann wie das Original. */
async function fakeSwitch(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    host: `127.0.0.1:${server.address().port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

/** Die Antworten der echten Firmware: /report als JSON, /relay ohne Inhalt. */
function switchLike(state) {
  return (req, res) => {
    const url = new URL(req.url, 'http://dose');
    if (url.pathname === '/relay') {
      state.relay = url.searchParams.get('state') === '1';
      res.writeHead(200);
      res.end();
      return;
    }
    if (url.pathname === '/report') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ power: state.watts, Ws: 0, relay: state.relay, temperature: 22.44 }));
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

test('liest Relais und Leistung', async () => {
  const state = { relay: true, watts: 12.34 };
  const dose = await fakeSwitch(switchLike(state));
  try {
    const report = await readReport(dose.host);
    assert.deepEqual(report, { relay: true, watts: 12.3, temperature: 22.4 });
  } finally {
    await dose.close();
  }
});

test('schaltet und liest danach nach', async () => {
  const state = { relay: true, watts: 0 };
  const dose = await fakeSwitch(switchLike(state));
  try {
    const report = await setRelay(dose.host, false);
    assert.equal(state.relay, false);
    assert.equal(report.relay, false);
  } finally {
    await dose.close();
  }
});

test('ein Schaltbefehl, der nichts bewirkt, gilt nicht als erledigt', async () => {
  // /relay antwortet ohne Inhalt – ohne das Nachlesen waere jeder Befehl nur
  // eine Behauptung, und die App zeigte "geschaltet" bei einem toten Relais.
  const dose = await fakeSwitch((req, res) => {
    if (new URL(req.url, 'http://dose').pathname === '/report') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ power: 0, relay: true }));
      return;
    }
    res.writeHead(200);
    res.end();
  });
  try {
    await assert.rejects(() => setRelay(dose.host, false), OutletError);
  } finally {
    await dose.close();
  }
});

test('hinter der Adresse sitzt etwas anderes', async () => {
  const dose = await fakeSwitch((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>Router</html>');
  });
  try {
    await assert.rejects(() => readReport(dose.host), /keine myStrom-Steckdose/);
  } finally {
    await dose.close();
  }
});

test('ohne Adresse wird gar nicht erst gefragt', async () => {
  await assert.rejects(() => readReport(''), /keine Adresse/);
});

test('nach draussen geht ueber diesen Weg nichts', async () => {
  // Auch wenn eine oeffentliche Adresse in der Konfiguration steht: die Grenze
  // liegt im Client und nicht im Einstellungsformular.
  await assert.rejects(() => readReport('example.com'), /eigenen Netz/);
  await assert.rejects(() => setRelay('93.184.216.34', true), /eigenen Netz/);
});

test('der Token geht als Kopfzeile mit', async () => {
  let gesehen = null;
  const dose = await fakeSwitch((req, res) => {
    gesehen = req.headers.token ?? null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ power: 0, relay: true }));
  });
  try {
    await readReport(dose.host, 'geheim');
    assert.equal(gesehen, 'geheim');
    await readReport(dose.host);
    assert.equal(gesehen, null);
  } finally {
    await dose.close();
  }
});

test('eine geschuetzte Dose fragt nach dem Token, statt zum Abschalten zu raten', async () => {
  const dose = await fakeSwitch((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  try {
    await assert.rejects(() => readReport(dose.host), /verlangt einen Token/);
    await assert.rejects(() => readReport(dose.host, 'falsch'), /weist den hinterlegten Token zurueck/);
  } finally {
    await dose.close();
  }
});
