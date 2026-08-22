import { html, render, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import {
  activeNotifications,
  ADVANCE_SECONDS,
  visibleWindow,
  VISIBLE,
  type NotificationsConfig,
  type NotificationsState,
} from './shared.js';

export default defineFrontend<NotificationsState, NotificationsConfig>({
  create(host, ctx): ModuleView<NotificationsState, NotificationsConfig> {
    let state: Partial<NotificationsState> = {};
    let config = ctx.config;

    /** Zaehlt nur hoch; welcher Eintrag oben steht, ergibt sich aus der Laenge. */
    let offset = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopCycle = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const startCycle = (interval: number): void => {
      if (timer !== null) return;
      timer = setInterval(() => {
        offset += 1;
        draw();
      }, interval);
    };

    const draw = (): void => {
      const items = activeNotifications(state.items ?? []);

      /*
       * Ein leerer Feed rendert gar nichts.
       *
       * Kein "Keine Mitteilungen", kein Platzhalter, keine Ueberschrift ueber
       * einer leeren Liste: eine leere Flaeche auf einem Spiegel ist ein
       * Spiegel und faellt niemandem auf, ein Satz darueber faellt jedem auf.
       */
      if (items.length === 0) {
        stopCycle();
        render(html``, host);
        return;
      }

      /*
       * Nachgerueckt wird nur, wenn es mehr gibt als Plaetze — und nachts gar
       * nicht. Bei drei Eintraegen auf drei Positionen waere das Nachruecken
       * eine Bewegung ohne Inhalt, und im dunklen Raum weckt jede Bewegung im
       * Augenwinkel zuverlaessig auf.
       */
      const night = document.documentElement.dataset.night === '1';
      if (items.length > VISIBLE && !night) {
        startCycle(Math.max(1, config.advanceSeconds || ADVANCE_SECONDS) * 1000);
      } else {
        stopCycle();
      }

      const window = visibleWindow(items, night ? 0 : offset);
      const top = window[0];

      render(
        html`
          <div class="feed">
            ${config.showHeading
              ? html`<div class="feed__head">
                  <span>Mitteilungen</span>
                  <span class="feed__rule"></span>
                  <span class="feed__count">${items.length}</span>
                </div>`
              : nothing}
            <div class="feed__list">
              ${window.map((item, index) => {
                const body = html`
                  <div
                    class="feed__item feed__item--${index + 1} ${index === 0 && item.urgent
                      ? 'feed__item--urgent'
                      : ''}"
                  >
                    ${item.label ? html`<span class="feed__label">${item.label}</span>` : nothing}
                    <span class="feed__title">${item.title}</span>
                    ${item.meta ? html`<span class="feed__meta">${item.meta}</span>` : nothing}
                  </div>
                `;
                /*
                 * Nur die oberste Position wird neu aufgebaut und blendet damit
                 * ein. Die beiden darunter behalten ihre Elemente: sie ruecken
                 * nach, und Nachruecken ist keine Ankunft — wuerden auch sie
                 * einblenden, blitzte bei jedem Takt die halbe Hauptzone auf.
                 */
                return index === 0 && top ? keyed(top.id, body) : body;
              })}
            </div>
          </div>
        `,
        host,
      );
    };

    draw();

    return {
      update(nextState, nextConfig) {
        state = { ...state, ...nextState };
        // Eine geaenderte Taktung greift erst mit dem naechsten Takt, sonst
        // bliebe der alte Intervall bis zum naechsten Neustart stehen.
        if (nextConfig.advanceSeconds !== config.advanceSeconds) stopCycle();
        config = nextConfig;
        draw();
      },
      destroy() {
        stopCycle();
        render(html``, host);
      },
    };
  },
});
