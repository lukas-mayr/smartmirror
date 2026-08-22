import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import {
  accentForTemperature,
  describeWeather,
  toCelsius,
  type WeatherConfig,
  type WeatherState,
} from './shared.js';

/** Ab wann ein Wert als veraltet gilt und dezent abgedunkelt wird. */
const STALE_AFTER_MS = 90 * 60_000;

export default defineFrontend<WeatherState, WeatherConfig>({
  create(host, ctx): ModuleView<WeatherState, WeatherConfig> {
    let state: Partial<WeatherState> = {};
    let config = ctx.config;
    let error: string | null = null;

    const draw = (): void => {
      const current = state.current;
      const stale =
        state.fetchedAt !== null &&
        state.fetchedAt !== undefined &&
        Date.now() - Date.parse(state.fetchedAt) > STALE_AFTER_MS;

      if (!current) {
        render(
          html`<div class="weather weather--empty">
            ${error ? html`<span class="weather__error">${error}</span>` : 'Wetter wird geladen …'}
          </div>`,
          host,
        );
        return;
      }

      const now = describeWeather(current.weatherCode, current.isDay);
      const unit = state.temperatureUnit ?? '°';

      /**
       * Der Ton kommt aus der Temperatur – und nur, solange die Zahl auch
       * stimmt. Ein veralteter Wert faerbt nichts mehr ein, sonst behauptete
       * die Farbe eine Frische, die die Zahl nicht mehr hat.
       */
      const accent =
        stale || error ? null : accentForTemperature(toCelsius(current.temperature, config.units));

      render(
        html`
          <div class="weather ${stale || error ? 'weather--stale' : ''}">
            ${state.resolvedLocation
              ? html`<div class="weather__place">${state.resolvedLocation}</div>`
              : nothing}
            <div class="weather__now">
              <span class="weather__icon">${icon(now.icon, { size: '1em', strokeWidth: 1.5 })}</span>
              <span class="weather__temp"
                >${current.temperature}<span class="weather__unit">${unit}</span></span
              >
            </div>
            <div class="weather__meta" style=${accent ? `color:${accent}` : nothing}>
              <span>${now.label}</span>
              ${config.showWind
                ? html`<span class="weather__sep">·</span>
                    <span>${current.windSpeed} ${state.windUnit ?? 'km/h'}</span>`
                : nothing}
            </div>
            ${state.forecast && state.forecast.length > 0
              ? html`
                  <div class="weather__forecast">
                    ${state.forecast.map((day) => {
                      const appearance = describeWeather(day.weatherCode);
                      const label = new Intl.DateTimeFormat(ctx.locale, {
                        weekday: 'short',
                        timeZone: ctx.timezone,
                      }).format(new Date(`${day.date}T12:00:00`));
                      return html`
                        <div class="weather__day">
                          <span class="weather__day-name">${label}</span>
                          <span class="weather__day-icon">
                            ${icon(appearance.icon, { size: '1em', strokeWidth: 1.6, title: appearance.label })}
                          </span>
                          <span class="weather__day-range">${day.max}° <i>${day.min}°</i></span>
                        </div>
                      `;
                    })}
                  </div>
                `
              : nothing}
            ${error || stale
              ? html`<div class="weather__hint">
                  ${error ?? 'Keine aktuellen Daten'}${state.fetchedAt
                    ? html` · Stand
                        ${new Intl.DateTimeFormat(ctx.locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: ctx.timezone,
                        }).format(new Date(state.fetchedAt))}`
                    : nothing}
                </div>`
              : nothing}
          </div>
        `,
        host,
      );
    };

    draw();

    return {
      update(nextState, nextConfig) {
        state = { ...state, ...nextState };
        config = nextConfig;
        draw();
      },
      setError(nextError) {
        error = nextError;
        draw();
      },
      destroy() {
        render(html``, host);
      },
    };
  },
});
