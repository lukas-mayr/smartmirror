import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { countdown, type SbbConfig, type SbbState } from './shared.js';

/** Zeilenmass, wie im Kalender: was nicht ganz hineinpasst, wird nicht gezeigt. */
const ROW_HEIGHT = 88;
const ROW_GAP = 14;

export default defineFrontend<SbbState, SbbConfig>({
  create(host, ctx): ModuleView<SbbState, SbbConfig> {
    let state: Partial<SbbState> = {};
    let rows = 1;

    /*
     * Der Countdown laeuft in der Anzeige mit.
     *
     * Das Backend rechnet alle zwanzig Sekunden neu, aber zwischen zwei
     * Meldungen stuende hier sonst eine Minutenzahl, die nicht mehr stimmt —
     * und bei einer Abfahrt ist genau die Zahl der Grund hinzusehen.
     */
    const timer = setInterval(() => draw(), 15_000);

    const measure = (): number => {
      const list = host.querySelector<HTMLElement>('.board__list');
      if (!list) return rows;
      const height = list.clientHeight;
      if (!Number.isFinite(height) || height <= 0) return rows;
      return Math.max(1, Math.floor((height + ROW_GAP) / (ROW_HEIGHT + ROW_GAP)));
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
              ${departures.map(
                (departure) => html`
                  <div class="board__row ${departure.cancelled ? 'board__row--cancelled' : ''}">
                    <span class="board__line">${departure.line}</span>
                    <span class="board__body">
                      <span class="board__destination">${departure.destination}</span>
                      ${departure.track
                        ? html`<span class="board__track">Gleis ${departure.track}</span>`
                        : nothing}
                    </span>
                    <span class="board__when">
                      ${countdown(departure, now, ctx.locale, ctx.timezone)}
                      ${departure.delay > 0 && !departure.cancelled
                        ? html`<span class="board__delay">+${departure.delay}</span>`
                        : nothing}
                    </span>
                  </div>
                `,
              )}
            </div>
          </div>
        `,
        host,
      );
    };

    const draw = (): void => {
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
      update(nextState) {
        state = { ...state, ...nextState };
        draw();
      },
      destroy() {
        clearInterval(timer);
        observer.disconnect();
        render(html``, host);
      },
    };
  },
});
