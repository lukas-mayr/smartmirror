import type { ClientMessage, ServerMessage } from '@mirror/sdk';

export type ConnectionState = 'connecting' | 'online' | 'offline';

interface ConnectionOptions {
  coreUrl: string;
  appVersion: string;
  onMessage(message: ServerMessage): void;
  onStateChange(state: ConnectionState): void;
}

/**
 * WebSocket-Verbindung zum Core mit Wiederverbindung.
 *
 * Der wichtigste Fall ist nicht der Netzwerkausfall, sondern das Update: dabei
 * verschwindet der Core fuer ein paar Sekunden und kommt als neue Version
 * zurueck. Die Anzeige muss das ohne Zutun ueberstehen.
 */
export class CoreConnection {
  #socket: WebSocket | null = null;
  #options: ConnectionOptions;
  #retryDelay = 500;
  #reconnectTimer: number | undefined;
  #keepAlive: number | undefined;
  #state: ConnectionState = 'connecting';
  /** Stand diese Verbindung schon einmal? Entscheidet ueber die Wartezeit. */
  #everConnected = false;

  constructor(options: ConnectionOptions) {
    this.#options = options;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    this.#setState('connecting');
    const url = new URL('/ws', this.#options.coreUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(url.toString());
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#everConnected = true;
      this.#retryDelay = 500;
      this.#setState('online');
      this.send({ t: 'hello', clientType: 'shell', appVersion: this.#options.appVersion });
      // Der Core soll merken, wenn diese Verbindung tot ist, ohne auf das
      // TCP-Timeout zu warten.
      this.#keepAlive = window.setInterval(() => this.send({ t: 'ping' }), 20_000);
    });

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        this.#options.onMessage(JSON.parse(event.data) as ServerMessage);
      } catch (error) {
        console.error('[shell] Nachricht nicht lesbar', error);
      }
    });

    socket.addEventListener('close', () => this.#scheduleReconnect());
    socket.addEventListener('error', () => socket.close());
  }

  send(message: ClientMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  #scheduleReconnect(): void {
    if (this.#keepAlive !== undefined) {
      window.clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
    this.#setState('offline');
    window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = window.setTimeout(() => this.connect(), this.#retryDelay);
    // Schneller Anfang fuer den Update-Neustart, dann zurueckhaltender.
    //
    // Vor der allerersten Verbindung bleibt die Wartezeit kurz. Beim Booten
    // geht die Anzeige absichtlich auf, bevor der Core antwortet – sie zeigt
    // so lange ihren Startbildschirm statt der Textkonsole. Mit der vollen
    // Rueckhaltung stuende sie danach womoeglich noch fuenfzehn Sekunden vor
    // einem Core, der laengst da ist. Ist die Verbindung dagegen schon einmal
    // gestanden und faellt spaeter aus, hilft haeufiges Nachfragen nichts.
    const cap = this.#everConnected ? 15_000 : 2_000;
    this.#retryDelay = Math.min(this.#retryDelay * 1.7, cap);
  }

  #setState(state: ConnectionState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#options.onStateChange(state);
  }
}
