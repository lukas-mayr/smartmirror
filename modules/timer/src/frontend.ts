import { html, render, svg, nothing, type TemplateResult } from 'lit';
import { defineFrontend, type ModuleView } from '@mirror/sdk';
import {
  ARM,
  FIELD,
  GROUND,
  SLEW_X,
  TRACK,
  TRUCK,
  cargoPath,
  mountainPath,
} from './scene.js';
import {
  digPhaseMs,
  formatRemaining,
  mountainSize,
  remainingShare,
  timerLabel,
  timerWindow,
  type TimerConfig,
  type TimerState,
} from './shared.js';

/**
 * Der Timer im Block: Restzeit und Baustelle.
 *
 * Die Restzeit steht zweimal da, und das ist kein Doppel. Die Ziffern
 * beantworten "wieviel genau", der Berg beantwortet "wieviel ueberhaupt" — und
 * die zweite Frage ist die, die man im Vorbeigehen stellt. Aus drei Metern
 * sieht man, ob noch ein halber Berg steht, lange bevor man "07:12" gelesen
 * hat.
 *
 * **Bewegt wird im Stylesheet, gerechnet wird hier.** Der Bagger schwenkt in
 * einem festen Takt, und ein fester Takt ist genau das, was CSS-Keyframes gut
 * koennen: sie laufen im Compositor, kosten kein JavaScript und stehen bei
 * `prefers-reduced-motion` und nachts von selbst still. Hier wird nur
 * ausgerechnet, wie gross der Berg noch ist — viermal je Sekunde, damit die
 * Ziffern stimmen und der Bissen nicht eine halbe Sekunde neben dem Schwenk
 * liegt.
 *
 * Damit beides zusammenfaellt, bekommt die Bewegung einen Versatz mit auf den
 * Weg (`--dig-phase`, als negative `animation-delay`): sie beginnt nicht,
 * wenn die Anzeige das Bild aufbaut, sondern dort, wo sie nach der verstrichenen
 * Zeit stehen muesste. Ohne das faenge ein Spiegel, der um 18:03 neu startet,
 * mitten in der Ladung einen frischen Schwenk an.
 *
 * Laeuft kein Timer, bleibt der Block leer. Kein "kein Timer": eine leere
 * Flaeche auf einem Spiegel ist ein Spiegel, ein Satz darueber ist eine
 * Meldung, dass nichts zu melden ist.
 */

/**
 * Wie oft neu gerechnet wird.
 *
 * Vier Bilder je Sekunde klingen nach viel fuer eine Uhr, die Sekunden zeigt.
 * Es geht auch nicht um die Ziffern, sondern um den Bissen: ein Eimer dauert
 * fuenf Sekunden, und wenn der Berg erst eine halbe Sekunde spaeter kleiner
 * wird, sieht man den Zusammenhang nicht mehr. Gezeichnet wird dabei fast
 * nichts — ein Pfad und zwei Textknoten, alles andere steht.
 */
const TICK_MS = 250;

