import type {
  ClientMessage,
  MirrorConfig,
  ModuleDescriptor,
  ModuleStateEnvelope,
  ServerMessage,
  UpdateStatus,
} from '@mirror/sdk';

const TOKEN_KEY = 'mirror.token';
const NAME_KEY = 'mirror.clientName';

export type Status = 'connecting' | 'pairing' | 'ready' | 'offline';

export interface StoreSnapshot {
  status: Status;
  config: MirrorConfig | null;
  modules: ModuleDescriptor[];
  state: Record<string, ModuleStateEnvelope>;
  powerOn: boolean;
  update: UpdateStatus | null;
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
  #snapshot: StoreSnapshot = {
    status: 'connecting',
    config: null,
    modules: [],
    state: {},
    powerOn: true,
    update: null,
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
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.toString());
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#retry = 500;
      this.send({
        t: 'hello',
        clientType: 'remote',
        token: this.token ?? undefined,
        appVersion: '0.1.0',
      });
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      this.#handle(JSON.parse(event.data) as ServerMessage);
    });

    socket.addEventListener('close', () => {
      this.#patch({ status: 'offline' });
      window.setTimeout(() => this.connect(), this.#retry);
      this.#retry = Math.min(this.#retry * 1.6, 10_000);
    });
    socket.addEventListener('error', () => socket.close());
  }

  send(message: ClientMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  pair(code: string): void {
    this.send({ t: 'pair:request', code, clientName: this.clientName });
  }

  forgetToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    window.location.reload();
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
