import { html, render, svg, nothing, type TemplateResult } from 'lit';
import { defineFrontend, DIG, type ModuleView } from '@mirror/sdk';
import {
  ARM,
  FIELD,
  GROUND,
  HOUSE,
  MOUNTAIN,
  SLEW_X,
  TRACK,
  TRUCK,
  cargoPath,
  mountainPath,
  siteShift,
} from './scene.js';
import {
  digPhaseMs,
  formatRemaining,
  mountainSize,
  remainingShare,
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
 * ausgerechnet, wie der Berg gerade aussieht und wo die Maschine steht.
 *
 * Damit Bissen und Schwenk zusammenfallen, bekommt die Bewegung einen Versatz
 * mit auf den Weg (`--dig-phase`, als negative `animation-delay`): sie beginnt
 * dort, wo sie nach der verstrichenen Zeit stehen muesste, und nicht dort, wo
 * die Anzeige gerade das Bild aufgebaut hat.
 *
 * **Gezeichnet wird in Koerpern und nicht in Strichen.** Ein Ausleger ist ein
 * Kastentraeger und keine Linie: er ist am Fuss dicker als am Knick, hat einen
 * Knick im Ruecken und einen Zylinder, der ihn haelt. Dasselbe beim Wagen —
 * Rahmen, Mulde, Stirnwand, Raeder mit Nabe. Aus drei Metern sieht man von
 * alldem nur die Silhouette, und genau deshalb muss sie stimmen: eine Reihe
 * gleich dicker Striche liest sich als Diagramm, ein Umriss als Maschine.
 *
 * **Im Block steht nur die Zeit.** Wofuer der Timer laeuft, weiss der, der ihn
 * gestellt hat — und wenn nicht, sagt es die Mitteilung, sobald er abgelaufen
 * ist. Eine Zeile darueber kostet Hoehe, die den Ziffern fehlt, und beantwortet
 * eine Frage, die vor dem Spiegel niemand stellt. Damit traegt der Block auch
 * keinen Akzent mehr: Farbe braucht eine Quelle, und ein Bagger hat keine.
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
 * nichts — ein Pfad, eine Verschiebung und zwei Textknoten.
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
     * Der Kipper.
     *
     * Fahrerhaus links, Mulde rechts: er faehrt nach links ab, und ein
     * Lastwagen, der rueckwaerts aus dem Bild rollt, sieht nicht nach
     * Abtransport aus. Die Stirnwand steht hoeher als die Seitenwand und das
     * Fahrerhaus hoeher als beide — ohne diesen Absatz wird aus Kipper und
     * Kabine ein einziger langer Kasten, und der sieht aus wie ein Anhaenger.
     *
     * Die Ladung sitzt auf der Bordwand und nicht in der Mulde: von der Seite
     * schaut niemand hinein. Sichtbar wird sie erst, wenn sie oben ueber steht.
     */
    const truck = (): TemplateResult => svg`
      <g class="dig__truck">
        <path class="dig__frame" d=${`M16 ${TRUCK.frame}H93V${TRUCK.frame + 2}H16Z`} />

        <path
          class="dig__body"
          d=${`M16 ${TRUCK.frame}V${TRUCK.cabRoof + 2.5}Q16 ${TRUCK.cabRoof} 19.5 ${TRUCK.cabRoof}H38.5Q42 ${TRUCK.cabRoof} 42 ${TRUCK.cabRoof + 3.5}V${TRUCK.frame}Z`}
        />
        <path class="dig__pane" d=${`M19 ${TRUCK.cabRoof + 3}H29.5V${TRUCK.cabRoof + 11}H19Z`} />
        <path class="dig__trim" d=${`M34.5 ${TRUCK.cabRoof + 3}V${TRUCK.frame}`} />
        <path class="dig__ram" d=${`M16.2 ${TRUCK.cabRoof + 4}L14.6 ${TRUCK.cabRoof + 1.5}`} />
        <path class="dig__trim" d=${`M16 ${TRUCK.frame - 3.5}H14.2`} />

        <path
          class="dig__body"
          d=${`M${TRUCK.bed.left} ${TRUCK.floor}V${TRUCK.headboard}H${TRUCK.bed.left + 3}V${TRUCK.rim}H${TRUCK.bed.right}V${TRUCK.floor}Z`}
        />
        <path
          class="dig__cargo"
          d=${cargoPath()}
          style=${`transform-origin:${TRUCK.bed.right - 4}px ${TRUCK.rim}px`}
        />
        <path class="dig__trim" d=${`M${TRUCK.bed.left + 3} ${TRUCK.rim + 2}H${TRUCK.bed.right}`} />
        <path class="dig__trim" d=${`M${TRUCK.bed.right - 3.5} ${TRUCK.rim}V${TRUCK.floor}`} />
        <path class="dig__trim" d=${`M60 ${TRUCK.rim + 3.5}V${TRUCK.floor - 2}`} />
        <path class="dig__trim" d=${`M72 ${TRUCK.rim + 3.5}V${TRUCK.floor - 2}`} />
        <path class="dig__trim" d=${`M84 ${TRUCK.rim + 3.5}V${TRUCK.floor - 2}`} />

        <circle class="dig__wheel" cx="26" cy="73.6" r="6.4" />
        <circle class="dig__hub" cx="26" cy="73.6" r="2.2" />
        <circle class="dig__wheel" cx="66" cy="73.6" r="6.4" />
        <circle class="dig__hub" cx="66" cy="73.6" r="2.2" />
        <circle class="dig__wheel" cx="82" cy="73.6" r="6.4" />
        <circle class="dig__hub" cx="82" cy="73.6" r="2.2" />
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
     * Das Fahrwerk bleibt aussen vor: es dreht sich nicht mit. Genau daran
     * erkennt man, dass sich der Oberwagen dreht und nicht die Maschine kippt.
     */
    const excavator = (): TemplateResult => svg`
      <g class="dig__machine">
        <!-- Kette: Gurt, Leitrad, Turas, Laufrollen. -->
        <path class="dig__body" d="M104 67H134A6.5 6.5 0 0 1 134 80H104A6.5 6.5 0 0 1 104 67Z" />
        <circle class="dig__trim" cx="104" cy="73.5" r="4.2" />
        <circle class="dig__trim" cx="134" cy="73.5" r="4.2" />
        <circle class="dig__hub" cx="112" cy="77" r="1.9" />
        <circle class="dig__hub" cx="119" cy="77" r="1.9" />
        <circle class="dig__hub" cx="126" cy="77" r="1.9" />
        <path class="dig__ram" d=${`M${TRACK.left + 12} ${TRACK.top}H${TRACK.right - 12}`} />

        <g class="dig__house" style=${`transform-origin:${SLEW_X}px 60px`}>
          <!-- Kontergewicht, Kabine mit geneigter Scheibe, Motorhaube. -->
          <path
            class="dig__body"
            d=${`M100 65V56Q100 51.5 104.5 51.5H110V${HOUSE.roof + 3}Q110 ${HOUSE.roof} 113 ${HOUSE.roof}H121Q123 ${HOUSE.roof} 124 ${HOUSE.roof + 1.6}L127.5 50H133Q137 50 137 54V65Z`}
          />
          <path
            class="dig__pane"
            d=${`M112.5 ${HOUSE.roof + 3}H121L124 49.5H112.5Z`}
          />
          <path class="dig__trim" d="M131 50V46.5" />
          <circle class="dig__hub" cx=${ARM.foot.x} cy=${ARM.foot.y} r="1.8" />

          <g class="dig__boom" style=${`transform-origin:${ARM.foot.x}px ${ARM.foot.y}px`}>
            <!--
              Der Ausleger: am Fuss dick, am Knick schlank, mit Bauch — ein
              Kastentraeger und keine Linie.

              Der Hubzylinder fehlt mit Absicht. Er sitzt mit dem einen Ende am
              Oberwagen und mit dem anderen am Ausleger, faehrt also aus, waehrend
              der Ausleger hebt. Das laesst sich mit einer Drehung allein nicht
              nachbauen, und ein Zylinder, der beim Heben mitwandert statt
              auszufahren, faellt mehr auf als einer, den es nicht gibt.
            -->
            <path class="dig__body" d="M125 55.3L135.8 45L146.2 34.4L149.8 37.6L141.7 50.4L131 60.7Z" />

            <!-- Stielzylinder: Gehaeuse und Kolbenstange, beide am Ausleger. -->
            <path class="dig__ram" d="M135.4 45.6L143.6 40.6" />
            <path class="dig__rod" d="M143.6 40.6L148.2 37.6" />

            <g class="dig__stick" style=${`transform-origin:${ARM.knuckle.x}px ${ARM.knuckle.y}px`}>
              <!-- Der Stiel: gerade, gleichmaessig verjuengt. -->
              <path class="dig__body" d="M145 37L154.1 60.6L157.9 59.4L151 35Z" />
              <circle class="dig__hub" cx=${ARM.knuckle.x} cy=${ARM.knuckle.y} r="1.6" />

              <!-- Schaufelzylinder, am Stiel; sein Ende sitzt dicht am Bolzen. -->
              <path class="dig__ram" d="M148.8 42.4L152.4 52" />
              <path class="dig__rod" d="M152.4 52L154.4 57.4" />

              <g class="dig__bucket" style=${`transform-origin:${ARM.pin.x}px ${ARM.pin.y}px`}>
                <!-- Die Schaufel: Ruecken, Bauch, Schneide mit drei Zaehnen. -->
                <path
                  class="dig__body"
                  d=${`M155.6 58.6L163.4 65.2Q164 71.4 158.6 73.8L${ARM.tip.x} ${ARM.tip.y}Z`}
                />
                <path class="dig__rod" d="M154.6 57.6L157.4 61.6" />
                <path class="dig__trim" d=${`M${ARM.tip.x} ${ARM.tip.y}l-1.6 1.6`} />
                <path class="dig__trim" d="M154.4 74.1l-1.5 1.6" />
                <path class="dig__trim" d="M156.8 73.9l-1.4 1.6" />
                <circle class="dig__hub" cx=${ARM.pin.x} cy=${ARM.pin.y} r="1.5" />
              </g>
            </g>
          </g>
        </g>
      </g>
    `;

    /**
     * Was an der Wand nachrieselt, wenn der Zahn eindringt.
     *
     * Kies steht nicht wie Beton: wo die Schaufel hineinfaehrt, rutscht darueber
     * etwas nach. Drei kurze Striche auf der Boeschung, die im Takt des Grabens
     * abwaerts wandern und verschwinden — mehr braucht es nicht, damit der Berg
     * aufhoert, ein Bild zu sein.
     *
     * Die Gruppe sitzt an der Zehe der Kante. Sie liegt im Vorschub und muss
     * deshalb nicht selbst wissen, wie weit abgebaut ist: die ganze Baustelle
     * wandert ohnehin mit der Wand.
     */
    const slide = (): TemplateResult => svg`
      <g class="dig__slide">
        <path d="M151.4 78.6l0.9 1.4" />
        <path d="M153 75.6l1 1.5" />
        <path d="M154.8 72.4l0.9 1.5" />
      </g>
    `;

    /**
     * Was beim Kippen faellt.
     *
     * Drei kurze Striche und kein Schuettkegel: aus drei Metern ist Material im
     * Fall eine Bewegung und keine Form. Sie liegen ausserhalb des Oberwagens,
     * weil sie nicht mitdrehen — sie fallen senkrecht, egal wie die Maschine
     * gerade steht.
     *
     * Und sie liegen *vor* dem Wagen in der Zeichenreihenfolge, also hinter ihm
     * im Bild: geschuettet wird in die Mulde, und zwischen dem fallenden Stoff
     * und dem Betrachter steht die nahe Bordwand. Andersherum faellt der Sand
     * sichtbar vor dem Wagen zu Boden und damit daneben.
     */
    const spill = (): TemplateResult => svg`
      <g class="dig__spill">
        <path d="M85 33V37" />
        <path d="M89 35V38" />
        <path d="M81.5 36V39" />
      </g>
    `;

    /**
     * Die Baustelle.
     *
     * `share` ist, was vom Berg noch steht, `shift`, wie weit der Bagger der
     * Abbaukante schon nachgefahren ist. Beide kommen aus derselben Rechnung,
     * damit die Schaufel dort greift, wo gegraben wird.
     */
    const scene = (
      size: number,
      share: number,
      shift: number,
      digging: boolean,
    ): TemplateResult => {
      const path = mountainPath(size, share);
      return html`
        <svg
          class=${`dig${digging ? ' is-digging' : ''}`}
          viewBox=${`0 ${FIELD.top} ${FIELD.width} ${FIELD.height}`}
          preserveAspectRatio="xMinYMax meet"
          style=${phaseStyle}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          role="presentation"
          aria-hidden="true"
        >
          <path class="dig__ground" d=${`M0 ${GROUND}H${FIELD.width}`} />
          ${path
            ? svg`<path
                class="dig__mountain"
                d=${path}
                style=${`transform-origin:${MOUNTAIN.left}px ${GROUND}px`}
              />`
            : nothing}
          <g class="dig__site" style=${`transform:translateX(${shift.toFixed(1)}px)`}>
            ${slide()} ${spill()} ${truck()} ${excavator()}
          </g>
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

      const size = host.dataset.size ?? 'l';
      const share = done ? 0 : remainingShare(elapsed, total);
      const scale = mountainSize(total);

      /*
       * Vorgerueckt wird einmal je Ladung und nicht laufend.
       *
       * Ein Bagger faehrt, wenn er Platz braucht, und nicht im Millimetertakt
       * neben der Wand entlang. Nach jedem Wagen ist der Moment dafuer: die
       * Schaufel ist leer, der naechste Wagen noch nicht da. Gerechnet wird der
       * Stand deshalb zum Beginn der laufenden Ladung.
       */
      const loadMs = DIG.bucket * DIG.perLoad;
      const settled = Math.floor(elapsed / loadMs) * loadMs;
      const shift = siteShift(scale, done ? 0 : remainingShare(settled, total));

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
              <div class="timer__value" style=${`--timer-chars:${value.length}`}>${value}</div>
            </div>
            ${scene(scale, share, shift, !done)}
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
