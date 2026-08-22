import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import { describeEvent, type CalendarConfig, type CalendarState } from './shared.js';

/**
 * Wieviele Zeilen in einen Block dieser Hoehe passen.
 *
 * Dieselbe Rechnung wie im Mitteilungsblock, nur mit einer Zeilenhoehe: hier
 * traegt keine Zeile eine Flaeche, alle sind gleich gross. Was nicht ganz
 * hineinpasst, wird nicht gezeigt — eine halbe Zeile am unteren Rand liest
 * sich als Fehler.
 */
const ROW_HEIGHT = 96;
const ROW_GAP = 16;

export default defineFrontend<CalendarState, CalendarConfig>({
  create(host, ctx): ModuleView<CalendarState, CalendarConfig> {
    let state: Partial<CalendarState> = {};
    let config = ctx.config;
    let rows = 1;

    /**
     * Die Beschriftung wird jede Minute neu gerechnet.
     *
     * "in 18 min" ist eine Minute spaeter falsch, und der Zustand aendert sich
     * dabei nicht — es gaebe also nichts, was das Neuzeichnen ausloeste. Das
     * Backend rechnet im selben Takt neu, aber zwischen zwei Meldungen liegt
     * die Anzeige sonst bis zu einer Minute daneben.
     */
    const timer = setInterval(() => draw(), 30_000);

    const measure = (): number => {
      const list = host.querySelector<HTMLElement>('.agenda__list');
      if (!list) return rows;
      const height = list.clientHeight;
      if (!Number.isFinite(height) || height <= 0) return rows;
      return Math.max(1, Math.floor((height + ROW_GAP) / (ROW_HEIGHT + ROW_GAP)));
    };

    const paint = (): void => {
      const events = (state.events ?? []).slice(0, rows);
      const stale = (state.failing ?? []).length > 0;

      /*
       * Ein Kalender ohne Termine zeigt nichts.
       *
       * Kein "Keine Termine": das ist die Auskunft, dass nichts zu sagen ist,
       * und die faellt auf einem Spiegel mehr auf als eine leere Flaeche. Wer
       * einen freien Tag hat, sieht das an der Leere.
       */
      if (events.length === 0) {
        render(html``, host);
        return;
      }

      const now = new Date();
      render(
        html`
          <div class="agenda ${stale ? 'agenda--stale' : ''}">
            <div class="agenda__list">
              ${events.map((event) => {
                const { day, time } = describeEvent(event, now, ctx.timezone, ctx.locale);
                const when = [day, time].filter((part) => part.length > 0).join(' ');
                return html`
                  <div class="agenda__row ${event.allDay ? 'agenda__row--allday' : ''}">
                    <span class="agenda__when">${when || 'heute'}</span>
                    <span class="agenda__body">
                      <span class="agenda__title">${event.title}</span>
                      ${event.location || event.calendar
                        ? html`<span class="agenda__meta"
                            >${[event.location, event.calendar].filter(Boolean).join(' · ')}</span
                          >`
                        : nothing}
                    </span>
                  </div>
                `;
              })}
            </div>
            ${stale
              ? html`<div class="agenda__hint">
                  <span>${icon('triangle-alert', { size: '1em' })}</span>
                  <span>${(state.failing ?? []).join(', ')} nicht erreichbar</span>
                </div>`
              : nothing}
          </div>
        `,
        host,
      );
    };

    const draw = (): void => {
      paint();
      const fits = Math.min(measure(), Math.max(1, config.maxEvents));
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
        render(html``, host);
      },
    };
  },
});
