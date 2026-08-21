import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  clampScreenDuration,
  createScreen,
  defaultScreenName,
  findFreeSpot,
  isClientMessage,
  nearestWidgetSize,
  nextScreenId,
  normalizeWidgetSize,
  rectFor,
  withSetupStep,
  type ClientMessage,
  type ClientType,
  type ErrorCode,
  type MirrorConfig,
  type ServerMessage,
  type Viewport,
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

/**
 * Mehr Screens laufen niemandem mehr durch den Kopf, und die Runde dauerte bei
 * zwanzig Sekunden je Screen schon ueber drei Minuten.
 */
const MAX_SCREENS = 10;

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
  /**
   * Kantenlaengen der Buehne, wie die Anzeige sie zuletzt gemeldet hat. Nur
   * fuer die Handy-App: beim Ausrichten steht neben dem Prozentwert der
   * ungefaehre Pixelwert. Bewusst nicht in der Konfiguration – der Wert
   * beschreibt die Hardware von jetzt, nicht eine Einstellung.
   */
  let viewport: Viewport | null = null;
  /**
   * Screen, den die Anzeige gerade zeigen soll, weil am Handy daran gearbeitet
   * wird. Solange er gesetzt ist, schaltet der Spiegel nicht weiter.
   *
   * Wie `viewport` bewusst nicht in der Konfiguration: die Vorschau beschreibt
   * einen Moment und keine Einstellung. Bliebe sie in der Datei stehen, haenge
   * der Spiegel nach einem Stromausfall fuer immer auf einem Screen fest –
   * ohne dass jemand wuesste, warum.
   */
  let preview: { screenId: string; owner: Client } | null = null;
  let previewTimer: NodeJS.Timeout | null = null;
  /**
   * Nach dieser Zeit ohne neuen Wunsch schaltet der Spiegel wieder selbst
   * weiter. Ein Handy, das mit offener Modulseite in der Tasche verschwindet,
   * darf die Screens nicht dauerhaft anhalten.
   */
  const PREVIEW_TIMEOUT_MS = 5 * 60_000;

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
    viewport,
    previewScreenId: preview?.screenId ?? null,
  });

  /**
   * Setzt die Vorschau oder nimmt sie zurueck. Ein unbekannter Screen zaehlt
   * wie "keine Vorschau" – sonst zeigte die Anzeige nach dem Loeschen eines
   * Screens ins Leere.
   */
  const setPreview = (screenId: string | null, owner: Client | null): void => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;

    const next =
      screenId !== null && owner && deps.config.current.screens.some((screen) => screen.id === screenId)
        ? { screenId, owner }
        : null;
    const changed = (preview?.screenId ?? null) !== (next?.screenId ?? null);
    preview = next;

    if (next) {
      previewTimer = setTimeout(() => setPreview(null, null), PREVIEW_TIMEOUT_MS);
      // Der Timer darf den Prozess nicht am Leben halten.
      previewTimer.unref?.();
    }
    if (changed) broadcast({ t: 'display:previewScreen', screenId: next?.screenId ?? null });
  };

  const pushConfig = (): void => {
    broadcast({ t: 'config:update', config: deps.config.current });
    broadcast({ t: 'modules:update', modules: deps.modules.descriptors() });
  };

  /* --------------------------- Ereignisse der Dienste -------------------------- */

  deps.modules.on('state', (envelope) => broadcast({ t: 'state:patch', envelope }));
  // Ein Modul hat ein Geheimnis selbst hinterlegt – die Handy-App zeigt an,
  // welche schon da sind, und wuerde sonst weiter nach einem fragen.
  deps.modules.on('modules', () => broadcast({ t: 'modules:update', modules: deps.modules.descriptors() }));
  deps.power.on('change', (on: boolean) => broadcast({ t: 'display:power', on }));
  deps.updates.on('status', (status) => broadcast({ t: 'update:status', status }));

  deps.power.on('override', (override: { active: boolean; on: boolean } | null) => {
    void deps.config.update((draft) => {
      draft.power.manualOverride = override;
    });
  });

  deps.config.on('change', () => {
    // Der vorgemerkte Screen kann gerade geloescht worden sein.
    if (preview && !deps.config.current.screens.some((screen) => screen.id === preview?.screenId)) {
      setPreview(null, null);
    }
    pushConfig();
    void deps.modules.sync(deps.config.current);
    deps.power.onConfigChange(deps.config.current);
  });

  /**
   * Bringt die gespeicherten Blockgroessen mit dem in Einklang, was die Module
   * anbieten.
   *
   * Noetig, weil die Groesse in der Konfiguration steht und die Liste der
   * moeglichen Groessen im Modul: ein Update, das eine Groesse fallen laesst,
   * oder eine von Hand bearbeitete Datei brechen sonst auseinander. Repariert
   * wird in der Konfiguration und nicht erst beim Zeichnen – sonst zeigte die
   * Wand etwas anderes als das Brett am Handy.
   */
  const alignSizesToModules = async (): Promise<void> => {
    // Module, die nicht geladen haben, wissen nichts ueber ihre Groessen. Ihre
    // Bloecke bleiben unangetastet, bis das Modul wieder laeuft.
    const supported = new Map(
      deps.modules
        .descriptors()
        .filter((descriptor) => !descriptor.loadError)
        .map((descriptor) => [descriptor.id, descriptor.sizes]),
    );
    const affected = deps.config.current.instances.some((instance) => {
      const sizes = supported.get(instance.moduleId);
      return sizes !== undefined && !sizes.includes(instance.size);
    });
    if (!affected) return;

    await deps.config.update((draft) => {
      for (const instance of draft.instances) {
        const sizes = supported.get(instance.moduleId);
        if (!sizes || sizes.includes(instance.size)) continue;
        const next = nearestWidgetSize(instance.size, sizes);
        log.info(`"${instance.id}": Groesse ${instance.size} gibt es in "${instance.moduleId}" nicht – jetzt ${next}.`);
        instance.size = next;
      }
    });
  };

  await alignSizesToModules();

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
      // Wer die Vorschau angefordert hat, ist weg – der Spiegel schaltet
      // wieder von selbst weiter.
      if (preview?.owner === client) setPreview(null, null);
      if (client.type === 'shell') {
        log.info('Anzeige hat die Verbindung getrennt.');
        shellReady = [...clients].some((candidate) => candidate.type === 'shell' && candidate.authenticated);
        // Die gemeldeten Kantenlaengen gelten nur, solange die Anzeige haengt.
        // Bleibt der alte Wert stehen, rechnet die Handy-App beim Ausrichten
        // mit einem Bildschirm, der gar nicht mehr da ist.
        if (!shellReady) {
          viewport = null;
          broadcast({ t: 'display:viewport', viewport: null }, (candidate) => candidate.type === 'remote');
        }
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

      // Ein Handy mit gueltigem Token hat Schritt 1 nachweislich hinter sich.
      // Ohne diese Zeile koennte eine von Hand zurueckgesetzte Konfiguration
      // die Einrichtung festfahren: die App fragte nach einem Code, den der
      // Spiegel gar nicht mehr erzeugt, weil ja schon jemand gekoppelt ist.
      if (client.type === 'remote' && deps.config.current.setup.step === 'pair') {
        await deps.config.update((draft) => {
          draft.setup = withSetupStep(draft.setup, 'frame');
        });
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

      // Schritt 1 ist damit erledigt. Der Wechsel passiert hier und nicht in
      // der Handy-App: der Spiegel muss ab jetzt den Ausricht-Rahmen zeigen,
      // und er erfaehrt davon nur ueber die Konfiguration.
      if (deps.config.current.setup.step === 'pair') {
        await deps.config.update((draft) => {
          draft.setup = withSetupStep(draft.setup, 'frame');
        });
      }

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

      case 'shell:viewport': {
        const width = Math.round(Number(message.viewport?.width));
        const height = Math.round(Number(message.viewport?.height));
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return fail(client, 'bad-request', 'Unbrauchbare Bildschirmmasse');
        }
        if (viewport?.width === width && viewport.height === height) return;
        viewport = { width, height };
        broadcast({ t: 'display:viewport', viewport }, (candidate) => candidate.type === 'remote');
        return;
      }

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

      case 'admin:setLayout': {
        const descriptors = deps.modules.descriptors();
        await deps.config.update((draft) => {
          for (const update of message.instances) {
            const instance = draft.instances.find((entry) => entry.id === update.id);
            if (!instance) continue;
            // Nur, was tatsaechlich mitgeschickt wurde: die Handy-App schiebt
            // beim Ziehen Koordinaten und beim Antippen einen Schalter, und
            // das eine darf das andere nicht zuruecksetzen.
            if (typeof update.screenId === 'string' && draft.screens.some((s) => s.id === update.screenId)) {
              instance.screenId = update.screenId;
            }
            if (Number.isFinite(update.x)) instance.x = Number(update.x);
            if (Number.isFinite(update.y)) instance.y = Number(update.y);
            if (update.size !== undefined) {
              // Nicht jedes Modul gibt es in jeder Groesse. Eine Groesse, die
              // es nicht anbietet, wird auf die naechstliegende gezogen statt
              // abgelehnt – am Handy steht sie ohnehin nicht zur Auswahl.
              const sizes = descriptors.find((entry) => entry.id === instance.moduleId)?.sizes;
              const requested = normalizeWidgetSize(update.size, instance.size);
              instance.size = sizes ? nearestWidgetSize(requested, sizes) : requested;
            }
            if (typeof update.enabled === 'boolean') instance.enabled = update.enabled;
          }
        });
        return;
      }

      case 'admin:addInstance': {
        const descriptor = deps.modules.descriptors().find((entry) => entry.id === message.moduleId);
        if (!descriptor) return fail(client, 'not-found', `Modul "${message.moduleId}" unbekannt`);
        await deps.config.update((draft) => {
          if (descriptor.singleton && draft.instances.some((entry) => entry.moduleId === descriptor.id)) {
            throw new Error(`Von "${descriptor.id}" ist nur eine Instanz erlaubt`);
          }
          const screen = draft.screens.find((entry) => entry.id === message.screenId) ?? draft.screens[0]!;
          const size = nearestWidgetSize(
            normalizeWidgetSize(message.size, descriptor.preferredSize),
            descriptor.sizes,
          );
          const occupied = draft.instances
            .filter((entry) => entry.screenId === screen.id)
            .map((entry) => rectFor(entry, draft.display.grid));
          const preferred =
            Number.isFinite(message.x) && Number.isFinite(message.y)
              ? { x: Number(message.x), y: Number(message.y) }
              : undefined;
          const spot = findFreeSpot(occupied, draft.display.grid, size, preferred);
          // Lieber eine klare Absage als ein Block, der unter einem anderen
          // liegt: auf dem Spiegel waere davon nichts zu sehen.
          if (!spot) throw new Error(`Auf "${screen.name}" ist kein Platz frei fuer diese Groesse`);

          draft.instances.push({
            id: nextInstanceId(draft.instances.map((entry) => entry.id), descriptor.id),
            moduleId: descriptor.id,
            screenId: screen.id,
            x: spot.x,
            y: spot.y,
            size,
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

      case 'admin:addScreen':
        await deps.config.update((draft) => {
          if (draft.screens.length >= MAX_SCREENS) {
            throw new Error(`Mehr als ${MAX_SCREENS} Screens sind nicht vorgesehen`);
          }
          const name = message.name?.trim() || defaultScreenName(draft.screens);
          draft.screens.push(createScreen(nextScreenId(draft.screens.map((entry) => entry.id)), name));
        });
        return;

      case 'admin:removeScreen':
        await deps.config.update((draft) => {
          // Ohne Screen gaebe es keine Flaeche mehr: der Spiegel waere schwarz,
          // und die Handy-App haette nichts, worauf sie ein Modul legen kann.
          if (draft.screens.length <= 1) throw new Error('Der letzte Screen kann nicht geloescht werden');
          if (!draft.screens.some((entry) => entry.id === message.screenId)) {
            throw new Error(`Screen "${message.screenId}" existiert nicht`);
          }
          draft.screens = draft.screens.filter((entry) => entry.id !== message.screenId);
          // Die Bloecke gehen mit. Sie auf einen anderen Screen zu retten,
          // wuerde dort fremde Anordnungen ueberschreiben – die Handy-App
          // fragt vorher nach und nennt die Zahl.
          draft.instances = draft.instances.filter((entry) => entry.screenId !== message.screenId);
        });
        return;

      case 'admin:setScreen':
        await deps.config.update((draft) => {
          const screen = draft.screens.find((entry) => entry.id === message.screenId);
          if (!screen) throw new Error(`Screen "${message.screenId}" existiert nicht`);
          const name = message.patch.name?.trim();
          if (name) screen.name = name.slice(0, 40);
          if (message.patch.durationSeconds !== undefined) {
            screen.durationSeconds = clampScreenDuration(message.patch.durationSeconds);
          }
        });
        return;

      case 'admin:reorderScreens':
        await deps.config.update((draft) => {
          const byId = new Map(draft.screens.map((entry) => [entry.id, entry]));
          const ordered = message.ids
            .map((id) => byId.get(id))
            .filter((entry): entry is MirrorConfig['screens'][number] => entry !== undefined);
          // Was in der Liste fehlt, haengt hinten an: eine unvollstaendige
          // Reihenfolge darf keinen Screen verschlucken.
          for (const screen of draft.screens) {
            if (!ordered.includes(screen)) ordered.push(screen);
          }
          draft.screens = ordered;
        });
        return;

      case 'admin:previewScreen':
        if (client.type !== 'remote') return;
        setPreview(message.screenId, client);
        return;

      case 'admin:setSettings':
        await deps.config.update((draft) => {
          const { setup, ...rest } = message.patch;
          Object.assign(draft, rest);
          // Der Einrichtungsstand geht nicht roh durch: `completedAt` gehoert
          // dem Server, nicht dem Handy – sonst koennte eine App den ersten
          // Durchlauf als nie geschehen ausgeben.
          if (setup?.step) draft.setup = withSetupStep(draft.setup, setup.step);
        });
        return;

      case 'admin:setSecret':
        await deps.secrets.set(message.moduleId, message.key, message.value);
        broadcast({ t: 'modules:update', modules: deps.modules.descriptors() });
        // Module lesen ihre Geheimnisse beim Start – also neu starten. `sync`
        // taete das nicht: es vergleicht die Konfiguration, und die ist
        // unveraendert.
        await deps.modules.restartModule(message.moduleId);
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
