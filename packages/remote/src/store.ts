import type {
  ClientMessage,
  MirrorConfig,
  ModuleDescriptor,
  ModuleStateEnvelope,
  PairedDevice,
  PairingState,
  ServerMessage,
  UpdateStatus,
  Viewport,
} from '@mirror/sdk';

const TOKEN_KEY = 'mirror.token';
const NAME_KEY = 'mirror.clientName';
const DEVICE_KEY = 'mirror.deviceId';

/**
 * Zugriff auf den lokalen Speicher, der nicht ueber seine eigenen Fuesse faellt.
 *
 * Safari im privaten Modus wirft beim Schreiben, und in einem iframe ist der
 * Speicher je nach Einstellung ganz gesperrt. Frueher riss das die ganze App
 * mit: ein Fehler im Konstruktor, weisse Seite, kein Hinweis. Jetzt merkt sich
 * die App das Token notfalls nur fuer diese Sitzung – koppeln laesst sie sich
 * dann bei jedem Start neu, aber sie laeuft.
 */
const memory = new Map<string, string>();

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeStored(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nur diese Sitzung – besser als gar keine Kopplung.
  }
}

function clearStored(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Nichts zu tun: gespeichert war ohnehin nichts.
  }
}

/** Abstand der Lebenszeichen. Wie in der Anzeige, damit beide gleich schnell auffallen. */
const KEEPALIVE_MS = 20_000;
/**
 * Kommt so lange nichts mehr vom Core – auch kein "pong" –, gilt die
 * Verbindung als tot. Zwei verpasste Lebenszeichen plus Reserve.
 */
const SILENCE_MS = 50_000;

export type Status = 'connecting' | 'pairing' | 'ready' | 'offline';

export interface StoreSnapshot {
  status: Status;
  config: MirrorConfig | null;
  modules: ModuleDescriptor[];
  state: Record<string, ModuleStateEnvelope>;
  powerOn: boolean;
  update: UpdateStatus | null;
  /**
   * Kantenlaengen der Anzeige in Pixeln, sofern sie gerade haengt. Nur zur
   * Erlaeuterung beim Ausrichten: neben "2,5 %" steht dann auch "27 px".
   */
  viewport: Viewport | null;
  /**
   * Screen, den die Anzeige gerade festhaelt, weil hier daran gearbeitet wird.
   * `null` heisst: der Spiegel schaltet selbst weiter.
   */
  previewScreenId: string | null;
  /**
   * Haengt am Spiegel schon ein Geraet? Entscheidet, ob dieses hier die erste
   * Einrichtung vor sich hat oder nur dazukommt.
   */
  mirrorPaired: boolean;
  /** Laeuft gerade eine Kopplung – steht also ein Code auf dem Spiegel? */
  pairing: PairingState;
  /** Alle gekoppelten Geraete, wie der Spiegel sie kennt. */
  devices: PairedDevice[];
  /** Eigene Geraete-Id, um sich in der Liste selbst zu erkennen. */
  deviceId: string | null;
  lastError: string | null;
}

/**
 * Verbindung und Zustand der Fernbedienung.
 *
 * Absichtlich kein Zustandsframework: die App hat genau einen Datenstrom (den
 * WebSocket) und eine Handvoll Ansichten, die darauf hoeren.
 */
