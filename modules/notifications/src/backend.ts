import { defineBackend } from '@mirror/sdk';
import { parseEntries, type Notification, type NotificationsConfig, type NotificationsState } from './shared.js';

/**
 * Wieviele Mitteilungen der Feed hoechstens haelt.
 *
 * Nicht, weil mehr nicht in den Speicher passten, sondern weil ein Feed, durch
 * den man zwei Minuten blaettern muesste, keiner mehr ist. Wer zwanzig
 * Mitteilungen hat, hat kein Anzeigeproblem.
 */
const MAX_ITEMS = 12;

/**
 * Wie oft abgelaufene Mitteilungen aufgeraeumt werden.
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
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
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
  const stamp = text(payload.expiresAt);
  if (stamp.length > 0 && Number.isFinite(Date.parse(stamp))) return new Date(stamp).toISOString();
  return null;
}

export default defineBackend<NotificationsConfig, NotificationsState>({
  async setup(ctx) {
    /**
     * Feste Eintraege und zugeschickte liegen getrennt.
     *
     * Sonst loeschte die naechste Konfigurationsaenderung alles, was inzwischen
     * hereingekommen ist — und ein Feed, der beim Aendern einer Einstellung
     * seine Mitteilungen vergisst, ist keiner.
     */
    let pushed: Notification[] = [];

    const publish = (): void => {
      ctx.setState({ items: [...parseEntries(ctx.config.entries), ...pushed] });
    };

    /**
     * Eine Mitteilung von aussen.
     *
     * Der Weg dorthin ist bewusst ein Kommando und keine eigene Datenquelle:
     * was eine Mitteilung ist, weiss der Spiegel nicht — das weiss der
     * Kalender, die Paketverfolgung oder das Skript, das den Muellkalender
     * liest. Dieses Modul ist die Anzeige dafuer, nicht die Quelle.
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
      const entry: Notification = {
        id,
        label: text(input.label),
        title,
        meta: text(input.meta),
        urgent: input.urgent === true,
        expiresAt: expiryFrom(input, now),
      };

      // Dieselbe Id ersetzt statt zu stapeln: "Bus 142 in 7 min" und "in 5 min"
      // sind dieselbe Mitteilung, nur spaeter.
      const existing = pushed.findIndex((item) => item.id === id);
      if (existing >= 0) pushed[existing] = entry;
      else pushed = [...pushed, entry].slice(-MAX_ITEMS);

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
   * Handy eine Zeile im Textfeld geaendert hat.
   */
  onConfigChange(ctx) {
    const current = ctx.getState().items ?? [];
    // Was aus der Konfiguration kam, traegt eine "entry-"-Id und wird neu
    // gebaut; alles andere ist zugeschickt und bleibt.
    const pushed = current.filter((item) => !item.id.startsWith('entry-'));
    ctx.setState({ items: [...parseEntries(ctx.config.entries), ...pushed] });
  },
});
