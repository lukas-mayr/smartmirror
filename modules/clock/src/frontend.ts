import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';

interface ClockConfig {
  format24h: boolean;
  showSeconds: boolean;
  showDate: boolean;
  dateStyle: 'full' | 'long' | 'medium';
}

export default defineFrontend<Record<string, never>, ClockConfig>({
  create(host, ctx): ModuleView<Record<string, never>, ClockConfig> {
    let timer: number | undefined;
    let config = ctx.config;

    const draw = (): void => {
      const now = new Date();
      const time = new Intl.DateTimeFormat(ctx.locale, {
        hour: '2-digit',
        minute: '2-digit',
        ...(config.showSeconds ? { second: '2-digit' as const } : {}),
        hour12: !config.format24h,
        timeZone: ctx.timezone,
      }).format(now);

      /**
       * Der Wochentag steht ueber der Uhrzeit, das Datum darunter – dieselben
       * drei Ebenen wie im Spotify-Block. Den Wochentag gibt es nur im vollen
       * Datumsformat, weil ihn die beiden kuerzeren auch bisher nicht nennen.
       */
      const weekday =
        config.showDate && config.dateStyle === 'full'
          ? new Intl.DateTimeFormat(ctx.locale, {
              weekday: 'long',
              timeZone: ctx.timezone,
            }).format(now)
          : '';

      const date = config.showDate
        ? new Intl.DateTimeFormat(
            ctx.locale,
            config.dateStyle === 'medium'
              ? { dateStyle: 'medium', timeZone: ctx.timezone }
              : {
                  // Der Wochentag ist oben schon vergeben; hier bleibt das
                  // Datum selbst, in beiden Faellen gleich gesetzt.
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: ctx.timezone,
                },
          ).format(now)
        : '';

      /**
       * Die Zeichenzahl geht als Rechengroesse ins Stylesheet.
       *
       * Die Uhrzeit soll die Blockbreite ausfuellen, und wie breit sie wird,
       * haengt daran, was in ihr steht: "9:04 PM" ist ein Drittel breiter als
       * "21:04", mit Sekunden kommt noch einmal so viel dazu. Eine feste
       * Schriftgroesse muesste deshalb immer den schlimmsten Fall annehmen –
       * und waere in allen anderen zu klein. Mit der Zeichenzahl rechnet das
       * Stylesheet die Groesse selbst aus.
       */
      render(
        html`
          <div class="clock" style=${`--clock-chars:${time.length}`}>
            ${weekday ? html`<div class="clock__weekday">${weekday}</div>` : nothing}
            <div class="clock__time">${time}</div>
            ${date ? html`<div class="clock__date">${date}</div>` : nothing}
          </div>
        `,
        host,
      );
    };

    /**
     * Auf die naechste volle Sekunde bzw. Minute synchronisieren statt stumpf
     * alle 1000 ms zu ticken. Sonst springt die Anzeige irgendwann sichtbar
     * neben der echten Uhrzeit her, und ohne Sekunden waere jeder Tick
     * ausserdem 59-mal umsonst.
     */
    const schedule = (): void => {
      const period = config.showSeconds ? 1_000 : 60_000;
      const delay = period - (Date.now() % period);
      timer = window.setTimeout(() => {
        draw();
        schedule();
      }, delay);
    };

    draw();
    schedule();

    return {
      update(_state, nextConfig) {
        config = nextConfig;
        if (timer !== undefined) window.clearTimeout(timer);
        draw();
        schedule();
      },
      destroy() {
        if (timer !== undefined) window.clearTimeout(timer);
        render(html``, host);
      },
    };
  },
});
