import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import { elapsedFraction, formatTime, type SpotifyConfig, type SpotifyState } from './shared.js';

export default defineFrontend<SpotifyState, SpotifyConfig>({
  create(host, ctx): ModuleView<SpotifyState, SpotifyConfig> {
    let state: Partial<SpotifyState> = {};
    let config = ctx.config;
    let error: string | null = null;
    let timer: number | undefined;

    /**
     * Der Balken laeuft in der Anzeige weiter, statt im Sekundentakt gefragt
     * zu werden. Steht die Musik, steht auch er – dann gibt es nichts zu
     * zeichnen, und ein Spiegel, auf dem sich nichts bewegt, ist der ruhigere.
     */
    const schedule = (): void => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (!state.playing || !config.showProgress || !state.durationMs) return;
      timer = window.setInterval(draw, 1_000);
    };

    function draw(): void {
      if (state.connected === false) {
        render(
          html`<div class="spotify spotify--hint">
            ${error ?? 'Spotify: Anmeldung offen'}
          </div>`,
          host,
        );
        return;
      }

      if (!state.title) {
        // Stille. Was der Spiegel nicht zeigt, bleibt Spiegel – deshalb ist
        // das Ausblenden die Voreinstellung und nicht ein "Nichts laeuft".
        if (config.hideWhenIdle) {
          render(html``, host);
          return;
        }
        render(html`<div class="spotify spotify--hint">Nichts laeuft</div>`, host);
        return;
      }

      const fraction = elapsedFraction(state);
      const elapsed = state.durationMs ? fraction * state.durationMs : 0;

      render(
        html`
          <div class="spotify ${state.playing ? '' : 'spotify--paused'}">
            <div class="spotify__head">
              <span class="spotify__icon">
                ${icon(state.playing ? 'music' : 'pause', { size: '1em', strokeWidth: 1.5 })}
              </span>
              <span class="spotify__title">${state.title}</span>
            </div>
            ${state.artist ? html`<div class="spotify__artist">${state.artist}</div>` : nothing}
            ${config.showAlbum && state.album
              ? html`<div class="spotify__album">${state.album}</div>`
              : nothing}
            ${config.showProgress && state.durationMs
              ? html`
                  <div class="spotify__progress">
                    <div class="spotify__bar"><i style=${`width:${(fraction * 100).toFixed(2)}%`}></i></div>
                    <div class="spotify__times">
                      <span>${formatTime(elapsed)}</span>
                      <span>${formatTime(state.durationMs)}</span>
                    </div>
                  </div>
                `
              : nothing}
            ${error ? html`<div class="spotify__hint">${error}</div>` : nothing}
          </div>
        `,
        host,
      );
    }

    draw();
    schedule();

    return {
      update(nextState, nextConfig) {
        state = { ...state, ...nextState };
        config = nextConfig;
        draw();
        schedule();
      },
      setError(nextError) {
        error = nextError;
        draw();
      },
      destroy() {
        if (timer !== undefined) window.clearInterval(timer);
        render(html``, host);
      },
    };
  },
});
