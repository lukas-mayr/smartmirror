import { DIG } from '@mirror/sdk';

/**
 * Der Timer, als Rechnung.
 *
 * Ein Timer auf einem Spiegel ist etwas anderes als einer auf dem Herd: man
 * bedient ihn nicht, man geht an ihm vorbei. Deshalb steht die Restzeit hier
 * zweimal — als Ziffern fuer den, der hinsieht, und als Berg fuer den, der nur
 * vorbeigeht. Der Berg ist die eigentliche Anzeige; die Ziffern sind die
 * Nachfrage.
 *
 * Was in dieser Datei steht, ist die Rechnung dahinter und kein Zeichencode:
 * wieviel Zeit noch laeuft, aus wievielen Eimern der Berg besteht und wieviel
 * von ihm noch steht. Gezeichnet wird in scene.ts, und die Bewegung liegt im
 * Stylesheet. Der Schnitt laeuft wie beim Wetter entlang der Frage, wer einen
 * Browser braucht: die Rechnung nicht, das Zeichnen schon — und nur so laesst
 * sich die Rechnung pruefen.
 *
 * Die eine Regel, an der alles haengt: **der Bagger arbeitet immer gleich
 * schnell.** Ein Eimer dauert `DIG.bucket`, ob der Timer auf drei Minuten oder
 * auf zwei Stunden steht. Was sich mit der Dauer aendert, ist der Berg. Ein
 * Bagger, der bei einer Stunde in Zeitlupe schwenkt, sieht nicht nach viel
 * Arbeit aus, sondern nach einem haengenden Bildschirm.
 */

export interface TimerConfig {
  /** Wofuer der Timer laeuft. Steht ueber der Zeit und in der Mitteilung. */
  label: string;
  /** Dauer in Minuten. */
  minutes: number;
  /**
   * Laeuft er?
   *
   * Ein Schalter und kein Kommando, weil die Handy-App ihr Formular aus dem
   * Schema baut und ein Modul dort keine eigene Oberflaeche hat. Einschalten
   * startet den Timer von vorn — die Instanz wird bei jeder
   * Konfigurationsaenderung neu gestartet, und genau dieser Neustart *ist* der
   * Startknopf.
   */
  running: boolean;
}

export interface TimerState {
  /** ISO-Zeitstempel des Starts. `null` heisst: es laeuft keiner. */
  startedAt: string | null;
  /** ISO-Zeitstempel des Endes. `null` heisst: es laeuft keiner. */
  endsAt: string | null;
}

/**
 * Die beiden Zeitpunkte, auf die sich alles bezieht — oder `null`.
 *
 * Absolute Zeitpunkte und keine Restdauer: die Anzeige rechnet die Restzeit
 * selbst aus und braucht dafuer keinen Sekundentakt vom Core. Ein Timer, der
 * jede Sekunde eine Nachricht ueber den Bus schickt, waere sechzig Nachrichten
 * je Minute fuer eine Zahl, die auf beiden Seiten dieselbe Uhr hat.
 */
export interface TimerWindow {
  start: number;
  end: number;
}

export function timerWindow(state: Partial<TimerState> | undefined): TimerWindow | null {
  const start = Date.parse(state?.startedAt ?? '');
  const end = Date.parse(state?.endsAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** Die eingestellte Dauer in Millisekunden. Unsinn wird zur Voreinstellung. */
export function durationMs(minutes: unknown): number {
  const value = typeof minutes === 'number' ? minutes : Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 10 * 60_000;
  return Math.round(value) * 60_000;
}

/**
 * Aus wievielen Eimern der Berg besteht.
 *
 * Die Dauer geteilt durch die Taktung des Baggers — nicht umgekehrt. Genau
 * hier steckt die Regel: die Zahl der Eimer richtet sich nach der Zeit, die
 * Dauer eines Eimers nie nach der Zahl. Mindestens einer, sonst gaebe es bei
 * sehr kurzen Timern nichts zu graben.
 */
export function bucketCount(totalMs: number): number {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 1;
  return Math.max(1, Math.round(totalMs / DIG.bucket));
}

/** Wieviele Lastwagen der Berg fuellt. */
export function loadCount(totalMs: number): number {
  return Math.max(1, Math.ceil(bucketCount(totalMs) / DIG.perLoad));
}

/**
 * Wie gross der Berg zu Beginn ist, als Anteil des Platzes, den er hoechstens
 * einnehmen darf.
 *
 * Der Anteil waechst mit der Zahl der Ladungen, aber gedaempft: der Block
 * waechst nicht mit, und bei linearem Zusammenhang waere ein
 * Zehn-Minuten-Berg ein Kruemel neben dem Zwei-Stunden-Berg. Nach unten haelt
 * eine Grenze den Berg als Berg erkennbar — sonst schaufelte der Bagger
 * sichtbar an einem Strich.
 */
export function mountainSize(totalMs: number): number {
  const share = loadCount(totalMs) / DIG.fullLoads;
  return Math.min(1, Math.max(DIG.minSize, share ** DIG.growth));
}

/**
 * Wieviel vom Berg noch steht, als Anteil zwischen 1 und 0.
 *
 * In Stufen und nicht stufenlos: jeder Eimer nimmt einen sichtbaren Bissen
 * heraus, und zwischen zwei Eimern steht der Berg still. Das ist der ganze
 * Sinn der Darstellung — der Berg wird kleiner, *weil* der Bagger gegraben
 * hat, und nicht, weil die Zeit vergeht. Bei einem kurzen Timer sieht man die
 * Stufen einzeln, bei einem langen fliessen sie ineinander; die Rechnung ist
 * dieselbe.
 */
export function remainingShare(elapsedMs: number, totalMs: number): number {
  const buckets = bucketCount(totalMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  const dug = Math.floor(elapsedMs / DIG.bucket);
  return Math.min(1, Math.max(0, 1 - dug / buckets));
}

/**
 * Wo im Takt des Baggers wir gerade sind, in Millisekunden seit dem Beginn
 * einer Ladung.
 *
 * Die Bewegung liegt im Stylesheet und laeuft dort in ihrem eigenen Takt. Ohne
 * diesen Versatz begaenne sie in dem Moment, in dem die Anzeige das Bild
 * aufbaut — und der Bissen aus dem Berg faende irgendwo zwischen zwei
 * Schwenks statt. Als negative `animation-delay` gesetzt, faengt die Bewegung
 * dort an, wo sie stehen muesste.
 *
 * Gerechnet wird auf die Ladung und nicht auf den Eimer: sie ist das laengste
 * der beiden Muster, und ein Versatz, der fuer sie stimmt, stimmt fuer den
 * Eimer mit — er ist ein ganzer Teil davon.
 */
export function digPhaseMs(elapsedMs: number): number {
  const period = DIG.bucket * DIG.perLoad;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return elapsedMs % period;
}

/**
 * Die Restzeit als Ziffern.
 *
 * Aufgerundet auf die naechste Sekunde: solange noch etwas laeuft, soll da
 * nicht 0:00 stehen. Ueber einer Stunde kommt die Stunde dazu, darunter nicht
 * — "00:12:34" liest sich schlechter als "12:34" und beantwortet dieselbe
 * Frage.
 */
export function formatRemaining(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Der Name des Timers, auf ein vernuenftiges Mass gebracht. */
export function timerLabel(label: unknown): string {
  const text = typeof label === 'string' ? label.trim() : '';
  return text.length > 0 ? text : 'Timer';
}
