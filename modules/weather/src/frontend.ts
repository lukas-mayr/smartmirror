import { html, render, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { defineFrontend, MOTION, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import { weatherGlyph } from './icons.js';
import {
  accentForTemperature,
  barHeight,
  buildSlides,
  describeWeather,
  dwellMs,
  peakIndex,
  pickHourly,
  toCelsius,
  weatherForm,
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

    /** Der Takt, mit dem der Zaehler gerade laeuft. */
    let dwell: number = MOTION.dwell;

    /*
     * Neu gestartet wird nur, wenn sich der Takt geaendert hat.
     *
     * Sonst setzte jeder Zeichenvorgang den Zaehler zurueck – und weil auch
     * jeder Kartenwechsel zeichnet, stuende die Durchschaltung still.
     */
    const startCycle = (): void => {
      const wanted = dwellMs(config.dwellSeconds);
      if (timer !== null && wanted === dwell) return;
      stopCycle();
      dwell = wanted;
      timer = setInterval(() => {
        position += 1;
        draw();
      }, dwell);
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

    /**
     * Eine Karte – fuer heute wie fuer jeden Vorhersagetag dieselbe Form.
     *
     * Das Symbol traegt die Karte: es nimmt die ganze Wertzeile ein und steht
     * neben Tag und Zahl wie ein Bild neben seiner Bildunterschrift. Der Grund
     * ist keine Vorliebe, sondern die Leseentfernung – aus fuenf Metern
     * erkennt man eine Wolke, lange bevor man eine Zahl liest.
     *
     * Der Aufbau ist in jeder Groesse und in jeder Aufhaengung derselbe: eine
     * Wertzeile fester Hoehe, darunter eine Textzeile. Dieselbe Hoehe benutzt
     * die Uhr fuer ihre Uhrzeit – deshalb liegen die beiden Zahlen im Kopfband
     * auf einer Mittelachse und die beiden Zeilen darunter auf einer Linie.
     */
    const card = (slide: WeatherSlide, unit: string, accent: string | null): TemplateResult => html`
      <div class="weather__slide">
        <div class="weather__value">
          <span class="weather__icon">${weatherGlyph(slide.icon, { size: '1em' })}</span>
          <span class="weather__body">
            <span class="weather__label">${slide.label}</span>
            <span class="weather__temp"
              >${slide.temperature}<span class="weather__unit">${unit}</span></span
            >
          </span>
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
       * Welche Form der Block zeigt, entscheidet allein seine Groesse – im
       * Raster wie in der Szene. Die Regel steht in shared.ts, damit sie
       * pruefbar ist und nicht als Kette von && mitten im Zeichnen.
       */
      const night = document.documentElement.dataset.night === '1';
      const form = weatherForm({ size, stale, error: error !== null, night });

      /*
       * Die deckende Flaeche ist eine Einstellung und keine Automatik – und
       * sie gilt nur, solange die Zahl darauf auch stimmt. Ein veralteter Wert
       * bekommt kein Highlight: eine Flaeche in Salbei behauptet Frische, die
       * die Zahl nicht mehr hat.
       */
      const solid =
        config.highlight && !stale && !error && current !== null && current !== undefined;
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

      const stamp = state.fetchedAt
        ? new Intl.DateTimeFormat(ctx.locale, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: ctx.timezone,
          }).format(new Date(state.fetchedAt))
        : null;

      /**
       * Warum die Zahl nicht mehr stimmt.
       *
       * Steht in jeder Form an derselben Stelle – ganz unten, in der
       * gedaempften Stufe. Ein Fehler ohne diese Zeile waere eine Anzeige, die
       * einfach eine alte Temperatur behauptet.
       */
      const hint = (): TemplateResult | typeof nothing => {
        if (!error && !stale) return nothing;
        const reason = error ?? 'Keine aktuellen Daten';
        return html`<div class="weather__hint">${stamp ? `${reason} · Stand ${stamp}` : reason}</div>`;
      };

      /** Die Zeile unter der Zahl: was fuer ein Wetter, und auf Wunsch der Wind. */
      const metaRow = (): TemplateResult => html`
        <div class="weather__meta" style=${accent ? `color:${accent}` : nothing}>
          <span>${now.label}</span>
          ${config.showWind
            ? html`<span class="weather__sep">·</span>
                <span>${current.windSpeed} ${state.windUnit ?? 'km/h'}</span>`
            : nothing}
        </div>
      `;

      /** Symbol und Zahl nebeneinander – die feste Ansicht und der kleinste Block. */
      const nowRow = (): TemplateResult => html`
        <div class="weather__now">
          <span class="weather__icon">${weatherGlyph(now.icon, { size: '1em' })}</span>
          <span class="weather__temp"
            >${current.temperature}<span class="weather__unit">${unit}</span></span
          >
        </div>
      `;

      /**
       * Der kleinste Block zeigt Symbol und Zahl, sonst nichts.
       *
       * Auf 224 x 148 ist alles Weitere eine Zeile unter 32 px – und damit aus
       * 3 m nicht mehr lesbar. Lieber ein Wert, den man liest, als drei, die
       * man erraet.
       */
      if (form === 'badge') {
        stopCycle();
        shell(nowRow(), `weather--s ${stale || error ? 'weather--stale' : ''}`);
        return;
      }

      /**
       * Der grosse Block schaltet durch, statt alles nebeneinander zu zeigen.
       *
       * Er ist der einzige, der hoch genug ist, dass eine Karte mit grossem
       * Symbol, grosser Zahl und lesbarem Kurztext darin Platz hat – im
       * mittleren Block bliebe von jeder Zeile ein Rest, im breiten steht der
       * Tagesverlauf ohnehin komplett und braucht niemanden, der wartet.
       *
       * Im Raster wie in der Szene: der Slot im Kopfband ist so breit wie ein
       * L-Block, also zeigt der Block dort dieselbe Karte und keine gequetschte
       * Fassung davon.
       *
       * Sind die Werte veraltet oder die Abfrage fehlgeschlagen, faellt auch der
       * grosse Block auf die feste Ansicht zurueck: eine Durchschaltung, die
       * alte Tage durchblaettert, sieht lebendiger aus, als die Daten sind.
       * Nachts ebenso – dort wird ueberhaupt nicht weitergeschaltet.
       */
      const slides =
        form === 'deck'
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
        /*
         * Kein Ort ueber der Karte.
         *
         * Er steht auf jeder Karte gleich, aendert sich nie und beantwortet
         * nichts, was man im Vorbeigehen wissen will – und er waere eine
         * dritte Ebene, die die Wertzeile aus der Linie mit der Uhr daneben
         * schoebe. In der festen Ansicht bleibt er: dort ist Platz, und dort
         * traegt er die Vorhersage mit.
         */
        shell(
          html`
            <div class="weather__deck">${keyed(slide.key, card(slide, unit, slideAccent))}</div>
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
          ${nowRow()}${metaRow()}
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
                          ${weatherGlyph(appearance.icon, {
                            size: '1em',
                            strokeWidth: 1.6,
                            /* In Fussnotengroesse waere eine Reihe driftender
                               Wolken Flimmern und keine Auskunft. */
                            animated: false,
                            title: appearance.label,
                          })}
                        </span>
                        <span class="weather__day-range">${day.max}° <i>${day.min}°</i></span>
                      </div>
                    `;
                  })}
                </div>
              `
            : nothing}
          ${hint()}
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