export class Store extends EventTarget {
  #socket: WebSocket | null = null;
  #retry = 500;
  #keepAlive: number | undefined;
  #reconnectTimer: number | undefined;
  #lastSeen = 0;
  #wakeupWatched = false;
  #snapshot: StoreSnapshot = {
    status: 'connecting',
    config: null,
    modules: [],
    state: {},
    powerOn: true,
    update: null,
    viewport: null,
    previewScreenId: null,
    mirrorPaired: false,
    pairing: { open: false, expiresAt: null },
    devices: [],
    deviceId: null,
    lastError: null,
  };

  get value(): StoreSnapshot {
    return this.#snapshot;
  }

  get token(): string | null {
    return readStored(TOKEN_KEY);
  }

  get clientName(): string {
    let name = readStored(NAME_KEY);
    if (!name) {
      name = defaultClientName();
      writeStored(NAME_KEY, name);
    }
    return name;
  }

  connect(): void {
    window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    // Ein zweiter Socket neben einem funktionierenden waere ein zweiter
    // Client am Core – und der erste bliebe unbemerkt liegen.
    const state = this.#socket?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    // Das Handy weckt die App auf; von den Ereignissen darf jedes nur einmal
    // haengen, deshalb hier und nicht bei jedem Verbindungsversuch.
    this.#watchForWakeup();

    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.toString());
    this.#socket = socket;
    this.#lastSeen = Date.now();

    socket.addEventListener('open', () => {
      this.#retry = 500;
      this.#lastSeen = Date.now();
      this.send({
        t: 'hello',
        clientType: 'remote',
        token: this.token ?? undefined,
        appVersion: '0.1.0',
      });
      this.#startKeepAlive();
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      this.#lastSeen = Date.now();
      this.#handle(JSON.parse(event.data) as ServerMessage);
    });

    socket.addEventListener('close', () => this.#scheduleReconnect());
    socket.addEventListener('error', () => socket.close());
  }

  send(message: ClientMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      // Frueher endete das hier stumm: die App sah weiter verbunden aus, der
      // Knopfdruck verschwand ersatzlos. Auf dem Handy ist das der Regelfall
      // und nicht die Ausnahme – nach dem Hintergrund ist die Verbindung weg.
      this.#patch({ status: 'offline' });
      this.connect();
      return;
    }
    this.#socket.send(JSON.stringify(message));
  }

  pair(code: string): void {
    this.send({ t: 'pair:request', code, clientName: this.clientName });
  }

  /** Bittet den Spiegel, einen Kopplungscode anzuzeigen. */
  requestPairing(): void {
    this.send({ t: 'pair:start' });
  }

  cancelPairing(): void {
    this.send({ t: 'pair:cancel' });
  }

  /**
   * Kopplung dieses Geraets loeschen.
   *
   * Erst am Spiegel, dann hier: sonst bliebe in dessen Liste ein Geraet
   * stehen, das nie wieder auftaucht und das niemand mehr zuordnen kann.
   */
  forgetToken(): void {
    const own = this.#snapshot.deviceId;
    if (own) this.send({ t: 'admin:revokeDevice', deviceId: own });
    clearStored(TOKEN_KEY);
    clearStored(DEVICE_KEY);
    window.setTimeout(() => window.location.reload(), 150);
  }

  /**
   * Lebenszeichen im festen Takt – und die Gegenprobe.
   *
   * Ein Ping allein merkt nichts: Ein WebSocket, dessen Gegenstelle
   * weggefallen ist, nimmt Daten weiter entgegen und meldet munter "OPEN".
   * Erst das ausbleibende "pong" verraet ihn. Genau dieser Zustand entsteht
   * auf dem Handy staendig, wenn die App im Hintergrund war.
   */
  #startKeepAlive(): void {
    window.clearInterval(this.#keepAlive);
    this.#keepAlive = window.setInterval(() => {
      if (Date.now() - this.#lastSeen > SILENCE_MS) {
        this.#socket?.close();
        return;
      }
      this.send({ t: 'ping' });
    }, KEEPALIVE_MS);
  }

  /**
   * Auf dem Handy laufen im Hintergrund keine Timer: die Totzeit-Erkennung
   * oben schlaeft mit. Beim Zurueckkehren zaehlt deshalb nur, sofort
   * nachzusehen – und nicht erst den naechsten Timer abzuwarten.
   */
  #watchForWakeup(): void {
    if (this.#wakeupWatched) return;
    this.#wakeupWatched = true;
    const wake = (): void => {
      if (document.visibilityState !== 'visible') return;
      this.#retry = 500;
      if (this.#socket?.readyState === WebSocket.OPEN) {
        // Sieht offen aus – muss es aber nicht sein. Das Lebenszeichen bringt
        // die Antwort, und bleibt sie aus, greift die Totzeit-Erkennung.
        this.#lastSeen = Date.now();
        this.send({ t: 'ping' });
        return;
      }
      this.connect();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
  }

  #scheduleReconnect(): void {
    window.clearInterval(this.#keepAlive);
    this.#keepAlive = undefined;
    this.#patch({ status: 'offline' });
    window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = window.setTimeout(() => this.connect(), this.#retry);
    this.#retry = Math.min(this.#retry * 1.6, 10_000);
  }

  #handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        if (message.deviceId) writeStored(DEVICE_KEY, message.deviceId);
        this.#patch({
          status: message.authenticated ? 'connecting' : 'pairing',
          mirrorPaired: message.mirrorPaired,
          deviceId: message.deviceId ?? (message.authenticated ? readStored(DEVICE_KEY) : null),
          pairing: message.pairing ?? this.#snapshot.pairing,
          // Ein ungekoppeltes Geraet hat keine Liste – und soll auch keine
          // alte aus einer frueheren Sitzung zeigen.
          devices: message.authenticated ? this.#snapshot.devices : [],
          lastError: null,
        });
        return;
      case 'pair:result':
        writeStored(TOKEN_KEY, message.token);
        writeStored(DEVICE_KEY, message.deviceId);
        this.#patch({
          status: 'ready',
          deviceId: message.deviceId,
          mirrorPaired: true,
          pairing: { open: false, expiresAt: null },
          lastError: null,
        });
        return;
      case 'pair:state':
        this.#patch({ pairing: message.pairing });
        return;
      case 'devices:update':
        this.#patch({ devices: message.devices });
        return;
      case 'snapshot':
        this.#patch({
          status: 'ready',
          config: message.config,
          modules: message.modules,
          state: message.state,
          powerOn: message.power.on,
          update: message.update,
          viewport: message.viewport,
          previewScreenId: message.previewScreenId,
        });
        return;
      case 'config:update':
        this.#patch({ config: message.config });
        return;
      case 'modules:update':
        this.#patch({ modules: message.modules });
        return;
      case 'state:patch': {
        const previous = this.#snapshot.state[message.envelope.instanceId];
        this.#patch({
          state: {
            ...this.#snapshot.state,
            [message.envelope.instanceId]: {
              ...message.envelope,
              patch: { ...(previous?.patch ?? {}), ...message.envelope.patch },
            },
          },
        });
        return;
      }
      case 'display:power':
        this.#patch({ powerOn: message.on });
        return;
      case 'display:viewport':
        this.#patch({ viewport: message.viewport });
        return;
      case 'display:previewScreen':
        this.#patch({ previewScreenId: message.screenId });
        return;
      case 'update:status':
        this.#patch({ update: message.status });
        return;
      case 'error':
        // Ein abgelaufenes Token muss zur Kopplung fuehren, nicht zu einer
        // App, die stumm nichts mehr tut.
        if (message.code === 'unauthorized') {
          clearStored(TOKEN_KEY);
          clearStored(DEVICE_KEY);
          this.#patch({ status: 'pairing', deviceId: null, devices: [], lastError: message.message });
          return;
        }
        this.#patch({ lastError: message.message });
        return;
      default:
        return;
    }
  }

  #patch(patch: Partial<StoreSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/**
 * Vorschlag fuer den Geraetenamen.
 *
 * Auf dem iPhone sind Safari und die zum Startbildschirm hinzugefuegte App zwei
 * getrennte Speicher – also zwei Kopplungen. In der Liste am Handy muss man sie
 * auseinanderhalten koennen, deshalb steht die Betriebsart im Namen.
 */
function defaultClientName(): string {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  const platform = navigator.platform || 'Handy';
  return `${platform} · ${standalone ? 'App' : 'Browser'}`;
}

export const store = new Store();
