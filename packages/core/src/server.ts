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
  normalizeScreenLayout,
  normalizeWidgetSize,
  normalizeZone,
  rectFor,
  withSetupStep,
  ZONE_CAPACITY,
  ZONE_SPECS,
  type ClientMessage,
  type ClientType,
  type ErrorCode,
  type MirrorConfig,
  type PairedDevice,
  type PairingState,
  type ServerMessage,
  type Viewport,
  type Zone,
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
  /**
   * Id des gekoppelten Geraets. `null` bei der Anzeige auf dem Pi selbst: die
   * ist nicht gekoppelt, sondern von Haus aus vertraut.
   */
  deviceId: string | null;
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

  /* ---------------------------------- Kopplung --------------------------------- */

  /**
   * Laeuft mit dem Kopplungscode ab und nimmt ihn dann vom Spiegel.
   *
   * Ohne diesen Timer blieb der Code stehen, bis zufaellig jemand koppelte:
   * fuenf Minuten Gueltigkeit stand in der Pruefung, auf der Wand aber stand er
   * die ganze Nacht.
   */
  let pairingTimer: NodeJS.Timeout | null = null;

  const pairingState = (): PairingState => {
    const pending = deps.auth.pendingCode;
    return { open: pending !== null, expiresAt: pending?.expiresAt.toISOString() ?? null };
  };

  const devices = (): PairedDevice[] => {
    const online = new Set(
      [...clients]
        .filter((candidate) => candidate.authenticated && candidate.deviceId)
        .map((candidate) => candidate.deviceId as string),
    );
    return deps.auth.listClients().map((device) => ({ ...device, online: online.has(device.id) }));
  };

  const pushDevices = (): void => broadcast({ t: 'devices:update', devices: devices() }, (c) => c.type === 'remote');

  /**
   * Bringt den Kopplungscode auf den Spiegel – oder nimmt ihn wieder weg.
   *
   * Nur die Anzeige bekommt den Code selbst. Alle uebrigen erfahren, *dass*
   * eine Kopplung offen ist: das genuegt der App fuer ihren Hinweis, und ein
   * ungekoppeltes Handy koennte sich den Code sonst abholen, ohne je vor dem
   * Spiegel gestanden zu haben.
   */
  const publishPairing = (): void => {
    if (pairingTimer) clearTimeout(pairingTimer);
    pairingTimer = null;

    const pending = deps.auth.pendingCode;
    broadcast(
      {
        t: 'pair:code',
        code: pending?.code ?? '',
        expiresAt: (pending?.expiresAt ?? new Date(0)).toISOString(),
      },
      (candidate) => candidate.type === 'shell',
    );
    const state = pairingState();
    for (const client of clients) {
      if (client.type !== 'remote') continue;
      send(client, { t: 'pair:state', pairing: state });
    }

    if (pending) {
      pairingTimer = setTimeout(() => {
        deps.auth.cancelPairing();
        publishPairing();
      }, Math.max(0, pending.expiresAt.getTime() - Date.now()));
      pairingTimer.unref?.();
    }
  };

  /** Beendet alle Verbindungen eines Geraets, dem gerade die Kopplung entzogen wurde. */
  const dropDevice = (deviceId: string): void => {
    for (const client of clients) {
      if (client.deviceId !== deviceId) continue;
      client.authenticated = false;
      client.deviceId = null;
      send(client, { t: 'error', code: 'unauthorized', message: 'Kopplung dieses Geraets wurde entzogen' });
      client.socket.close();
    }
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
      deviceId: null,
      local: address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
      appVersion: 'unbekannt',
    };
    clients.add(client);

    socket.on('close', () => {
      clients.delete(client);
      // Wer die Vorschau angefordert hat, ist weg – der Spiegel schaltet
      // wieder von selbst weiter.
      if (preview?.owner === client) setPreview(null, null);
      // In der Geraeteliste der anderen Handys erlischt der Punkt.
      if (client.deviceId) {
        deps.auth.touch(client.deviceId);
        pushDevices();
      }
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
    if (message.t === 'ping') {
      // Ein Lebenszeichen ist auch eines fuer die Geraeteliste: "zuletzt
      // gesehen" soll die Zeit am Spiegel meinen, nicht die letzte Kopplung.
      if (client.deviceId) deps.auth.touch(client.deviceId);
      return send(client, { t: 'pong' });
    }

    if (message.t === 'hello') {
      client.type = message.clientType === 'shell' ? 'shell' : 'remote';
      client.appVersion = message.appVersion;

      // Die Anzeige laeuft auf demselben Geraet wie der Server. Sie zu koppeln
      // waere ein Ritual ohne Sicherheitsgewinn: wer auf dem Pi Prozesse
      // starten kann, hat den Spiegel ohnehin.
      const trusted = client.type === 'shell' && client.local;
      const device = trusted ? null : deps.auth.identify(message.token);
      client.authenticated = trusted || device !== null;
      client.deviceId = device?.id ?? null;

      if (!client.authenticated) {
        // Der frische Spiegel hat noch kein Geraet: dort zeigt die Anzeige den
        // Code von selbst, sonst haette niemand einen Weg hinein.
        //
        // Danach nicht mehr. Frueher legte jeder Browser, der die Adresse
        // oeffnete, dem Spiegel ungefragt einen Kopplungscode ueber den
        // Inhalt – ein Blick auf die Seite am Rechner, und die Wand sah aus
        // wie frisch zurueckgesetzt. Jetzt fragt die App danach, und zwar
        // erst, wenn jemand wirklich koppeln will.
        const firstEver = !deps.auth.hasPairedClients;
        if (firstEver) deps.auth.startPairing();

        send(client, {
          t: 'welcome',
          serverVersion: appVersion(),
          authenticated: false,
          needsPairing: true,
          mirrorPaired: !firstEver,
          pairing: pairingState(),
        });
        if (firstEver) publishPairing();
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

      send(client, {
        t: 'welcome',
        serverVersion: appVersion(),
        authenticated: true,
        needsPairing: false,
        mirrorPaired: deps.auth.hasPairedClients,
        deviceId: device?.id,
      });
      send(client, snapshotFor(client));
      if (client.type === 'remote') {
        send(client, { t: 'pair:state', pairing: pairingState() });
        // Geht an alle Handys, auch an dieses: dort steht die frische Liste,
        // bei den uebrigen geht der Punkt dieses Geraets an.
        pushDevices();
      }
      if (client.type === 'shell') {
        log.info(`Anzeige verbunden (v${message.appVersion}).`);
        // Eine Anzeige, die waehrend einer offenen Kopplung neu startet, muss
        // den Code wiederbekommen – sonst steht er nirgends mehr.
        publishPairing();
      }
      return;
    }

    /**
     * Kopplung anfordern. Erlaubt fuer jeden, der die Adresse erreicht – der
     * Schutz ist der Sichtkontakt zum Spiegel, nicht die Frage. Ein bereits
     * gekoppeltes Handy nutzt dieselbe Nachricht fuer "weiteres Geraet
     * koppeln".
     */
    if (message.t === 'pair:start') {
      const pending = deps.auth.startPairing();
      log.info(`Kopplung angefordert, Code laeuft ${pending.expiresAt.toLocaleTimeString('de-DE')} ab.`);
      publishPairing();
      return;
    }

    if (message.t === 'pair:cancel') {
      deps.auth.cancelPairing();
      publishPairing();
      return;
    }

    if (message.t === 'pair:request') {
      const result = await deps.auth.redeem(message.code, message.clientName);
      if (!result) return fail(client, 'pairing-failed', 'Code ist falsch oder abgelaufen');
      client.authenticated = true;
      client.deviceId = result.device.id;

      // Schritt 1 ist damit erledigt. Der Wechsel passiert hier und nicht in
      // der Handy-App: der Spiegel muss ab jetzt den Ausricht-Rahmen zeigen,
      // und er erfaehrt davon nur ueber die Konfiguration.
      if (deps.config.current.setup.step === 'pair') {
        await deps.config.update((draft) => {
          draft.setup = withSetupStep(draft.setup, 'frame');
        });
      }

      send(client, { t: 'pair:result', ok: true, token: result.token, deviceId: result.device.id });
      send(client, snapshotFor(client));
      // Code vom Spiegel nehmen – er ist verbraucht.
      publishPairing();
      pushDevices();
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
            if (update.zone !== undefined) instance.zone = normalizeZone(update.zone, instance.zone);
            if (update.size !== undefined) {
              // Nicht jedes Modul gibt es in jeder Groesse. Eine Groesse, die
              // es nicht anbietet, wird auf die naechstliegende gezogen statt
              // abgelehnt – am Handy steht sie ohnehin nicht zur Auswahl.
              const sizes = descriptors.find((entry) => entry.id === instance.moduleId)?.sizes;
              const requested = normalizeWidgetSize(update.size, instance.size);
              instance.size = sizes ? nearestWidgetSize(requested, sizes) : requested;
            }
            if (typeof update.enabled === 'boolean') instance.enabled = update.enabled;
            if (typeof update.visible === 'boolean') instance.visible = update.visible;
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
          const visible = message.visible !== false;
          /*
           * Nur sichtbare Nachbarn belegen Platz.
           *
           * Ein Block, den niemand sieht, darf keinen Rasterplatz besetzt
           * halten – sonst waere ein Kalender, der bloss Mitteilungen liefert,
           * ein unsichtbares Hindernis beim Anordnen.
           */
          const siblings = draft.instances.filter(
            (entry) => entry.screenId === screen.id && entry.visible !== false,
          );
          const occupied = siblings.map((entry) => rectFor(entry, draft.display.grid));
          const preferred =
            Number.isFinite(message.x) && Number.isFinite(message.y)
              ? { x: Number(message.x), y: Number(message.y) }
              : undefined;
          const spot = findFreeSpot(occupied, draft.display.grid, size, preferred);

          /**
           * Ist der Screen eine Szene, entscheidet das Band ueber den Platz
           * und nicht das Raster.
           *
           * Der Rasterplatz wird trotzdem gesucht und mitgeschrieben: ein
           * Screen laesst sich zwischen beiden Anordnungen umschalten, und ein
           * Block ohne Koordinaten laege danach auf 0,0 – also unter der Uhr.
           * Findet sich keiner, ist das hier kein Grund zur Absage.
           */
          if (screen.layout === 'zones') {
            const zone = normalizeZone(message.zone, defaultZoneFor(descriptor.id));
            const taken = siblings.filter((entry) => entry.zone === zone).length;
            // Ein unsichtbarer Block steht in keinem Band und fuellt deshalb
            // auch keines.
            if (visible && taken >= ZONE_CAPACITY[zone]) {
              throw new Error(
                `Im Band "${ZONE_SPECS[zone].name}" ist kein Platz mehr – dort passen ${ZONE_CAPACITY[zone]} Bloecke.`,
              );
            }
            draft.instances.push({
              id: nextInstanceId(draft.instances.map((entry) => entry.id), descriptor.id),
              moduleId: descriptor.id,
              screenId: screen.id,
              x: spot?.x ?? 0,
              y: spot?.y ?? 0,
              zone,
              size,
              enabled: true,
              visible,
              config: {},
            });
            return;
          }

          /*
           * Lieber eine klare Absage als ein Block, der unter einem anderen
           * liegt: auf dem Spiegel waere davon nichts zu sehen.
           *
           * Wer nichts belegt, kann daran nicht scheitern: eine Quelle, die
           * nur melden soll, laesst sich auch auf einem vollen Screen
           * hinzufuegen. Sie bekommt einen Platz, sobald einer frei ist, und
           * bis dahin steht sie auf 0,0 – zu sehen ist sie ohnehin nicht.
           */
          if (!spot && visible) {
            throw new Error(`Auf "${screen.name}" ist kein Platz frei fuer diese Groesse`);
          }

          draft.instances.push({
            id: nextInstanceId(draft.instances.map((entry) => entry.id), descriptor.id),
            moduleId: descriptor.id,
            screenId: screen.id,
            x: spot?.x ?? 0,
            y: spot?.y ?? 0,
            zone: normalizeZone(message.zone, defaultZoneFor(descriptor.id)),
            size,
            enabled: true,
            visible,
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
          if (message.patch.layout !== undefined) {
            screen.layout = normalizeScreenLayout(message.patch.layout, screen.layout);
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

      case 'admin:renameDevice': {
        const name = message.name.trim();
        if (!name) return fail(client, 'bad-request', 'Ein Geraet braucht einen Namen');
        if (!(await deps.auth.rename(message.deviceId, name))) {
          return fail(client, 'not-found', 'Dieses Geraet ist nicht (mehr) gekoppelt');
        }
        pushDevices();
        return;
      }

      case 'admin:revokeDevice': {
        if (!(await deps.auth.revoke(message.deviceId))) {
          return fail(client, 'not-found', 'Dieses Geraet ist nicht (mehr) gekoppelt');
        }
        // Erst trennen, dann die Liste verteilen: die verbleibenden Handys
        // sollen den Punkt des entzogenen Geraets nicht noch leuchten sehen.
        dropDevice(message.deviceId);
        pushDevices();
        return;
      }

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

/**
 * In welches Band ein Modul kommt, wenn niemand etwas anderes sagt.
 *
 * Die Uhr in den Kopf: sie sitzt in jeder Szene links oben, und wer sie
 * hinzufuegt, meint genau diesen Platz. Was laeuft, ins Fussband – das Band
 * ist fuer breite, flache Elemente da, und "Laeuft gerade" ist die Vorlage
 * dafuer. Alles andere traegt die Aussage der Szene und gehoert in die Mitte.
 */
function defaultZoneFor(moduleId: string): Zone {
  if (moduleId === 'clock') return 'head';
  if (moduleId === 'spotify') return 'foot';
  return 'main';
}
