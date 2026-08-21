import { html, render, nothing, type TemplateResult } from 'lit';
import { defineFrontend, type ModuleView, type WidgetSize } from '@mirror/sdk';
import { icon } from '@mirror/icons';
import {
  accentFromPixels,
  elapsedFraction,
  formatTime,
  nextShown,
  type AccountPlayback,
  type SpotifyConfig,
  type SpotifyState,
} from './shared.js';

/** Farbe, wenn das Cover (noch) keine hergibt. */
const NEUTRAL_ACCENT = '#9a9aa3';

/**
 * Akzentfarben je Cover, einmal berechnet und behalten.
 *
 * Die Berechnung laeuft ueber ein unsichtbares Canvas: das Cover kommt als
 * data-URI, und solche Bilder darf ein Canvas auslesen, ohne zu verschmutzen.
 * Asynchron, weil das Bild erst decodiert werden muss – bis dahin zeichnet
 * die Anzeige neutral und faerbt beim naechsten Zeichnen um.
 */
class AccentCache {
  #known = new Map<string, string>();
  #pending = new Set<string>();

  lookup(cover: string | null, onReady: () => void): string {
    if (!cover) return NEUTRAL_ACCENT;
    const cached = this.#known.get(cover);
    if (cached) return cached;
    if (!this.#pending.has(cover)) {
      this.#pending.add(cover);
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 24;
          canvas.height = 24;
          const context = canvas.getContext('2d');
          if (context) {
            context.drawImage(image, 0, 0, 24, 24);
            const pixels = context.getImageData(0, 0, 24, 24).data;
            this.#known.set(cover, accentFromPixels(pixels) ?? NEUTRAL_ACCENT);
          }
        } catch {
          this.#known.set(cover, NEUTRAL_ACCENT);
        }
        this.#pending.delete(cover);
        onReady();
      };
      image.onerror = () => {
        this.#known.set(cover, NEUTRAL_ACCENT);
        this.#pending.delete(cover);
      };
      image.src = cover;
    }
    return NEUTRAL_ACCENT;
  }
}

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
    const accents = new AccentCache();

    /** Konten, bei denen es etwas zu zeigen gibt – laufend oder pausiert. */
    const active = (): AccountPlayback[] => (state.accounts ?? []).filter((entry) => entry.title !== null);

    /**
     * Die Blockgroesse bestimmt, was zu sehen ist: S nur das Cover, M dazu
     * Titel und Interpret, L den Fortschritt, XL alles in voller Breite.
     * Die Shell schreibt die Groesse an das Host-Element – von dort wird sie
     * bei jedem Zeichnen gelesen, ein Beobachter meldet Wechsel sofort.
     */
    const blockSize = (): WidgetSize => {
      const raw = host.dataset.size;
      return raw === 's' || raw === 'm' || raw === 'l' || raw === 'xl' ? raw : 'm';
    };

    const cover = (entry: AccountPlayback, accent: string): TemplateResult =>
      entry.cover
        ? html`<div class="spotify__cover" style=${`background-image:url(${entry.cover})`}></div>`
        : html`<div class="spotify__cover spotify__cover--empty" style=${`color:${accent}`}>
            ${icon('music', { size: '38%', strokeWidth: 1.4 })}
          </div>`;

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
        shownSlot = null;
        if (config.hideWhenIdle) {
          render(html``, host);
          return;
        }
        render(html`<div class="spotify spotify--hint">Nichts laeuft</div>`, host);
        return;
      }

      const current =
        candidates.find((entry) => entry.slot === shownSlot) ?? (candidates[0] as AccountPlayback);
      shownSlot = current.slot;

      const size = blockSize();
      const accent = accents.lookup(current.cover, draw);
      const fraction = elapsedFraction(current);
      const elapsed = current.durationMs ? fraction * current.durationMs : 0;
      const showName = (state.connectedCount ?? 0) > 1;
      const eyebrow = showName
        ? html`<div class="spotify__eyebrow">
            ${current.name}${candidates.length > 1 ? ` · ${candidates.length} hoeren` : ''}
          </div>`
        : nothing;
      const progress =
        current.durationMs
          ? html`
              <div class="spotify__progress">
                <div class="spotify__bar"><i style=${`width:${(fraction * 100).toFixed(2)}%;background:${accent}`}></i></div>
                <div class="spotify__times"><span>${formatTime(elapsed)}</span><span>${formatTime(current.durationMs)}</span></div>
              </div>
            `
          : nothing;

      // Pro Groesse ein eigenes Geruest: die Layouts unterscheiden sich in
      // ihrer Struktur, nicht nur im Massstab – das liest sich als vier kleine
      // Vorlagen besser als eine grosse mit Weichen.
      let body: TemplateResult;
      if (size === 's') {
        body = html`${cover(current, accent)}`;
      } else if (size === 'm') {
        body = html`
          ${cover(current, accent)}
          <div class="spotify__text">
            ${eyebrow}
            <div class="spotify__title">${current.title}</div>
            <div class="spotify__artist" style=${`color:${accent}`}>${current.artist}</div>
          </div>
        `;
      } else if (size === 'l') {
        body = html`
          <div class="spotify__row">
            ${cover(current, accent)}
            <div class="spotify__text">
              ${eyebrow}
              <div class="spotify__title">${current.title}</div>
              <div class="spotify__artist" style=${`color:${accent}`}>${current.artist}</div>
            </div>
          </div>
          ${progress}
        `;
      } else {
        body = html`
          ${cover(current, accent)}
          <div class="spotify__text">
            ${eyebrow}
            <div class="spotify__title">${current.title}</div>
            <div class="spotify__artist" style=${`color:${accent}`}>${current.artist}</div>
            ${current.album
              ? html`<div class="spotify__album">
                  ${current.album}${current.albumYear ? ` · ${current.albumYear}` : ''}
                </div>`
              : nothing}
            ${progress}
          </div>
        `;
      }

      render(
        html`
          <div class="spotify spotify--${size} ${current.playing ? '' : 'spotify--paused'}">
            ${body}
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
      const size = blockSize();
      const barMoves = (size === 'l' || size === 'xl') && candidates.some((entry) => entry.playing);
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

    // Die Groesse aendert sich, wenn am Handy ein anderer Block gewaehlt wird
    // – ohne Neustart der Instanz. Der Beobachter zeichnet dann sofort um.
    const observer = new MutationObserver(() => {
      draw();
      schedule();
    });
    observer.observe(host, { attributes: true, attributeFilter: ['data-size'] });

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
        observer.disconnect();
        if (timer !== undefined) window.clearInterval(timer);
        render(html``, host);
      },
    };
  },
});
