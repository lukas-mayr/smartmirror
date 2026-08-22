import { html, render, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import {
  activeNotifications,
  ADVANCE_SECONDS,
  fitCount,
  restOpacity,
  slotCount,
  visibleWindow,
  VISIBLE_MIN,
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

    /**
     * Wieviele Positionen zuletzt gepasst haben.
     *
     * Steht hier und wird nicht bei jedem Zeichnen neu von null gemessen, weil
     * die erste Messung ein gerendertes Listenelement braucht: gezeichnet wird
     * mit dem letzten bekannten Wert, danach gemessen und, wenn sich etwas
     * geaendert hat, noch einmal gezeichnet. Beides passiert in derselben
     * Aufgabe, der Bildschirm sieht davon nichts.
     */
    let slots = VISIBLE_MIN;

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

    /**
     * Wieviele Positionen in den Block passen.
     *
     * Gemessen wird die Liste und nicht der Block: ueber ihr kann eine
     * Ueberschrift stehen, und der Platz, den die verbraucht, ist keiner mehr
     * fuer Mitteilungen. Die Blockhoehe wird trotzdem gebraucht — an ihr
     * haengen die Hoehendeckel der Positionen im Stylesheet.
     */
    const measure = (): number => {
      const block = host.querySelector<HTMLElement>('.feed');
      const list = host.querySelector<HTMLElement>('.feed__list');
      if (!block || !list) return slots;
      return fitCount(list.clientHeight, block.clientHeight);
    };

    const paint = (): void => {
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
       * nicht. Stehen alle Eintraege ohnehin gleichzeitig da, waere das
       * Nachruecken eine Bewegung ohne Inhalt, und im dunklen Raum weckt jede
       * Bewegung im Augenwinkel zuverlaessig auf.
       */
      const night = document.documentElement.dataset.night === '1';
      if (items.length > slots && !night) {
        startCycle(Math.max(1, config.advanceSeconds || ADVANCE_SECONDS) * 1000);
      } else {
        stopCycle();
      }

      const window = visibleWindow(items, night ? 0 : offset, slots);
      const top = window[0];
      /* Wieviele Positionen unterhalb der obersten wirklich besetzt sind – der
         Verlauf der Deckkraft verteilt sich auf sie und nicht auf die Plaetze,
         die gerade leer bleiben. */
      const rest = window.length - 1;

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
                const lead = index === 0;
                const body = html`
                  <div
                    class="feed__item ${lead ? 'feed__item--lead' : 'feed__item--rest'} ${lead &&
                    item.urgent
                      ? 'feed__item--urgent'
                      : ''}"
                    style=${lead ? nothing : `opacity:${restOpacity(index, rest)}`}
                  >
                    ${item.label ? html`<span class="feed__label">${item.label}</span>` : nothing}
                    <span class="feed__title">${item.title}</span>
                    ${item.meta ? html`<span class="feed__meta">${item.meta}</span>` : nothing}
                  </div>
                `;
                /*
                 * Nur die oberste Position wird neu aufgebaut und blendet damit
                 * ein. Die darunter behalten ihre Elemente: sie ruecken nach,
                 * und Nachruecken ist keine Ankunft — wuerden auch sie
                 * einblenden, blitzte bei jedem Takt die halbe Hauptzone auf.
                 */
                return lead && top ? keyed(top.id, body) : body;
              })}
            </div>
          </div>
        `,
        host,
      );
    };

    /**
     * Zeichnen und dabei pruefen, ob die Zahl der Positionen noch stimmt.
     *
     * Die zweite Runde kostet nichts Sichtbares: Lit rendert synchron, der
     * Browser zeichnet erst danach. Sie laeuft hoechstens einmal, weil die
     * Hoehe der Liste nicht daran haengt, wieviel darin steht — sie fuellt den
     * Block, und was nicht hineinpasst, wird abgeschnitten statt ihn zu
     * dehnen.
     */
    const draw = (): void => {
      paint();
      const fits = slotCount(config.visibleCount, measure());
      if (fits === slots) return;
      slots = fits;
      paint();
    };

    /*
     * Der Block aendert seine Groesse, wenn die Anordnung wechselt oder der
     * Bildschirm gedreht wird. Dann passen andere Zahlen von Positionen — ohne
     * das hier stuende die Liste bis zum naechsten Takt in der alten Laenge da.
     */
    const observer = new ResizeObserver(() => draw());
    observer.observe(host);

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
        observer.disconnect();
        render(html``, host);
      },
    };
  },
});
