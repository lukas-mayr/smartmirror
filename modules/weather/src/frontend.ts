import { html, render, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { defineFrontend, MOTION, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import {
  accentForTemperature,
  barHeight,
  buildSlides,
  describeWeather,
  peakIndex,
  pickHourly,
  toCelsius,
  type HourlyPoint,
  type WeatherConfig,
  type WeatherSlide,
  type WeatherState,
} from './shared.js';

/** Ab wann ein Wert als veraltet gilt und dezent abgedunkelt wird. */
const STALE_AFTER_MS = 90 * 60_000;

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
      }, MOTION.dwell);
    };

    /**
     * Die Punktreihe unter einer Durchschaltung.
     *
     * Ohne sie waere jeder Wechsel eine Ueberraschung: man liest im
     * Vorbeigehen "Heute 18°" und weiss nicht, dass gleich "Morgen 19°"
     * dasteht. Der breite Punkt ist die aktuelle Karte.
     */
    const dots = (count: number, active: number): TemplateResult | typeof nothing => {
      if (count < 2) return nothing;
      return html`<div class="dots">
        ${Array.from({ length: count }, (_, index) =>
          html`<i class=${index === active ? 'is-active' : ''}></i>`,
        )}
      </div>`;
    };

    /**
     * Der Tagesverlauf als Balken.
     *
     * Die Farbe kommt aus der Temperatur und nicht aus einer festen Palette –
     * dieselbe Quelle wie ueberall sonst im Block. Der waermste Balken bekommt
     * zusaetzlich den warmen Akzent des Design-Systems: die Spitze ist der eine
     * Wert, fuer den man auf ein Diagramm ueberhaupt schaut.
     */
    const hourlyChart = (
      points: readonly HourlyPoint[],
      unit: string,
      solid: boolean,
    ): TemplateResult | typeof nothing => {
      if (points.length < 2) return nothing;
      const values = points.map((point) => point.temperature);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const peak = peakIndex(points);

      /**
       * Die Farbe eines Balkens.
       *
       * Auf schwarzem Grund kommt sie aus der Temperatur, und die Spitze traegt
       * zusaetzlich den warmen Akzent. Auf einer deckenden Salbei-Flaeche geht
       * beides nicht: ein salbeifarbener Balken auf Salbei ist unsichtbar, und
       * ein warmer daneben behauptet, er sei der einzige Wert. Dort zeichnen
       * die Balken deshalb in der dunklen Textfarbe der Flaeche — halb
       * durchlaessig fuer die Normalwerte, deckend fuer die Spitze.
       */
      const fill = (point: HourlyPoint, index: number): string => {
        if (solid) {
          return index === peak
            ? 'var(--mirror-on-accent)'
            : 'color-mix(in srgb, var(--mirror-on-accent) 38%, transparent)';
        }
        return index === peak
          ? 'var(--mirror-accent-warm)'
          : accentForTemperature(toCelsius(point.temperature, config.units));
      };

      return html`
        <div class="weather__hourly">
          <div class="weather__hourly-head">
            <span class="weather__hourly-label">Tagesverlauf</span>
            <span class="weather__hourly-peak">${max}${unit} max</span>
          </div>
          <div class="weather__bars">
            ${points.map(
              (point, index) => html`
                <div class="weather__bar">
                  <i
                    style=${`height:${barHeight(point.temperature, min, max).toFixed(1)}%;background:${fill(
                      point,
                      index,
                    )}`}
                  ></i>
                  <span class="weather__bar-hour">${point.hour}</span>
                </div>
              `,
            )}
          </div>
        </div>
      `;
    };

    /** Eine Karte – fuer heute wie fuer jeden Vorhersagetag dieselbe Form. */
    const card = (slide: WeatherSlide, unit: string, accent: string | null): TemplateResult => html`
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
      const size = host.dataset.size ?? 'm';
      const stale =
        state.fetchedAt !== null &&
        state.fetchedAt !== undefined &&
        Date.now() - Date.parse(state.fetchedAt) > STALE_AFTER_MS;

      /*
       * Die deckende Flaeche ist eine Einstellung und keine Automatik – und
       * sie gilt nur, solange die Zahl darauf auch stimmt. Ein veralteter Wert
       * bekommt kein Highlight: eine Flaeche in Salbei behauptet Frische, die
       * die Zahl nicht mehr hat.
       */
      const solid = config.highlight && !stale && !error && current !== null && current !== undefined;
      const shell = (body: TemplateResult, extra = ''): void => {
        render(
          html`<div class="weather ${extra} ${solid ? 'box box--solid' : ''}">${body}</div>`,
          host,
        );
      };

      if (!current) {
        stopCycle();
        /*
         * Ohne Werte steht hier ein Zustand und kein halber Block. Ein Fehler
         * traegt seine eigene Toenung, das Laden atmet – und beides ist als
         * solches erkennbar, statt sich als Wetter auszugeben.
         */
        render(
          error
            ? html`<div class="weather weather--empty">
                <div class="state state--error">
                  <span class="state__icon">${icon('triangle-alert', { size: '1em', strokeWidth: 1.5 })}</span>
                  <span class="state__text"><span>${error}</span></span>
                </div>
              </div>`
            : html`<div class="weather weather--empty">
                <div class="loading"><i></i><i></i><i></i><i></i></div>
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
       * die Farbe eine Frische, die die Zahl nicht mehr hat. Auf einer
       * deckenden Flaeche entfaellt er ebenfalls: dort *ist* die Flaeche der
       * Akzent, und ein zweiter Ton darauf waere Farbe auf Farbe.
       */
      const accent =
        stale || error || solid
          ? null
          : accentForTemperature(toCelsius(current.temperature, config.units));

      /**
       * Der kleinste Block zeigt Symbol und Zahl, sonst nichts.
       *
       * Auf 224 x 148 ist alles Weitere eine Zeile unter 32 px – und damit aus
       * 3 m nicht mehr lesbar. Lieber ein Wert, den man liest, als drei, die
       * man erraet.
       */
      if (size === 's') {
        stopCycle();
        shell(
          html`
            <div class="weather__now">
              <span class="weather__icon">${icon(now.icon, { size: '1em', strokeWidth: 1.5 })}</span>
              <span class="weather__temp"
                >${current.temperature}<span class="weather__unit">${unit}</span></span
              >
            </div>
          `,
          `weather--s ${stale || error ? 'weather--stale' : ''}`,
        );
        return;
      }

      /**
       * Der grosse Block schaltet durch, statt alles nebeneinander zu zeigen.
       *
       * Er ist der einzige, der hoch genug ist, dass eine Karte mit grosser
       * Beschriftung, grossem Symbol und grosser Zahl darin Platz hat – im
       * mittleren Block bliebe von jeder Zeile ein Rest, im breiten steht der
       * Tagesverlauf ohnehin komplett und braucht niemanden, der wartet.
       *
       * Sind die Werte veraltet oder die Abfrage fehlgeschlagen, faellt auch der
       * grosse Block auf die feste Ansicht zurueck: eine Durchschaltung, die
       * alte Tage durchblaettert, sieht lebendiger aus, als die Daten sind.
       * Nachts ebenso – dort wird ueberhaupt nicht weitergeschaltet.
       */
      const night = document.documentElement.dataset.night === '1';
      const cycling = size === 'l' && !stale && !error && !night;
      const slides = cycling
        ? buildSlides(state, config, { locale: ctx.locale, timeZone: ctx.timezone })
        : [];

      if (slides.length > 1) startCycle();
      else stopCycle();

      if (slides.length > 0) {
        const index = position % slides.length;
        const slide = slides[index] as WeatherSlide;
        const slideAccent = solid
          ? null
          : accentForTemperature(slide.celsius);
        /**
         * Die laengste Beschriftung des Stapels bestimmt die Schriftgroesse
         * aller – "Heute" duerfte allein groesser stehen als "Uebermorgen",
         * aber dann waere die Karte bei jedem Wechsel eine andere. Die Untergrenze
         * verhindert, dass ein Stapel aus lauter kurzen Woertern die Zeile
         * ueber den Block hinaus aufblaest.
         */
        const labelChars = Math.max(6, ...slides.map((entry) => entry.label.length));
        shell(
          html`
            ${state.resolvedLocation
              ? html`<div class="weather__place">${state.resolvedLocation}</div>`
              : nothing}
            <div class="weather__deck" style="--weather-label-chars:${labelChars}">
              ${keyed(slide.key, card(slide, unit, slideAccent))}
            </div>
            ${dots(slides.length, index)}
          `,
          'weather--deck',
        );
        return;
      }

      const hourly = config.showHourly && (size === 'l' || size === 'xl') && !stale && !error
        ? pickHourly(state.hourly ?? [], new Date().getHours())
        : [];

      shell(
        html`
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
          ${hourly.length > 1 ? hourlyChart(hourly, unit, solid) : nothing}
          ${hourly.length < 2 && state.forecast && state.forecast.length > 0
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
        `,
        stale || error ? 'weather--stale' : '',
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
