import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import {
  boardScale,
  countdownParts,
  rowCount,
  vehicleIcon,
  type SbbConfig,
  type SbbState,
} from './shared.js';

export default defineFrontend<SbbState, SbbConfig>({
  create(host, ctx): ModuleView<SbbState, SbbConfig> {
    let state: Partial<SbbState> = {};
    let config = ctx.config;
    let rows = 1;

    /*
     * Der Countdown laeuft in der Anzeige mit.
     *
     * Das Backend rechnet alle zwanzig Sekunden neu, aber zwischen zwei
     * Meldungen stuende hier sonst eine Minutenzahl, die nicht mehr stimmt —
     * und bei einer Abfahrt ist genau die Zahl der Grund hinzusehen.
     */
    const timer = setInterval(() => draw(), 15_000);

    /*
     * Gemessen wird die Liste und der Block: die Liste, weil in sie die Zeilen
     * passen muessen, der Block, weil an seiner Hoehe der Deckel der Zeilenhoehe
     * im Stylesheet haengt. Wie im Mitteilungsblock — die Rechnung steht in
     * shared.ts, damit sie sich pruefen laesst.
     */
    const measure = (): number => {
      const block = host.querySelector<HTMLElement>('.board');
      const list = host.querySelector<HTMLElement>('.board__list');
      if (!block || !list) return rows;
      return rowCount(list.clientHeight, block.clientHeight, boardScale(config));
    };

    const paint = (): void => {
      const departures = (state.departures ?? []).slice(0, rows);

      // Keine Abfahrt heisst leere Flaeche – nachts faehrt eben nichts, und
      // ein Satz darueber ist eine Meldung, dass nichts zu melden ist.
      if (departures.length === 0) {
        render(html``, host);
        return;
      }

      const now = new Date();
      render(
        html`
          <div class="board">
            <div class="board__list">
              ${departures.map((departure) => {
                const when = countdownParts(departure, now, ctx.locale, ctx.timezone);
                /*
                 * Eine Zeile: Fahrzeug, Linie, Ziel, Gleis, Restzeit.
                 *
                 * Symbole tragen, was frueher Woerter trugen — das Fahrzeug
                 * statt gar nichts, der Wegweiser statt "Gleis", das Kreuz
                 * statt "faellt aus". Was dadurch an Breite frei wird, bekommen
                 * die Ziffern rechts: sie sind der Grund, weswegen jemand
                 * hersieht.
                 */
                return html`
                  <div class="board__row ${departure.cancelled ? 'board__row--cancelled' : ''}">
                    <span class="board__mode">${icon(vehicleIcon(departure), { size: '1em' })}</span>
                    <span class="board__line">${departure.line}</span>
                    <span class="board__body">
                      <span class="board__destination">${departure.destination}</span>
                    </span>
                    ${departure.track
                      ? html`<span class="board__track">
                          ${icon('signpost', { size: '1.25em' })}${departure.track}
                        </span>`
                      : nothing}
                    <span class="board__when">
                      ${when.cancelled
                        ? html`<span class="board__cancelled" title="faellt aus">
                            ${icon('octagon-x', { size: '1em', title: 'faellt aus' })}
                          </span>`
                        : html`
                            <span class="board__value">${when.value}</span>
                            ${when.unit ? html`<span class="board__unit">${when.unit}</span>` : nothing}
                            ${departure.delay > 0
                              ? html`<span class="board__delay">+${departure.delay}</span>`
                              : nothing}
                          `}
                    </span>
                  </div>
                `;
              })}
            </div>
          </div>
        `,
        host,
      );
    };

    /**
     * Zeichnen und dabei pruefen, ob die Zahl der Zeilen noch stimmt.
     *
     * Die zweite Runde kostet nichts Sichtbares: Lit rendert synchron, der
     * Browser zeichnet erst danach.
     */
    const draw = (): void => {
      // Der Faktor steht am Block und nicht im Stylesheet: dort kennt niemand
      // die Einstellung, und eine Deklaration auf `.board` gewaenne gegen den
      // geerbten Wert.
      host.style.setProperty('--board-scale', String(boardScale(config)));
      paint();
      const fits = measure();
      if (fits === rows) return;
      rows = fits;
      paint();
    };

    const observer = new ResizeObserver(() => draw());
    observer.observe(host);
    draw();

    return {
      update(nextState, nextConfig) {
        state = { ...state, ...nextState };
        config = nextConfig;
        draw();
      },
      destroy() {
        clearInterval(timer);
        observer.disconnect();
        host.style.removeProperty('--board-scale');
        render(html``, host);
      },
    };
  },
});
