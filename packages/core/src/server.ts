import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  isClientMessage,
  isZone,
  type ClientMessage,
  type ClientType,
  type ErrorCode,
  type ServerMessage,
} from '@mirror/sdk';
import type { WebSocket } from 'ws';
import type { AuthStore } from './auth.js';
import type { ConfigStore } from './config-store.js';
import type { ModuleHost } from './module-host.js';
import type { PowerController } from './power.js';
import type { SecretStore } from './secrets.js';
import type { UpdateBridge } from './update-bridge.js';
import { createLogger } from './logger.js';
import { appVersion, remoteDistDir } from './paths.js';

const log = createLogger('server');

interface Client {
  socket: WebSocket;
  type: ClientType;
  authenticated: boolean;
  /** Loopback-Verbindungen sind die Anzeige auf demselben Geraet. */
  local: boolean;
  appVersion: string;
}

export interface ServerDeps {
  config: ConfigStore;
  modules: ModuleHost;
  secrets: SecretStore;
  auth: AuthStore;
  power: PowerController;
  updates: UpdateBridge;
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const clients = new Set<Client>();
  /**
   * Hat sich mindestens eine Anzeige gemeldet, die tatsaechlich Inhalte
   * rendert? Der Updater haengt seinen Healthcheck daran: ein Update, nach dem
   * der Server zwar laeuft, der Spiegel aber schwarz bleibt, gilt als
   * gescheitert und wird zurueckgerollt.
   */
  let shellReady = false;

  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  /* ------------------------------ Hilfsfunktionen ----------------------------- */

  const send = (client: Client, message: ServerMessage): void => {
    if (client.socket.readyState !== 1) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch (error) {
      log.warn('Senden fehlgeschlagen', error);
    }
  };

  const broadcast = (message: ServerMessage, filter?: (client: Client) => boolean): void => {
    for (const client of clients) {
      if (filter && !filter(client)) continue;
      if (!client.authenticated) continue;
      send(client, message);
    }
  };

  const fail = (client: Client, code: ErrorCode, message: string): void =>
    send(client, { t: 'error', code, message });

  const snapshotFor = (client: Client): ServerMessage => ({
    t: 'snapshot',
    config: deps.config.current,
    modules: deps.modules.descriptors(),
    state: deps.modules.snapshot(),
    power: { on: deps.power.isOn },
    update: deps.updates.status,
  });

  const pushConfig = (): void => {
    broadcast({ t: 'config:update', config: deps.config.current });
    broadcast({ t: 'modules:update', modules: deps.modules.descriptors() });
  };

  /* --------------------------- Ereignisse der Dienste -------------------------- */

  deps.modules.on('state', (envelope) => broadcast({ t: 'state:patch', envelope }));
  deps.power.on('change', (on: boolean) => broadcast({ t: 'display:power', on }));
  deps.updates.on('status', (status) => broadcast({ t: 'update:status', status }));

  deps.power.on('override', (override: { active: boolean; on: boolean } | null) => {
    void deps.config.update((draft) => {
      draft.power.manualOverride = override;
    });
  });

  deps.config.on('change', () => {
    pushConfig();
    void deps.modules.sync(deps.config.current);
    deps.power.onConfigChange(deps.config.current);
  });

  /* ---------------------------------- Routen ---------------------------------- */

