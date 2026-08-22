export interface SpotifyConfig {
  clientId: string;
  hideWhenIdle: boolean;
  /** Hoeren mehrere gleichzeitig, so lange zeigt der Block jeden. */
  switchSeconds: number;
  /**
   * Der Block traegt die eine deckende Flaeche der Anordnung – in Sand.
   *
   * Eine Einstellung und keine Automatik: das Design-System erlaubt genau eine
   * deckende Flaeche pro Anordnung, und welcher Block sie bekommt, kann nur
   * entscheiden, wer die Anordnung kennt.
   */
  highlight: boolean;
}

/**
 * Hoechstens fuenf Konten – nicht unsere Zahl, sondern Spotifys: mehr Nutzer
 * laesst eine App im Development Mode seit Februar 2026 nicht zu.
 */
export const MAX_ACCOUNTS = 5;

/** Was ein verbundenes Konto gerade hoert. */
export interface AccountPlayback {
  /** Fester Platz 1..MAX_ACCOUNTS – bleibt stabil, auch wenn andere gehen. */
  slot: number;
  /** Anzeigename aus dem Spotify-Profil, sonst "Konto N". */
  name: string;
  playing: boolean;
  title: string | null;
  /** Bei Podcasts der Name der Sendung. */
  artist: string | null;
  album: string | null;
  /** Erscheinungsjahr des Albums, soweit Spotify eines nennt. */
  albumYear: string | null;
  /**
   * Albumcover als data-URI, vom Backend geholt und verkleinert.
   *
   * Als data-URI, weil die Anzeige hinter einer strikten CSP laeuft und
   * nichts aus dem Netz laden darf – das Backend ist die einzige Stelle mit
   * Netzzugang, und `data:` ist in der CSP fuer Bilder ausdruecklich erlaubt.
   */
  cover: string | null;
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

export interface SpotifyState {
  /** Wie viele Konten angemeldet sind. 0 heisst: Anmeldung steht noch aus. */
  connectedCount: number;
  /** Alle verbundenen Konten, nach Platz sortiert – auch die stillen. */
  accounts: AccountPlayback[];
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

/** Zeitanteile eines laufenden Titels – nur die Felder, die dafuer zaehlen. */
export interface PlaybackTiming {
  playing?: boolean;
  durationMs?: number | null;
  progressMs?: number | null;
  sampledAt?: string | null;
}

/** Zeigt an, wie weit der Titel gelaufen ist – 0..1, geraten aus der Zeit. */
export function elapsedFraction(entry: PlaybackTiming, now = Date.now()): number {
  const { durationMs, progressMs, sampledAt, playing } = entry;
  if (!durationMs || progressMs === null || progressMs === undefined) return 0;
  const drift = playing && sampledAt ? now - Date.parse(sampledAt) : 0;
  const elapsed = progressMs + (Number.isFinite(drift) ? Math.max(0, drift) : 0);
  return Math.min(1, Math.max(0, elapsed / durationMs));
}

/**
 * Wer als Naechster gezeigt wird, wenn mehrere gleichzeitig hoeren.
 *
 * Faellt der Gezeigte weg (Musik gestoppt, Konto getrennt), beginnt die Runde
 * vorne – vorhersagbar ist wichtiger als fair: vor dem Spiegel soll niemand
 * raetseln, warum die Reihenfolge springt.
 */
export function nextShown(slots: readonly number[], current: number | null): number | null {
  if (slots.length === 0) return null;
  const index = current === null ? -1 : slots.indexOf(current);
  if (index === -1) return slots[0] as number;
  return slots[(index + 1) % slots.length] as number;
}

/**
 * Akzentfarbe aus den Pixeln eines Covers – der Ton, der das Bild dominiert.
 *
 * Bewusst simpel: alle ausreichend gesaettigten Pixel stimmen ueber den
 * Farbton ab (als Vektorsumme, damit Rot bei 359 und 1 Grad nicht zu Cyan
 * mittelt), Saettigung und Helligkeit sind fest gewaehlt. Fest deshalb, weil
 * die Farbe auf schwarzem Glas lesbar sein muss – ein dunkles Cover darf
 * keine dunkle Schrift ergeben.
 */
export function accentFromPixels(rgba: ArrayLike<number>): string | null {
  let x = 0;
  let y = 0;
  let votes = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    const r = (rgba[i] as number) / 255;
    const g = (rgba[i + 1] as number) / 255;
    const b = (rgba[i + 2] as number) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) continue;
    const lightness = (max + min) / 2;
    const denominator = 1 - Math.abs(2 * lightness - 1);
    if (denominator <= 0) continue;
    const saturation = delta / denominator;
    // Graustufen und Extreme sagen nichts ueber den Charakter des Covers.
    if (saturation < 0.3 || lightness < 0.12 || lightness > 0.88) continue;

    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;

    const radians = (hue * Math.PI) / 180;
    x += Math.cos(radians) * saturation;
    y += Math.sin(radians) * saturation;
    votes += 1;
  }
  if (votes === 0) return null;
  let hue = (Math.atan2(y, x) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return `hsl(${Math.round(hue)}, 70%, 65%)`;
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
