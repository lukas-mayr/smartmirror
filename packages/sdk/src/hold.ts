/**
 * Wie ein Block den Spiegel anhaelt.
 *
 * Der Spiegel schaltet weiter: Screens im Kreis, das Fussband der Reihe nach.
 * Das ist richtig, solange nichts laeuft — und falsch in dem einen Moment, in
 * dem doch etwas laeuft. Ein Timer, der bei 3:41 weggeschaltet wird, ist kein
 * Timer mehr, sondern eine Zahl, die man verpasst hat.
 *
 * Der Vorgang hat deshalb zwei Haelften, und die gehoeren verschiedenen
 * Parteien:
 *
 *   **Der Block bittet.** Er schreibt `data-hold` an sein Host-Element,
 *   solange bei ihm etwas laeuft, und nimmt es weg, wenn es vorbei ist. Nur
 *   das Modul weiss, wann das ist — beim Timer ist es nicht "der Block zeigt
 *   etwas" (nach Ablauf steht dort weiter "Fertig"), sondern "die Zeit
 *   laeuft noch".
 *
 *   **Der Nutzer erlaubt.** Ohne `priority` an der Instanz bleibt die Bitte
 *   folgenlos. Ein Modul, das den Spiegel von sich aus anhalten koennte,
 *   waere ein Modul, das die Anzeige uebernimmt — und die gehoert dem, der
 *   davorsteht.
 *
 * Dass der Weg ueber ein Attribut am Host laeuft und nicht ueber das
 * Protokoll, ist dieselbe Entscheidung wie bei `data-size` in der
 * Gegenrichtung: Anzeige und Modul teilen sich genau ein Element, und was
 * beide angeht, steht daran. Ein Feld im Zustand waere ausserdem ein zweiter
 * Ort fuer dieselbe Aussage — einer, der falsch stehen kann, wenn der Block
 * schon "Fertig" zeichnet und der Zustand noch unterwegs ist.
 */

/** Der Name in `dataset`. Als Attribut: `data-hold`. */
export const HOLD_ATTRIBUTE = 'hold';

/** Traegt der Block gerade die Bitte, stehen zu bleiben? */
export function isHolding(host: { dataset: DOMStringMap }): boolean {
  return host.dataset[HOLD_ATTRIBUTE] === '1';
}

/**
 * Setzt die Bitte oder nimmt sie zurueck.
 *
 * Geschrieben wird nur, wenn sich etwas aendert. Das ist keine Sparsamkeit,
 * sondern Voraussetzung: die Anzeige hoert auf Aenderungen dieses Attributs,
 * und ein Modul, das viermal je Sekunde zeichnet, wuerde ihr sonst viermal je
 * Sekunde dieselbe Nachricht schicken.
 */
export function setHold(host: { dataset: DOMStringMap }, holding: boolean): void {
  if (holding === isHolding(host)) return;
  if (holding) host.dataset[HOLD_ATTRIBUTE] = '1';
  else delete host.dataset[HOLD_ATTRIBUTE];
}