  app.get('/healthz', async () => ({
    ok: true,
    version: appVersion(),
    shellReady,
    modules: deps.modules.descriptors().length,
    clients: clients.size,
    display: deps.power.isOn ? 'on' : 'off',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  // Modul-Frontends werden zur Laufzeit ausgeliefert, nicht in die Anzeige
  // einkompiliert. Nur so kann ein neues Modul dazukommen, ohne die Shell neu
  // zu bauen – genau das ist der Sinn eines Modulsystems.
  app.get<{ Params: { id: string } }>('/modules/:id/frontend.js', async (request, reply) => {
    const file = deps.modules.frontendFileFor(request.params.id);
    if (!file || !existsSync(file)) {
      return reply.code(404).send({ error: `Kein Frontend fuer Modul "${request.params.id}"` });
    }
    const body = await readFile(file, 'utf8');
    return reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      // Die Anzeige laedt ihre Oberflaeche aus dem App-Bundle und die Module
      // von hier – also aus einer anderen Herkunft. Ohne CORS lehnt der
      // Renderer den dynamischen Import ab.
      .header('Access-Control-Allow-Origin', '*')
      .send(body);
  });

  if (existsSync(remoteDistDir)) {
    await app.register(fastifyStatic, { root: remoteDistDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/modules')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    log.warn(`PWA-Bundle fehlt (${remoteDistDir}) – Server laeuft ohne Oberflaeche.`);
  }

  /* -------------------------------- WebSocket -------------------------------- */

  app.get('/ws', { websocket: true }, (socket, request) => {
    const address = request.socket.remoteAddress ?? '';
    const client: Client = {
      socket,
      type: 'remote',
      authenticated: false,
      local: address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
      appVersion: 'unbekannt',
    };
    clients.add(client);

    socket.on('close', () => {
      clients.delete(client);
      if (client.type === 'shell') {
        log.info('Anzeige hat die Verbindung getrennt.');
        shellReady = [...clients].some((candidate) => candidate.type === 'shell' && candidate.authenticated);
      }
    });
    socket.on('error', (error: Error) => log.warn('WebSocket-Fehler', error.message));

    socket.on('message', (raw: Buffer) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(client, 'bad-request', 'Kein gueltiges JSON');
      }
      if (!isClientMessage(message)) return fail(client, 'bad-request', 'Unbekanntes Nachrichtenformat');
      void handleMessage(client, message).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        log.error(`Nachricht "${message.t}" fehlgeschlagen: ${text}`);
        fail(client, 'internal', text);
      });
    });
  });

  async function handleMessage(client: Client, message: ClientMessage): Promise<void> {
    /* --- Nachrichten, die ohne Anmeldung erlaubt sind --- */
    if (message.t === 'ping') return send(client, { t: 'pong' });

    if (message.t === 'hello') {
      client.type = message.clientType === 'shell' ? 'shell' : 'remote';
      client.appVersion = message.appVersion;

      // Die Anzeige laeuft auf demselben Geraet wie der Server. Sie zu koppeln
      // waere ein Ritual ohne Sicherheitsgewinn: wer auf dem Pi Prozesse
      // starten kann, hat den Spiegel ohnehin.
      client.authenticated = client.type === 'shell' && client.local ? true : deps.auth.verify(message.token);

      if (!client.authenticated) {
        const pending = deps.auth.pendingCode ?? deps.auth.startPairing();
        send(client, { t: 'welcome', serverVersion: appVersion(), authenticated: false, needsPairing: true });
        // Der Code erscheint auf dem Spiegel – nur wer davorsteht, kann koppeln.
        broadcast(
          { t: 'pair:code', code: pending.code, expiresAt: pending.expiresAt.toISOString() },
          (candidate) => candidate.type === 'shell',
        );
        return;
      }

      send(client, { t: 'welcome', serverVersion: appVersion(), authenticated: true, needsPairing: false });
      send(client, snapshotFor(client));
      if (client.type === 'shell') log.info(`Anzeige verbunden (v${message.appVersion}).`);
      return;
    }

    if (message.t === 'pair:request') {
      const token = await deps.auth.redeem(message.code, message.clientName);
      if (!token) return fail(client, 'pairing-failed', 'Code ist falsch oder abgelaufen');
      client.authenticated = true;
      send(client, { t: 'pair:result', ok: true, token });
      send(client, snapshotFor(client));
      // Code vom Spiegel nehmen – er ist verbraucht.
      broadcast({ t: 'pair:code', code: '', expiresAt: new Date(0).toISOString() }, (c) => c.type === 'shell');
      return;
    }

    if (!client.authenticated) return fail(client, 'unauthorized', 'Nicht gekoppelt');

    /* --- Ab hier nur angemeldete Clients --- */
    switch (message.t) {
      case 'shell:ready':
        // Signal fuer den Healthcheck des Updaters: die Anzeige rendert.
        shellReady = true;
        log.info(`Anzeige meldet Bereitschaft (v${message.appVersion}).`);
        return;

      case 'command':
        await deps.modules.dispatchCommand(message.instanceId, message.name, message.payload);
        return;

      case 'admin:setInstanceConfig':
        await deps.config.update((draft) => {
          const instance = draft.instances.find((entry) => entry.id === message.instanceId);
          if (!instance) throw new Error(`Instanz "${message.instanceId}" existiert nicht`);
          instance.config = message.config;
        });
        return;

      case 'admin:setLayout':
        await deps.config.update((draft) => {
          for (const update of message.instances) {
            const instance = draft.instances.find((entry) => entry.id === update.id);
            if (!instance) continue;
            if (isZone(update.zone)) instance.zone = update.zone;
            if (Number.isFinite(update.order)) instance.order = update.order;
            if (typeof update.enabled === 'boolean') instance.enabled = update.enabled;
          }
        });
        return;

      case 'admin:addInstance': {
        const descriptor = deps.modules.descriptors().find((entry) => entry.id === message.moduleId);
        if (!descriptor) return fail(client, 'not-found', `Modul "${message.moduleId}" unbekannt`);
        await deps.config.update((draft) => {
          if (descriptor.singleton && draft.instances.some((entry) => entry.moduleId === descriptor.id)) {
            throw new Error(`Von "${descriptor.id}" ist nur eine Instanz erlaubt`);
          }
          const zone = isZone(message.zone) ? message.zone : 'top-center';
          draft.instances.push({
            id: nextInstanceId(draft.instances.map((entry) => entry.id), descriptor.id),
            moduleId: descriptor.id,
            zone,
            order: draft.instances.filter((entry) => entry.zone === zone).length,
            enabled: true,
            config: {},
          });
        });
        return;
      }

      case 'admin:removeInstance':
        await deps.config.update((draft) => {
          draft.instances = draft.instances.filter((entry) => entry.id !== message.instanceId);
        });
        return;

      case 'admin:setSettings':
        await deps.config.update((draft) => {
          Object.assign(draft, message.patch);
        });
        return;

      case 'admin:setSecret':
        await deps.secrets.set(message.moduleId, message.key, message.value);
        broadcast({ t: 'modules:update', modules: deps.modules.descriptors() });
        // Module lesen ihre Geheimnisse beim Start – also neu starten.
        await deps.modules.sync(deps.config.current);
        return;

      case 'admin:power':
        await deps.power.setManual(message.on);
        return;

      case 'admin:checkUpdate':
        await deps.updates.requestCheck();
        return;

      case 'admin:applyUpdate':
        await deps.updates.requestApply(message.version);
        return;

      default:
        return fail(client, 'bad-request', `Unbekannte Nachricht "${(message as { t: string }).t}"`);
    }
  }

  return app;
}

function nextInstanceId(existing: string[], moduleId: string): string {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${moduleId}-${index}`;
    if (!existing.includes(candidate)) return candidate;
  }
  throw new Error('Keine freie Instanz-ID gefunden');
}
