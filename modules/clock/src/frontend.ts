import { html, render } from 'lit';
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

      const date = config.showDate
        ? new Intl.DateTimeFormat(ctx.locale, {
            dateStyle: config.dateStyle,
            timeZone: ctx.timezone,
          }).format(now)
        : '';

      render(
        html`
          <div class="clock">
            <div class="clock__time">${time}</div>
            ${date ? html`<div class="clock__date">${date}</div>` : null}
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
