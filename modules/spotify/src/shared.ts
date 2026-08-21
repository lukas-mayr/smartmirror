export interface SpotifyConfig {
  clientId: string;
  showProgress: boolean;
  showAlbum: boolean;
  hideWhenIdle: boolean;
}

export interface SpotifyState {
  /** Es liegt ein gueltiger Zugang vor. Ohne ihn zeigt die Anzeige den Grund. */
  connected: boolean;
  playing: boolean;
  title: string | null;
  /** Bei Podcasts der Name der Sendung. */
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  progressMs: number | null;
  /**
   * Wann `progressMs` galt, als ISO-Zeitstempel.
   *
   * Die Anzeige rechnet damit selbst weiter, statt im Sekundentakt zu fragen:
   * ein Balken, der sich nur alle zehn Sekunden ruckartig bewegt, faellt hinter
   * dem Glas mehr auf als einer, der einfach laeuft.
   */
  sampledAt: string | null;
}

/**
 * Die Anmeldung fuehrt ins Leere – und das ist Absicht.
 *
 * Spotify verlangt seit April 2025 HTTPS fuer Redirect-URIs; erlaubt bleibt
 * allein die Loopback-Adresse. Ein Spiegel im WLAN ist beides nicht: er hat
 * kein Zertifikat, und 127.0.0.1 zeigt auf dem Handy auf das Handy. Also
 * schicken wir die Antwort bewusst an eine Adresse, an der nichts lauscht,
 * und lassen den Nutzer die Adresszeile zurueckreichen. Der Wert muss nur mit
 * dem Eintrag im Dashboard uebereinstimmen; geladen wird er nie.
 */
export const REDIRECT_URI = 'http://127.0.0.1:8888/mirror';

/** Nur lesen, und nur das Laufende. Mehr braucht eine Anzeige nicht. */
export const SCOPE = 'user-read-currently-playing';

/**
 * Holt den Code aus dem, was der Nutzer eingefuegt hat.
 *
 * Erlaubt ist beides: die ganze Adresse aus der Fehlerseite oder nur der Code.
 * Wer am Handy eine Adresse markiert, erwischt selten genau den richtigen
 * Abschnitt – das darf nicht an uns scheitern.
 */
export function extractCode(raw: string): string {
  const text = raw.trim();
  if (!text.includes('?')) return text;

  const query = text.slice(text.indexOf('?') + 1).split('#')[0] as string;
  const params = new URLSearchParams(query);
  const denied = params.get('error');
  // Der haeufigste Fall ist kein Fehler, sondern ein Klick auf "Nicht
  // einverstanden" – das soll nicht als Netzproblem erscheinen.
  if (denied) throw new Error(`Spotify hat die Anmeldung abgelehnt (${denied}).`);
  const code = params.get('code');
  if (!code) throw new Error('In der eingefuegten Adresse steht kein Code.');
  return code;
}

/** Zeigt an, wie weit der Titel gelaufen ist – 0..1, geraten aus der Zeit. */
export function elapsedFraction(state: Partial<SpotifyState>, now = Date.now()): number {
  const { durationMs, progressMs, sampledAt, playing } = state;
  if (!durationMs || progressMs === null || progressMs === undefined) return 0;
  const drift = playing && sampledAt ? now - Date.parse(sampledAt) : 0;
  const elapsed = progressMs + (Number.isFinite(drift) ? Math.max(0, drift) : 0);
  return Math.min(1, Math.max(0, elapsed / durationMs));
}

/** "3:07" – Minuten und Sekunden, ohne fuehrende Stunde bei kurzen Titeln. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
