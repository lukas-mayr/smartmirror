import { html, render, nothing } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import {
  elapsedFraction,
  formatTime,
  nextShown,
  type AccountPlayback,
  type SpotifyConfig,
  type SpotifyState,
} from './shared.js';

export default defineFrontend<SpotifyState, SpotifyConfig>({
  create(host, ctx): ModuleView<SpotifyState, SpotifyConfig> {
    let state: Partial<SpotifyState> = {};
    let config = ctx.config;
    let error: string | null = null;
    let timer: number | undefined;
    /** Platz des gerade gezeigten Kontos. */
    let shownSlot: number | null = null;
    /** Sekunden, seit der Gezeigte dran ist. */
    let sinceSwitch = 0;

    /** Konten, bei denen es etwas zu zeigen gibt – laufend oder pausiert. */
    const active = (): AccountPlayback[] => (state.accounts ?? []).filter((entry) => entry.title !== null);

    const draw = (): void => {
      if ((state.connectedCount ?? 0) === 0) {
        render(
          html`<div class="spotify spotify--hint">${error ?? 'Spotify: Anmeldung offen'}</div>`,
          host,
        );
        return;
      }

      const candidates = active();
      if (candidates.length === 0) {
        // Stille. Was der Spiegel nicht zeigt, bleibt Spiegel – deshalb ist
        // das Ausblenden die Voreinstellung und nicht ein "Nichts laeuft".
        shownSlot = null;
        if (config.hideWhenIdle) {
          render(html``, host);
          return;
        }
        render(html`<div class="spotify spotify--hint">Nichts laeuft</div>`, host);
        return;
      }

      // Der Gezeigte bleibt dran, solange bei ihm etwas laeuft; faellt er
      // weg, beginnt die Runde vorne.
      const current =
        candidates.find((entry) => entry.slot === shownSlot) ?? (candidates[0] as AccountPlayback);
      shownSlot = current.slot;

      const fraction = elapsedFraction(current);
      const elapsed = current.durationMs ? fraction * current.durationMs : 0;
      // Der Name lohnt sich erst, wenn er etwas unterscheidet.
      const showName = (state.connectedCount ?? 0) > 1;

      render(
        html`
          <div class="spotify ${current.playing ? '' : 'spotify--paused'}">
            ${showName
              ? html`<div class="spotify__who">
                  ${current.name}${candidates.length > 1 ? html` · ${candidates.length} hoeren` : nothing}
                </div>`
              : nothing}
            <div class="spotify__head">
              <span class="spotify__icon">
                ${icon(current.playing ? 'music' : 'pause', { size: '1em', strokeWidth: 1.5 })}
              </span>
              <span class="spotify__title">${current.title}</span>
            </div>
            ${current.artist ? html`<div class="spotify__artist">${current.artist}</div>` : nothing}
            ${config.showAlbum && current.album
              ? html`<div class="spotify__album">${current.album}</div>`
              : nothing}
            ${config.showProgress && current.durationMs
              ? html`
                  <div class="spotify__progress">
                    <div class="spotify__bar"><i style=${`width:${(fraction * 100).toFixed(2)}%`}></i></div>
                    <div class="spotify__times">
                      <span>${formatTime(elapsed)}</span>
                      <span>${formatTime(current.durationMs)}</span>
                    </div>
                  </div>
                `
              : nothing}
            ${error ? html`<div class="spotify__hint">${error}</div>` : nothing}
          </div>
        `,
        host,
      );
    };

    /**
     * Ein Sekundentakt fuer beides: den mitlaufenden Balken und das
     * Durchschalten, wenn mehrere gleichzeitig hoeren. Laeuft nur, wenn es
     * etwas zu bewegen gibt – ein Spiegel, auf dem sich nichts tut, ist der
     * ruhigere.
     */
    const schedule = (): void => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      const candidates = active();
      const barMoves = config.showProgress && candidates.some((entry) => entry.playing);
      if (!barMoves && candidates.length < 2) return;

      timer = window.setInterval(() => {
        sinceSwitch += 1;
        const rotation = active();
        if (rotation.length > 1 && sinceSwitch >= Math.max(5, config.switchSeconds)) {
          sinceSwitch = 0;
          shownSlot = nextShown(rotation.map((entry) => entry.slot), shownSlot);
        }
        draw();
      }, 1_000);
    };

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
