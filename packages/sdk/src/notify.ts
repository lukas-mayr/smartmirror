/**
 * Mitteilungen zwischen den Modulen.
 *
 * Der Mitteilungsfeed ist eine Anzeigeflaeche und keine Datenquelle: was eine
 * Mitteilung ist, weiss der Kalender, das Wetter oder die Abfahrtstafel — und
 * jedes dieser Module hat den Zustand ohnehin schon, weil es ihn in seinem
 * eigenen Block zeigt. Es waere doppelte Arbeit, ihn ein zweites Mal in einem
 * Feed-Modul zu holen, und ein zweiter Abruf derselben Quelle waere nebenbei
 * auch ein zweites Mal Netzlast.
 *
 * Deshalb dieser Weg: ein Modul meldet mit `ctx.notify(...)`, was gerade
 * mitteilenswert ist, der Host sammelt die Meldungen aller Instanzen ein, und
 * wer `ctx.onNotifications(...)` hoert, bekommt den zusammengelegten Stand.
 * Die Quelle kennt den Feed nicht, der Feed kennt die Quellen nicht.
 *
 * Gemeldet wird immer der vollstaendige aktuelle Stand einer Instanz und nie
 * ein Zuwachs. Was in der neuen Meldung fehlt, ist weg — ohne Loeschbefehl,
 * ohne Aufraeumen, ohne die Frage, wer fuer einen verwaisten Eintrag zustaendig
 * ist. Ein Kalender, der um 09:31 den Termin von 09:30 nicht mehr meldet, hat
 * ihn damit zurueckgezogen.
 */

export interface FeedNotification {
  /**
   * Eindeutig ueber alle Quellen. Der Host stellt die Instanz voran, ein Modul
   * muss also nur innerhalb der eigenen Meldung eindeutig sein.
   */
  id: string;
  /** Woher die Mitteilung kommt: "Termin", "Bus 142", "Warnung". */
  label: string;
  /** Die Aussage in wenigen Woertern: "Standup", "Sturmwarnung". */
  title: string;
  /** Zweitzeile mit Zeit, Ort oder Wahrscheinlichkeit. */
  meta: string;
  /**
   * Dringendes rueckt sofort nach oben und bekommt Sand statt Salbei.
   *
   * Bewusst ein Schalter und keine Prioritaetszahl: eine Skala von 1 bis 5
   * beantwortet die Frage nicht, die auf einem Spiegel zaehlt — steht es ganz
   * oben oder nicht. Und wer drei Stufen hat, vergibt irgendwann nur noch die
   * hoechste.
   */
  urgent: boolean;
  /**
   * Wann es soweit ist. Sortiert den Feed – der naechste Termin steht oben.
   *
   * Getrennt von `expiresAt`, weil das zwei verschiedene Fragen sind: wann es
   * losgeht und wie lange die Zeile noch etwas taugt. Eine Sturmwarnung ab
   * Mitternacht gilt schon jetzt, ein Bus um 09:30 ist um 09:31 falsch.
   */
  at: string | null;
  /** Zeitpunkt, ab dem die Mitteilung nicht mehr gezeigt wird. */
  expiresAt: string | null;
  /** Modul-Id der Quelle. Setzt der Host, ein Modul kann sie nicht faelschen. */
  source: string;
}

/** Was ein Modul melden darf. Alles ausser dem Titel ist freiwillig. */
export interface NotificationInput {
  id?: string;
  label?: string;
  title: string;
  meta?: string;
  urgent?: boolean;
  at?: string | Date | null;
  expiresAt?: string | Date | null;
  /** Sekunden ab jetzt. Bequemer als ein Zeitstempel fuer "gilt zehn Minuten". */
  ttlSeconds?: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stamp(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const raw = text(value);
  if (raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Eine gemeldete Mitteilung in die Form bringen, in der der Feed sie erwartet.
 *
 * Gibt `null` zurueck, wenn kein Titel dasteht: eine Mitteilung ohne Aussage
 * ist keine. Alles andere wird geradegebogen statt verworfen — ein Modul, das
 * wegen eines leeren Feldes gar nichts meldet, ist schlechter als eine Zeile
 * ohne Zusatz.
 */
export function normalizeNotification(
  input: NotificationInput,
  source: string,
  instanceId: string,
  index: number,
  now: Date = new Date(),
): FeedNotification | null {
  const title = text(input.title);
  if (title.length === 0) return null;

  const ttl = Number(input.ttlSeconds);
  const expiresAt =
    Number.isFinite(ttl) && ttl > 0
      ? new Date(now.getTime() + ttl * 1000).toISOString()
      : stamp(input.expiresAt);

  return {
    // Die Instanz und nicht das Modul: zwei Kalenderbloecke sind zwei Quellen,
    // und ihre Termine duerfen einander nicht ueberschreiben.
    id: `${instanceId}:${text(input.id) || String(index)}`,
    label: text(input.label),
    title,
    meta: text(input.meta),
    urgent: input.urgent === true,
    at: stamp(input.at),
    expiresAt,
    source,
  };
}

/**
 * Was gerade noch gilt.
 *
 * Abgelaufenes faellt heraus: eine Mitteilung "Bus in 7 min" von vor einer
 * Stunde ist keine veraltete Information, sondern eine falsche. Ein
 * unlesbarer Zeitstempel gilt weiter — lieber eine Mitteilung zu lang als
 * eine, die wegen eines Tippfehlers nie erscheint.
 */
export function activeNotifications(
  items: readonly FeedNotification[],
  now: Date = new Date(),
): FeedNotification[] {
  const stampNow = now.getTime();
  return items.filter((item) => {
    if (!item.expiresAt) return true;
    const expires = Date.parse(item.expiresAt);
    return !Number.isFinite(expires) || expires > stampNow;
  });
}

/**
 * Die Reihenfolge, in der gezeigt wird.
 *
 * Dringendes zuerst, dann das, was als naechstes ansteht, dann der Rest in der
 * Reihenfolge, in der er hereinkam. Ohne die Zeit stuende die Abfahrt in sieben
 * Minuten hinter dem Termin von morgen, nur weil das Kalendermodul frueher
 * gemeldet hat — und der Feed zeigte zuverlaessig das Falsche zuerst.
 *
 * Ein stabiler Sortierlauf: gleich eingestufte behalten ihre Reihenfolge, und
 * die Liste springt nicht bei jedem Zeichnen um.
 */
export function sortNotifications(items: readonly FeedNotification[]): FeedNotification[] {
  return [...items].sort((a, b) => {
    if (a.urgent !== b.urgent) return Number(b.urgent) - Number(a.urgent);
    if (a.at && b.at) return Date.parse(a.at) - Date.parse(b.at);
    // Mit Zeitpunkt vor ohne: was einen Zeitpunkt hat, ist terminiert, und
    // Terminiertes draengt.
    if (a.at) return -1;
    if (b.at) return 1;
    return 0;
  });
}
