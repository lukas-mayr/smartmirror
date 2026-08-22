import { html, render, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import {
  accentForTemperature,
  buildSlides,
  describeWeather,
  toCelsius,
  type WeatherConfig,
  type WeatherSlide,
  type WeatherState,
} from './shared.js';

/** Ab wann ein Wert als veraltet gilt und dezent abgedunkelt wird. */
const STALE_AFTER_MS = 90 * 60_000;

/**
 * Wie lange eine Karte stehen bleibt.
 *
 * Fuenf Sekunden sind lang genug, um im Vorbeigehen einen ganzen Tag zu lesen –
 * Beschriftung, Zahl, Kurztext – und kurz genug, dass man vor dem Spiegel nicht
 * wartet, bis der gesuchte Tag wiederkommt.
 */
const SLIDE_MS = 5_000;

export default defineFrontend<WeatherState, WeatherConfig>({
  create(host, ctx): ModuleView<WeatherState, WeatherConfig> {
    let state: Partial<WeatherState> = {};
    let config = ctx.config;
    let error: string | null = null;

    /** Zaehlt nur hoch; welche Karte das ist, entscheidet die Stapelgroesse. */
    let position = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopCycle = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const startCycle = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => {
        position += 1;
        draw();
      }, SLIDE_MS);
    };

    /** Eine Karte – fuer heute wie fuer jeden Vorhersagetag dieselbe Form. */
    const card = (slide: WeatherSlide, unit: string, accent: string | null) => html`
      <div class="weather__slide">
        <div class="weather__label">${slide.label}</div>
        <div class="weather__now">
          <span class="weather__icon">${icon(slide.icon, { size: '1em', strokeWidth: 1.5 })}</span>
          <span class="weather__temp"
            >${slide.temperature}<span class="weather__unit">${unit}</span></span
          >
        </div>
        <div class="weather__meta" style=${accent ? `color:${accent}` : nothing}>
          <span>${slide.note}</span>
        </div>
      </div>
    `;

    const draw = (): void => {
      const current = state.current;
      const stale =
        state.fetchedAt !== null &&
        state.fetchedAt !== undefined &&
        Date.now() - Date.parse(state.fetchedAt) > STALE_AFTER_MS;

      if (!current) {
        stopCycle();
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

      /**
       * Der grosse Block schaltet durch, statt alles nebeneinander zu zeigen.
       *
       * Er ist der einzige, der hoch genug ist, dass eine Karte mit grosser
       * Beschriftung, grossem Symbol und grosser Zahl darin Platz hat – im
       * mittleren Block bliebe von jeder Zeile ein Rest, im breiten steht die
       * Vorhersagereihe ohnehin komplett und braucht niemanden, der wartet.
       *
       * Sind die Werte veraltet oder die Abfrage fehlgeschlagen, faellt auch der
       * grosse Block auf die feste Ansicht zurueck: eine Durchschaltung, die
       * alte Tage durchblaettert, sieht lebendiger aus, als die Daten sind.
       */
      const cycling = host.dataset.size === 'l' && !stale && !error;
      const slides = cycling
        ? buildSlides(state, config, { locale: ctx.locale, timeZone: ctx.timezone })
        : [];

      if (slides.length > 1) startCycle();
      else stopCycle();

      if (slides.length > 0) {
        const slide = slides[position % slides.length] as WeatherSlide;
        const slideAccent = accentForTemperature(slide.celsius);
        /**
         * Die laengste Beschriftung des Stapels bestimmt die Schriftgroesse
         * aller – "Heute" duerfte allein groesser stehen als "Uebermorgen",
         * aber dann waere die Karte bei jedem Wechsel eine andere. Die Untergrenze
         * verhindert, dass ein Stapel aus lauter kurzen Woertern die Zeile
         * ueber den Block hinaus aufblaest.
         */
        const labelChars = Math.max(6, ...slides.map((entry) => entry.label.length));
        render(
          html`
            <div class="weather weather--deck">
              ${state.resolvedLocation
                ? html`<div class="weather__place">${state.resolvedLocation}</div>`
                : nothing}
              <div class="weather__deck" style="--weather-label-chars:${labelChars}">
                ${keyed(slide.key, card(slide, unit, slideAccent))}
              </div>
            </div>
          `,
          host,
        );
        return;
      }

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
        stopCycle();
        render(html``, host);
      },
    };
  },
});