export default defineFrontend<TimerState, TimerConfig>({
  create(host, ctx): ModuleView<TimerState, TimerConfig> {
    let state: Partial<TimerState> = {};
    let config = ctx.config;
    let timer: ReturnType<typeof setInterval> | null = null;

    /**
     * Der Versatz der Bewegung, als fertiges Stilattribut.
     *
     * Er wird nur neu gebildet, wenn ein anderer Timer laeuft als eben noch.
     * Wuerde er bei jedem Zeichnen neu gesetzt, finge die Bewegung viermal je
     * Sekunde von vorn an — an der richtigen Stelle zwar, aber jedes Mal mit
     * einem Neustart, und der Compositor haette nichts mehr zu tun, als
     * Animationen aufzusetzen.
     */
    let phaseFor: string | null = null;
    let phaseStyle = '';

    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => draw(), TICK_MS);
    };

    /* --------------------------------- Bilder -------------------------------- */

    /**
     * Der Lastwagen.
     *
     * Fahrerhaus links, Mulde rechts: er faehrt nach links ab, und ein
     * Lastwagen, der rueckwaerts aus dem Bild rollt, sieht nicht nach
     * Abtransport aus. Die Mulde liegt damit auf der Baggerseite und der Weg
     * der Schaufel wird kurz.
     */
    const truck = (): TemplateResult => svg`
      <g class="dig__truck">
        <path class="dig__frame" d=${`M8 ${TRUCK.floor}H${TRUCK.bed.right}`} />
        <path class="dig__cab" d=${`M8 ${TRUCK.floor}V52L14 44H32V${TRUCK.floor}`} />
        <path class="dig__pane" d="M17 47H30V53H17Z" />
        <path
          class="dig__bed"
          d=${`M${TRUCK.bed.left} ${TRUCK.rim}V${TRUCK.floor}H${TRUCK.bed.right}V${TRUCK.rim}`}
        />
        <path
          class="dig__cargo"
          d=${cargoPath()}
          style=${`transform-origin:65px ${TRUCK.floor}px`}
        />
        <circle class="dig__wheel" cx="18" cy="74" r="6" />
        <circle class="dig__wheel" cx="60" cy="74" r="6" />
        <circle class="dig__wheel" cx="78" cy="74" r="6" />
      </g>
    `;

    /**
     * Der Bagger.
     *
     * Vier Gruppen ineinander, weil vier Dinge sich unabhaengig voneinander
     * bewegen: der Oberwagen dreht sich (im Seitenriss eine Spiegelung durch
     * die Senkrechte), der Ausleger hebt, der Stiel zieht nach, die Schaufel
     * kippt. Jede Gruppe traegt ihren Drehpunkt selbst — er gehoert zur Form
     * und nicht ins Stylesheet, wo er eine Zahl waere, die zur Zeichnung passen
     * muss und es irgendwann nicht mehr tut.
     *
     * Die Raupe bleibt aussen vor: sie dreht sich nicht mit. Genau daran
     * erkennt man, dass sich der Oberwagen dreht und nicht die Maschine kippt.
     */
    const excavator = (): TemplateResult => svg`
      <g class="dig__machine">
        <rect
          class="dig__track"
          x=${TRACK.left}
          y=${TRACK.top}
          width=${TRACK.right - TRACK.left}
          height=${GROUND - TRACK.top}
          rx="6"
        />
        <circle class="dig__roller" cx="104" cy="74" r="2.5" />
        <circle class="dig__roller" cx="119" cy="74" r="2.5" />
        <circle class="dig__roller" cx="134" cy="74" r="2.5" />

        <g class="dig__house" style=${`transform-origin:${SLEW_X}px 60px`}>
          <path class="dig__body" d="M100 68V58Q100 55 103 55H110V46H124V55H134Q137 55 137 58V68Z" />
          <path class="dig__pane" d="M113 49H121V54H113Z" />

          <g class="dig__boom" style=${`transform-origin:${ARM.foot.x}px ${ARM.foot.y}px`}>
            <path
              class="dig__bar"
              d=${`M${ARM.foot.x} ${ARM.foot.y}L136 44L${ARM.knuckle.x} ${ARM.knuckle.y}`}
            />
            <g class="dig__stick" style=${`transform-origin:${ARM.knuckle.x}px ${ARM.knuckle.y}px`}>
              <path
                class="dig__bar"
                d=${`M${ARM.knuckle.x} ${ARM.knuckle.y}L${ARM.pin.x} ${ARM.pin.y}`}
              />
              <g class="dig__bucket" style=${`transform-origin:${ARM.pin.x}px ${ARM.pin.y}px`}>
                <path
                  class="dig__scoop"
                  d=${`M${ARM.pin.x} ${ARM.pin.y}L163 66Q162.5 72.5 154.5 74.5L${ARM.tip.x} ${ARM.tip.y}Z`}
                />
                <path class="dig__haul" d="M154.5 67Q158 63.5 161 66.5" />
              </g>
            </g>
          </g>
        </g>
      </g>
    `;

    /**
     * Was beim Kippen faellt.
     *
     * Drei kurze Striche und kein Schuettkegel: aus drei Metern ist Material im
     * Fall eine Bewegung und keine Form. Sie liegen ausserhalb des Oberwagens,
     * weil sie nicht mitdrehen — sie fallen senkrecht, egal wie die Maschine
     * gerade steht.
     */
    const spill = (): TemplateResult => svg`
      <g class="dig__spill">
        <path d="M83 40V44" />
        <path d="M87 42V45" />
        <path d="M80 43V46" />
      </g>
    `;

    /** Die Baustelle. `share` ist, was vom Berg noch steht. */
    const scene = (size: number, share: number, digging: boolean): TemplateResult => {
      const path = mountainPath(size, share);
      return html`
        <svg
          class=${`dig${digging ? ' is-digging' : ''}`}
          viewBox=${`0 ${FIELD.top} ${FIELD.width} ${FIELD.height}`}
          preserveAspectRatio="xMinYMax meet"
          style=${phaseStyle}
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          role="presentation"
          aria-hidden="true"
        >
          <path class="dig__ground" d=${`M0 ${GROUND}H${FIELD.width}`} />
          ${path ? svg`<path class="dig__mountain" d=${path} />` : nothing}
          ${truck()} ${spill()} ${excavator()}
        </svg>
      `;
    };

    /* -------------------------------- Zeichnen ------------------------------- */

    const draw = (): void => {
      const run = timerWindow(state);
      if (!run) {
        // Kein Timer heisst leerer Block – und nichts, was gezeichnet werden
        // muesste, heisst auch nichts, was getaktet werden muesste.
        stop();
        phaseFor = null;
        render(html``, host);
        return;
      }

      const total = run.end - run.start;
      const now = Date.now();
      const elapsed = Math.min(total, Math.max(0, now - run.start));
      const done = now >= run.end;

      if (phaseFor !== state.startedAt) {
        phaseFor = state.startedAt ?? null;
        phaseStyle = `--dig-phase:-${(digPhaseMs(elapsed) / 1000).toFixed(2)}s`;
      }

      const label = timerLabel(config.label);
      const size = host.dataset.size ?? 'l';
      const share = done ? 0 : remainingShare(elapsed, total);
      /*
       * Die Zeichenzahl geht als Rechengroesse ins Stylesheet — dieselbe
       * Ueberlegung wie bei der Uhr: "07:12" ist schmaler als "1:07:12", und
       * eine feste Groesse muesste immer den laengsten Fall annehmen und waere
       * in allen anderen zu klein.
       */
      const value = done ? 'Fertig' : formatRemaining(run.end - now);

      render(
        html`
          <div class=${`timer timer--${size}${done ? ' timer--done' : ''}`}>
            <div class="timer__head">
              <div class="timer__eyebrow">${label}</div>
              <div class="timer__value" style=${`--timer-chars:${value.length}`}>${value}</div>
            </div>
            ${scene(mountainSize(total), share, !done)}
          </div>
        `,
        host,
      );

      // Nach dem letzten Eimer gibt es nichts mehr zu rechnen: der Berg ist
      // weg, die Ziffern stehen. Weiterzuticken hiesse, viermal je Sekunde
      // dasselbe Bild zu bauen, bis jemand den Schalter umlegt.
      if (done) stop();
      else start();
    };

    draw();

    return {
      update(nextState, nextConfig) {
        state = { ...state, ...nextState };
        config = nextConfig;
        draw();
      },
      destroy() {
        stop();
        render(html``, host);
      },
    };
  },
});
