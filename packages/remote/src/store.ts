import type {
  ClientMessage,
  MirrorConfig,
  ModuleDescriptor,
  ModuleStateEnvelope,
  ServerMessage,
  UpdateStatus,
  Viewport,
} from '@mirror/sdk';

const TOKEN_KEY = 'mirror.token';
const NAME_KEY = 'mirror.clientName';

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
    lastError: null,
  };

  get value(): StoreSnapshot {
    return this.#snapshot;
  }

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  get clientName(): string {
    let name = localStorage.getItem(NAME_KEY);
    if (!name) {
      // Damit man in der Geraeteliste erkennt, welches Handy welches ist.
      name = `${navigator.platform || 'Handy'} · ${new Date().toLocaleDateString('de-DE')}`;
      localStorage.setItem(NAME_KEY, name);
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

  forgetToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    window.location.reload();
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
        this.#patch({
          status: message.authenticated ? 'connecting' : 'pairing',
          lastError: null,
        });
        return;
      case 'pair:result':
        localStorage.setItem(TOKEN_KEY, message.token);
        this.#patch({ status: 'ready', lastError: null });
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
          localStorage.removeItem(TOKEN_KEY);
          this.#patch({ status: 'pairing', lastError: message.message });
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

export const store = new Store();
