/**
 * Durchschaltung innerhalb eines Bandes.
 *
 * Das Fussband einer Szene traegt breite, flache Elemente – "Laeuft gerade",
 * die naechste Verbindung, der naechste Termin. Zwei davon nebeneinander sind
 * zwei halbe Baender: jedes bekommt die halbe Breite, und beide werden zu
 * schmal fuer die Zeile, fuer die sie gedacht sind. Nebeneinander ist damit
 * die einzige Anordnung, die mit jedem weiteren Element schlechter wird.
 *
 * Nacheinander wird sie stattdessen laenger. Jedes Element bekommt das ganze
 * Band, und was es kostet, ist Zeit statt Breite – und Zeit hat der Screen
 * ohnehin: seine Standzeit ist die Zeit, die jemand vor dem Spiegel steht.
 *
 * Deshalb rechnet die Durchschaltung nicht mit einem eigenen Takt, sondern
 * teilt genau diese Standzeit auf. Ein Durchlauf ist dann so lang wie der
 * Screen: wer hinsieht, bis weitergeschaltet wird, hat jedes Element genau
 * einmal gesehen. Ein eigener Takt daneben waere eine zweite Zahl, die zur
 * ersten nicht passt – mal bliebe das letzte Element ungesehen, mal stuende
 * das erste zweimal da.
 */

/**
 * Standzeit eines einzelnen Elements, in Millisekunden.
 *
 * Die Standzeit des Screens durch die Anzahl. Nicht gerundet und nicht nach
 * unten begrenzt: eine Untergrenze machte den Durchlauf laenger als den
 * Screen, und dann waere das letzte Element genau das, das niemand sieht.
 * Ist es zu schnell, sind es zu viele Elemente oder zu wenig Standzeit – und
 * beides steht in der Handy-App, wo man es aendern kann.
 */
export function carouselSlotMs(screenDurationSeconds: number, count: number): number {
  const seconds = Number(screenDurationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (!Number.isInteger(count) || count < 1) return 0;
  return Math.round((seconds * 1000) / count);
}

/**
 * Wer als naechstes drankommt.
 *
 * `order` ist die vollstaendige Reihenfolge im Band, `eligible` die Teilmenge,
 * die gerade etwas zeigt. Beide getrennt, weil sich die zweite laufend
 * aendert: Spotify hat nichts laufen, die naechste Verbindung ist abgefahren –
 * solche Elemente stehen im Band, zeigen aber nichts, und ein Platz, auf dem
 * nichts steht, ist keine Karte, sondern eine Luecke im Durchlauf.
 *
 * Weitergezaehlt wird trotzdem entlang der vollen Reihenfolge und nicht
 * entlang der gerade sichtbaren. Sonst spraenge die Reihenfolge, sobald ein
 * Element dazukommt oder wegfaellt – und das faellt auf: die Elemente stehen
 * am Handy in einer Liste, und diese Liste ist die Reihenfolge, die jemand
 * erwartet.
 *
 * Faellt das gerade gezeigte Element selbst weg, gilt derselbe Weg: das
 * naechste hinter seinem Platz. Es bleibt also stehen, wo es stand.
 */
export function nextCarouselId(
  order: readonly string[],
  eligible: readonly string[],
  current: string | null,
): string | null {
  const shows = new Set(eligible);
  const usable = order.filter((id) => shows.has(id));
  if (usable.length === 0) return null;

  const start = current === null ? -1 : order.indexOf(current);
  if (start < 0) return usable[0] ?? null;

  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(start + step) % order.length];
    if (candidate !== undefined && shows.has(candidate)) return candidate;
  }
  return usable[0] ?? null;
}
