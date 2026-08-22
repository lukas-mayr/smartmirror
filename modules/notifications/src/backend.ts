import { defineBackend, sortNotifications, type FeedNotification } from '@mirror/sdk';
import { parseEntries, type NotificationsConfig, type NotificationsState } from './shared.js';

/**
 * Wieviele zugeschickte Mitteilungen der Feed hoechstens haelt.
 *
 * Gilt nur fuer den Kommandoweg. Was die Module melden, begrenzt jedes Modul
 * selbst — ein Kalender, der die naechsten sieben Tage meldet, weiss besser
 * als diese Zahl, wieviele Termine das sind.
 *
 * Der aelteste faellt heraus und nicht der neueste: was zuletzt hereinkam, ist
 * der Grund, warum ueberhaupt jemand hinsieht.
 */
const MAX_PUSHED = 40;

/**
 * Wie oft abgelaufene zugeschickte Mitteilungen aufgeraeumt werden.
 *
 * Die Anzeige filtert ohnehin bei jedem Zeichnen, das hier ist nur die
 * Buchhaltung: sonst waechst die Liste im Zustand still weiter, und was einmal
 * hereinkam, ginge nie wieder.
 */
const SWEEP_MS = 60_000;

interface PushPayload {
  id?: unknown;
  label?: unknown;
  title?: unknown;
  meta?: unknown;
  urgent?: unknown;
  /** Sekunden ab jetzt, oder ein ISO-Zeitstempel. */
  ttlSeconds?: unknown;
  expiresAt?: unknown;
  at?: unknown;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value);
  if (raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Ablaufzeitpunkt aus dem, was das Kommando mitschickt.
 *
 * Zwei Formen, weil zwei Absender gemeint sind: ein Skript am Pi rechnet
 * lieber in Sekunden ("gilt zehn Minuten"), ein Kalender kennt seinen
 * Zeitpunkt ohnehin ("gilt bis 09:30").
 */
function expiryFrom(payload: PushPayload, now: Date): string | null {
  const ttl = Number(payload.ttlSeconds);
  if (Number.isFinite(ttl) && ttl > 0) return new Date(now.getTime() + ttl * 1000).toISOString();
  return isoOrNull(payload.expiresAt);
}

export default defineBackend<NotificationsConfig, NotificationsState>({
  async setup(ctx) {
    /**
     * Drei Herkuenfte, getrennt gehalten.
     *
     * Feste Zeilen kommen aus der Konfiguration, `pushed` per Kommando, und
     * `reported` ist das, was die anderen Module gemeldet haben. Getrennt,
     * weil jede Herkunft ihren eigenen Lebenslauf hat: eine
     * Konfigurationsaenderung darf das Zugeschickte nicht loeschen, und eine
     * neue Meldung des Kalenders darf den Zettel an die Familie nicht
     * mitnehmen.
     */
    let pushed: FeedNotification[] = [];
    let reported: readonly FeedNotification[] = [];

    const publish = (): void => {
      ctx.setState({
        items: sortNotifications([...parseEntries(ctx.config.entries), ...pushed, ...reported]),
      });
    };

    /*
     * Der eigentliche Weg hinein.
     *
     * Dieses Modul ist die Flaeche, nicht die Quelle: was eine Mitteilung ist,
     * weiss der Kalender, das Wetter oder die Abfahrtstafel. Sie melden es dem
     * Host, der Host legt es zusammen, und hier kommt der fertige Stand an.
     */
    ctx.onNotifications((items) => {
      reported = items;
      publish();
    });

    /*
     * Der Kommandoweg bleibt daneben bestehen.
     *
     * Er ist fuer alles, wofuer es kein Modul gibt und geben soll: ein Skript
     * am Pi, eine Hausautomation, ein Kurzbefehl vom Telefon. Ein eigenes
     * Modul zu schreiben, nur um einmal am Tag eine Zeile zu schicken, waere
     * die falsche Antwort.
     */
    ctx.onCommand('push', (payload) => {
      const input = (typeof payload === 'object' && payload !== null ? payload : {}) as PushPayload;
      const title = text(input.title);
      if (title.length === 0) {
        ctx.log.warn('Mitteilung ohne Titel verworfen.');
        return;
      }

      const now = new Date();
      const id = text(input.id) || `push-${now.getTime()}-${pushed.length}`;
      const entry: FeedNotification = {
        id,
        label: text(input.label),
        title,
        meta: text(input.meta),
        urgent: input.urgent === true,
        at: isoOrNull(input.at),
        expiresAt: expiryFrom(input, now),
        source: 'notifications',
      };

      // Dieselbe Id ersetzt statt zu stapeln: "Bus 142 in 7 min" und "in 5 min"
      // sind dieselbe Mitteilung, nur spaeter.
      const existing = pushed.findIndex((item) => item.id === id);
      if (existing >= 0) pushed[existing] = entry;
      else pushed = [...pushed, entry].slice(-MAX_PUSHED);

      publish();
    });

    ctx.onCommand('dismiss', (payload) => {
      const id = text((payload as { id?: unknown } | null)?.id);
      if (id.length === 0) return;
      pushed = pushed.filter((item) => item.id !== id);
      publish();
    });

    ctx.onCommand('clear', () => {
      pushed = [];
      publish();
    });

    ctx.every(SWEEP_MS, () => {
      const now = Date.now();
      const before = pushed.length;
      pushed = pushed.filter((item) => {
        if (!item.expiresAt) return true;
        const expires = Date.parse(item.expiresAt);
        return !Number.isFinite(expires) || expires > now;
      });
      // Nur schreiben, wenn sich etwas geaendert hat: ein Zustand, der jede
      // Minute unveraendert an alle Clients geht, ist Rauschen im Protokoll.
      if (pushed.length !== before) publish();
    });

    publish();
  },

  /**
   * Eine Konfigurationsaenderung startet die Instanz nicht neu.
   *
   * Ohne diese Methode wuerde der Modul-Host genau das tun – und mit dem
   * Neustart waeren alle zugeschickten Mitteilungen weg, nur weil jemand am
   * Handy eine Zeile im Textfeld geaendert hat. Was gemeldet wurde, kaeme
   * zwar zurueck, aber erst wenn die Quelle das naechste Mal meldet.
   */
  onConfigChange(ctx) {
    const current = ctx.getState().items ?? [];
    // Was aus der Konfiguration kam, traegt eine "entry-"-Id und wird neu
    // gebaut; alles andere ist zugeschickt oder gemeldet und bleibt.
    const rest = current.filter((item) => !item.id.startsWith('entry-'));
    ctx.setState({ items: sortNotifications([...parseEntries(ctx.config.entries), ...rest]) });
  },
});
