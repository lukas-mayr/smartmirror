import { LitElement, html, nothing, type TemplateResult } from 'lit';
import {
  isNightIn,
  adjustAllInsets,
  adjustInset,
  clampScreenDuration,
  createDefaultInsets,
  defaultGridForRotation,
  findFreeSpot,
  FONT_OPTIONS,
  formatScreenDuration,
  formatWidgetSizes,
  GRID_MAX,
  GRID_MIN,
  gridEqual,
  INSET_MAX,
  INSET_MIN,
  INSET_SIDE_OPTIONS,
  INSET_STEP,
  insetsEqual,
  insetToPixels,
  normalizeRotation,
  rectFor,
  rectsOverlap,
  ROTATION_OPTIONS,
  SCREEN_DURATION_MAX,
  SCREEN_DURATION_MIN,
  SCREEN_DURATION_STEP,
  SCREEN_LAYOUT_OPTIONS,
  SETUP_FLOW_STEPS,
  SETUP_STEP_TITLES,
  setupStepNumber,
  sizeCells,
  WIDGET_SIZE_OPTIONS,
  WIDGET_SIZE_SPECS,
  WIDGET_SIZES,
  ZONE_CAPACITY,
  ZONE_OPTIONS,
  ZONE_SPECS,
  type FontId,
  type GridSize,
  type InsetSide,
  type MirrorConfig,
  type MirrorScreen,
  type ModuleDescriptor,
  type ModuleInstance,
  type PairedDevice,
  type RestartScope,
  type Zone,
  type ScreenInsets,
  type SetupStep,
  type WidgetSize,
} from '@mirror/sdk';
import { store, type StoreSnapshot } from '../store.js';
import './schema-form.js';

type Tab = 'module' | 'anzeige' | 'system';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** Seitenverhaeltnis der Vorschau, solange die Anzeige noch nichts gemeldet hat. */
const FALLBACK_ASPECT = 16 / 9;

/**
 * Ab so vielen Pixeln gilt eine Beruehrung als Ziehen und nicht mehr als
 * Antippen. Darunter waere jeder Fingerwackler ein verschobener Block.
 */
const DRAG_THRESHOLD = 6;

/**
 * Eine Bestaetigung am unteren Rand.
 *
 * `action` ist optional, weil nicht jede Aenderung eine sinnvolle Ruecknahme
 * hat: eine Groesse laesst sich zurueckstellen, ein abgeschickter Neustart
 * nicht. Wo es keine gibt, steht der Toast trotzdem – "getan" ist auch ohne
 * Ruecknahme eine Auskunft.
 */
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'warn' | 'error';
  action?: { label: string; run: () => void };
}

/**
 * Wie lange ein Toast steht.
 *
 * Lang genug, um eine Aenderung zurueckzunehmen, die man versehentlich
 * gemacht hat – und kurz genug, dass er nicht die Liste verdeckt, an der man
 * gerade arbeitet.
 */
const TOAST_MS = 6_000;

interface DragState {
  id: string;
  pointerId: number;
  size: WidgetSize;
  /** Startpunkt des Fingers in Bildschirmkoordinaten. */
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  /** Rasterplatz beim Aufsetzen des Fingers. */
  origin: { x: number; y: number };
  /** Masse der Rasterflaeche, einmal beim Aufsetzen gemessen. */
  area: DOMRect;
  target: { x: number; y: number } | null;
  valid: boolean;
  moved: boolean;
}

function clampCell(value: number, max: number): number {
  return Math.min(Math.max(0, max), Math.max(0, value));
}

const formatPercent = (value: number): string => value.toFixed(1).replace('.', ',').replace(',0', '');

/** Uhrzeit ohne Sekunden – mehr braucht ein Ablauf in fuenf Minuten nicht. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '–'
    : date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * "heute 14:32" statt eines vollen Datums: bei einem Geraet, das gerade eben
 * noch da war, interessiert die Uhrzeit – beim Rest der Tag.
 */
function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? `heute ${time}` : `${date.toLocaleDateString('de-DE')} ${time}`;
}

export class MirrorRemote extends LitElement {
  static override properties = {
    snapshot: { state: true },
    tab: { state: true },
    screen: { state: true },
    selected: { state: true },
    drag: { state: true },
    pendingDelete: { state: true },
    notice: { state: true },
    toasts: { state: true },
    code: { state: true },
  };

  declare snapshot: StoreSnapshot;
  declare tab: Tab;
  /** Screen, der gerade bearbeitet wird. `null` = der erste. */
  declare screen: string | null;
  /** Block, dessen Einstellungen offen sind. */
  declare selected: string | null;
  declare drag: DragState | null;
  /** Screen, dessen Loeschen bestaetigt werden muss. */
  declare pendingDelete: string | null;
  /** Hinweis, der nicht vom Spiegel kommt, sondern hier entsteht. */
  declare notice: string | null;
  /**
   * Bestaetigungen am unteren Rand.
   *
   * Jede Aenderung geht sofort an den Spiegel – es gibt kein "Speichern", und
   * damit auch keinen Moment, in dem man sie noch zuruecknehmen koennte. Der
   * Toast ist dieser Moment: er sagt, was passiert ist, und bietet an, es
   * rueckgaengig zu machen, solange er steht.
   */
  declare toasts: Toast[];
  declare code: string;

  constructor() {
    super();
    this.snapshot = store.value;
    this.tab = 'module';
    this.screen = null;
    this.selected = null;
    this.drag = null;
    this.pendingDelete = null;
    this.notice = null;
    this.toasts = [];
    this.code = '';
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /*
   * Die App zeichnet sonst nur neu, wenn der Spiegel etwas schickt. Eine
   * Aussage ueber die Uhrzeit veraltet aber von selbst – ohne diesen Takt
   * stuende "Laeuft gerade" auch noch um zehn Uhr morgens da.
   */
  #tick: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    store.addEventListener('change', this.#onChange);
    this.#tick = setInterval(() => this.requestUpdate(), 30_000);
  }

  override disconnectedCallback(): void {
    store.removeEventListener('change', this.#onChange);
    if (this.#tick !== null) clearInterval(this.#tick);
    this.#tick = null;
    super.disconnectedCallback();
  }


  #onChange = (): void => {
    const before = this.snapshot;
    this.snapshot = store.value;

    /*
     * Der Verbindungsverlust ist die eine Meldung, die von selbst kommt.
     *
     * Als Toast und nicht als Banner: ein Banner oben faellt beim Arbeiten an
     * einer Liste nicht auf, ein Toast unten steht dort, wo der Daumen ohnehin
     * ist. Nur beim Uebergang, nicht bei jedem Zustandswechsel – sonst
     * stapelten sich waehrend eines Neustarts ein Dutzend davon.
     */
    if (before.status !== 'offline' && this.snapshot.status === 'offline') {
      this.#toast('Spiegel nicht erreichbar', 'warn', {
        label: 'Erneut',
        run: () => store.connect(),
      });
    }
  };

  /**
   * Zeigt eine Bestaetigung und raeumt sie nach einer Weile weg.
   *
   * Die Id kommt aus einem Zaehler und nicht aus der Uhrzeit: zwei Toasts in
   * derselben Millisekunde haetten sonst dieselbe Id, und lit haengt seine
   * Wiederverwendung genau daran.
   */
  #toastId = 0;

  #toast(text: string, tone: Toast['tone'] = 'ok', action?: Toast['action']): void {
    this.#toastId += 1;
    const id = this.#toastId;
    this.toasts = [...this.toasts, { id, text, tone, ...(action ? { action } : {}) }];
    window.setTimeout(() => this.#dismissToast(id), TOAST_MS);
  }

  #dismissToast(id: number): void {
    this.toasts = this.toasts.filter((entry) => entry.id !== id);
  }

  /** Die Bestaetigungen selbst – immer im Dokument, damit sie nichts verschieben. */
  #renderToasts(): TemplateResult | typeof nothing {
    if (this.toasts.length === 0) return nothing;
    return html`
      <div class="toasts">
        ${this.toasts.map(
          (toast) => html`
            <div class="toast toast--${toast.tone}">
              <span class="toast__text">${toast.text}</span>
              ${toast.action
                ? html`<button
                    class="toast__action"
                    @click=${() => {
                      toast.action?.run();
                      this.#dismissToast(toast.id);
                    }}
                  >
                    ${toast.action.label}
                  </button>`
                : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const { status, config } = this.snapshot;
    // Die Einrichtung ist kein Reiter neben den anderen: solange sie laeuft,
    // ist sie die ganze App. Wer beim Ausrichten zwischen Modulen und Rahmen
    // hin- und herspringen kann, richtet nicht aus.
    // Ein Geraet, das der Spiegel noch nicht kennt, ist zweierlei: entweder der
    // allererste Kontakt – dann fuehrt die Einrichtung – oder eines, das zu
    // schon gekoppelten dazukommt. Das zweite ist keine Einrichtung und darf
    // sich auch nicht so anfuehlen.
    if (status === 'pairing') {
      return html`${this.snapshot.mirrorPaired ? this.#renderJoin() : this.#renderSetup('pair')}
      ${this.#renderToasts()}`;
    }
    if (!config) return html`${this.#renderLoading()}${this.#renderToasts()}`;
    if (config.setup.step !== 'done') {
      return html`${this.#renderSetup(config.setup.step)}${this.#renderToasts()}`;
    }

    return html`
      <header class="topbar">
        <div>
          <h1>${config.deviceName}</h1>
          <span class="topbar__status ${status === 'offline' ? 'is-offline' : ''}">
            ${status === 'offline' ? 'keine Verbindung' : this.snapshot.powerOn ? 'Anzeige an' : 'Anzeige aus'}
          </span>
        </div>
        <button
          class="power ${this.snapshot.powerOn ? 'power--on' : ''}"
          @click=${() => store.send({ t: 'admin:power', on: !this.snapshot.powerOn })}
          aria-label="Anzeige ein- oder ausschalten"
        >
          ${this.snapshot.powerOn ? 'Aus' : 'An'}
        </button>
      </header>

      <nav class="tabs">
        ${(['module', 'anzeige', 'system'] as Tab[]).map(
          (tab) => html`
            <button class=${this.tab === tab ? 'is-active' : ''} @click=${() => this.#selectTab(tab)}>
              ${tab === 'module' ? 'Module' : tab === 'anzeige' ? 'Anzeige' : 'System'}
            </button>
          `,
        )}
      </nav>

      ${this.snapshot.lastError ? html`<p class="banner banner--error">${this.snapshot.lastError}</p>` : nothing}
      ${this.notice ? html`<p class="banner banner--hint">${this.notice}</p>` : nothing}

      <main>
        ${this.tab === 'module'
          ? this.#renderModules()
          : this.tab === 'anzeige'
            ? this.#renderDisplay()
            : this.#renderSystem()}
      </main>

      ${this.#renderToasts()}
    `;
  }

  /**
   * Reiterwechsel.
   *
   * Wer die Modulseite verlaesst, arbeitet nicht mehr an einem Screen: der
   * Spiegel darf wieder selbst weiterschalten. Sonst bliebe er stehen, weil
   * jemand die App weggelegt hat.
   */
  #selectTab(tab: Tab): void {
    if (this.tab === tab) return;
    if (this.tab === 'module' && this.snapshot.previewScreenId !== null) {
      store.send({ t: 'admin:previewScreen', screenId: null });
    }
    this.tab = tab;
    this.notice = null;
    this.pendingDelete = null;
  }

  /* ------------------------------- Einrichtung ------------------------------- */

  #renderSetup(step: SetupStep): TemplateResult {
    return html`
      <div class="setup">
        <ol class="stepper">
          ${SETUP_FLOW_STEPS.map(
            (entry, index) => html`
              <li
                class=${setupStepNumber(step) > index + 1
                  ? 'is-done'
                  : setupStepNumber(step) === index + 1
                    ? 'is-active'
                    : ''}
              >
                <span class="stepper__dot">${index + 1}</span>
                <span class="stepper__label">${SETUP_STEP_TITLES[entry]}</span>
              </li>
            `,
          )}
        </ol>

        ${step === 'pair' ? this.#renderPairStep() : this.#renderFrameStep()}
      </div>
    `;
  }

  /** Schritt 1: der Code steht auf dem Spiegel, eingetippt wird er hier. */
  #renderPairStep(): TemplateResult {
    return html`
      <section class="setup__step">
        <h1>Spiegel koppeln</h1>
        <p class="muted">Auf dem Spiegel steht ein sechsstelliger Code. Gib ihn hier ein.</p>
        ${this.snapshot.pairing.open
          ? html`
              ${this.#renderCodeEntry()}
              <p class="muted small">
                Der Code laeuft ${this.snapshot.pairing.expiresAt
                  ? html`um ${formatTime(this.snapshot.pairing.expiresAt)}`
                  : 'nach fuenf Minuten'}
                ab.
              </p>
            `
          : html`
              <!-- Abgelaufen, waehrend die App offen lag: ein neuer Code ist
                   einen Fingertipp entfernt und keinen Neustart. -->
              <p class="muted small">Der Code ist abgelaufen.</p>
              <div class="card__actions">
                <button class="primary" @click=${() => store.requestPairing()}>Neuen Code anzeigen</button>
              </div>
            `}
        ${this.snapshot.lastError ? html`<p class="banner banner--error">${this.snapshot.lastError}</p>` : nothing}
      </section>
    `;
  }

  /**
   * Ein weiteres Geraet meldet sich an einem Spiegel, der schon laeuft.
   *
   * Bewusst keine Einrichtung mit Schrittanzeige: eingerichtet ist der Spiegel
   * laengst. Und bewusst mit einem Knopf davor – der Code erscheint erst, wenn
   * jemand ihn anfordert. Vorher zeigte ihn der Spiegel jedem, der die Adresse
   * im Browser oeffnete, quer ueber den Inhalt.
   */
  #renderJoin(): TemplateResult {
    const { pairing } = this.snapshot;
    return html`
      <div class="setup">
        <section class="setup__step">
          <h1>Mit dem Spiegel koppeln</h1>
          <p class="muted">
            Dieses Geraet kennt der Spiegel noch nicht. Lass dir einen Code anzeigen und gib ihn hier ein – die
            bereits gekoppelten Geraete bleiben davon unberuehrt.
          </p>

          ${pairing.open
            ? html`
                ${this.#renderCodeEntry()}
                <p class="muted small">
                  Der Code steht am unteren Rand des Spiegels${pairing.expiresAt
                    ? html` und laeuft um ${formatTime(pairing.expiresAt)} ab`
                    : nothing}.
                </p>
                <div class="card__actions">
                  <button @click=${() => store.cancelPairing()}>Code wieder ausblenden</button>
                </div>
              `
            : html`
                <div class="card__actions">
                  <button class="primary" @click=${() => store.requestPairing()}>Code am Spiegel anzeigen</button>
                </div>
              `}
          ${this.snapshot.lastError ? html`<p class="banner banner--error">${this.snapshot.lastError}</p>` : nothing}
          <p class="muted small">
            Auf dem iPhone sind Safari und die zum Startbildschirm hinzugefuegte App zwei getrennte Speicher – und
            damit zwei Geraete. Beide koennen gekoppelt sein.
          </p>
        </section>
      </div>
    `;
  }

  #renderCodeEntry(): TemplateResult {
    return html`
      <input
        class="pairing__input"
        inputmode="numeric"
        pattern="[0-9]*"
        maxlength="6"
        placeholder="000000"
        autocomplete="one-time-code"
        .value=${this.code}
        @input=${(event: Event) => {
          this.code = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
          if (this.code.length === 6) store.pair(this.code);
        }}
      />
    `;
  }

  /**
   * Schritt 2: der Spiegel zeigt jetzt einen Rahmen, hier werden dessen vier
   * Kanten verschoben. Beides muss gleichzeitig zu sehen sein – deshalb steht
   * hier eine Vorschau desselben Rahmens und nicht nur eine Zahlenliste.
   */
  #renderFrameStep(): TemplateResult {
    const config = this.snapshot.config;
    if (!config) return this.#renderLoading();

    return html`
      <section class="setup__step">
        <h1>Bildschirm ausrichten</h1>
        <p class="muted">
          Auf dem Spiegel ist jetzt ein Rahmen zu sehen: er zeigt die bespielbare Flaeche. Sitzt der Bildschirm nicht
          mittig hinter dem Rahmen, schiebe die Kanten einzeln nach innen oder aussen, bis rundum gleich viel Rand
          bleibt.
        </p>

        ${this.#renderInsetControls(config.display.insets)}

        <div class="card__actions setup__actions">
          <button
            class="primary"
            @click=${() => store.send({ t: 'admin:setSettings', patch: { setup: { step: 'done', completedAt: null } } })}
          >
            Fertig
          </button>
        </div>
        <p class="muted small">
          Spaeter aendern: <b>Anzeige → Bildschirmflaeche</b>. Der Rahmen laesst sich dort jederzeit wieder einblenden.
        </p>
      </section>
    `;
  }

  /**
   * Vorschau plus vier mal "−/+".
   *
   * Absichtlich Tasten und kein Schieberegler: auf einem Handy trifft man mit
   * dem Daumen keine halben Prozent, und die Rueckmeldung kommt nicht auf dem
   * Handy, sondern zwei Meter weiter an der Wand. Ein Druck ist ein Schritt,
   * und jeder Schritt ist am Spiegel sofort zu sehen.
   *
   * Kein Halten-zum-Wiederholen: jeder Schritt schreibt die Konfiguration auf
   * die Speicherkarte des Pi, und eine gedrueckt gehaltene Taste waere ein
   * Dauerfeuer von Schreibvorgaengen.
   */
  #renderInsetControls(insets: ScreenInsets): TemplateResult {
    const viewport = this.snapshot.viewport;
    const aspect = viewport ? viewport.width / viewport.height : FALLBACK_ASPECT;

    return html`
      <div class="align">
        <div class="align__screen" style=${`aspect-ratio: ${aspect}`}>
          <div
            class="align__area"
            style=${`top:${insets.top}%;right:${insets.right}%;bottom:${insets.bottom}%;left:${insets.left}%`}
          >
            <span class="align__hint">bespielbar</span>
          </div>
        </div>

        ${INSET_SIDE_OPTIONS.map((side) => this.#renderInsetRow(insets, side.id, side.name))}

        <div class="align__row align__row--all">
          <span class="align__side">Alle Seiten</span>
          <div class="align__controls">
            <button
              aria-label="Alle Seiten nach aussen"
              ?disabled=${INSET_SIDE_OPTIONS.every((side) => insets[side.id] <= INSET_MIN)}
              @click=${() => this.#patchInsets(adjustAllInsets(insets, -INSET_STEP))}
            >
              −
            </button>
            <span class="align__value muted small">gleichzeitig</span>
            <button
              aria-label="Alle Seiten nach innen"
              ?disabled=${INSET_SIDE_OPTIONS.every((side) => insets[side.id] >= INSET_MAX)}
              @click=${() => this.#patchInsets(adjustAllInsets(insets, INSET_STEP))}
            >
              +
            </button>
          </div>
        </div>

        <div class="card__actions">
          <button
            ?disabled=${insetsEqual(insets, createDefaultInsets())}
            @click=${() => this.#patchInsets(createDefaultInsets())}
          >
            Zuruecksetzen
          </button>
        </div>
      </div>
    `;
  }

  #renderInsetRow(insets: ScreenInsets, side: InsetSide, label: string): TemplateResult {
    const value = insets[side];
    const viewport = this.snapshot.viewport;
    // Oben und unten rechnen gegen die Hoehe, links und rechts gegen die
    // Breite – genauso, wie die Anzeige die Prozentwerte aufloest.
    const length = viewport ? (side === 'top' || side === 'bottom' ? viewport.height : viewport.width) : null;

    return html`
      <div class="align__row">
        <span class="align__side">${label}</span>
        <div class="align__controls">
          <button
            aria-label=${`${label} nach aussen`}
            ?disabled=${value <= INSET_MIN}
            @click=${() => this.#patchInsets(adjustInset(insets, side, -INSET_STEP))}
          >
            −
          </button>
          <span class="align__value">
            <b>${formatPercent(value)} %</b>
            ${length ? html`<span class="muted small">${insetToPixels(value, length)} px</span>` : nothing}
          </span>
          <button
            aria-label=${`${label} nach innen`}
            ?disabled=${value >= INSET_MAX}
            @click=${() => this.#patchInsets(adjustInset(insets, side, INSET_STEP))}
          >
            +
          </button>
        </div>
      </div>
    `;
  }

  #patchInsets(insets: ScreenInsets): void {
    const display = this.snapshot.config?.display;
    if (!display) return;
    store.send({ t: 'admin:setSettings', patch: { display: { ...display, insets } } });
  }

  #renderLoading(): TemplateResult {
    return html`<div class="pairing"><p class="muted">Verbinde mit dem Spiegel …</p></div>`;
  }

  /* ---------------------------------- Module --------------------------------- */

  /**
   * Modulseite: oben die Screens, darunter das Brett.
   *
   * Das Brett ist die eigentliche Bedienung. Eine Liste mit Positionsauswahl
   * je Modul hat frueher genau eine Frage nicht beantwortet – wie sieht das
   * zusammen aus? Hier steht die Antwort massstabsgetreu auf dem Bildschirm,
   * mit denselben Raendern und demselben Raster wie an der Wand.
   */
  #renderModules(): TemplateResult {
    const config = this.snapshot.config;
    if (!config) return html``;
    const screen = this.#currentScreen();
    if (!screen) return html``;
    const byId = new Map(this.snapshot.modules.map((entry) => [entry.id, entry]));
    const instance = config.instances.find((entry) => entry.id === this.selected) ?? null;

    return html`
      <nav class="screens">
        ${config.screens.map(
          (entry) => html`
            <button
              class="screens__tab ${entry.id === screen.id ? 'is-active' : ''}"
              @click=${() => this.#selectScreen(entry.id)}
            >
              ${entry.name}
              <span class="screens__time">${formatScreenDuration(entry.durationSeconds)}</span>
            </button>
          `,
        )}
        <button class="screens__add" aria-label="Screen hinzufuegen" @click=${() => store.send({ t: 'admin:addScreen' })}>
          +
        </button>
      </nav>

      ${this.#renderBoard(config, screen)}

      <label class="field field--switch">
        <span class="field__label">
          Am Spiegel mitzeigen
          <span class="field__hint">
            Der Spiegel bleibt auf diesem Screen stehen, solange hier daran gearbeitet wird.
          </span>
        </span>
        <input
          type="checkbox"
          .checked=${this.snapshot.previewScreenId !== null}
          @change=${(event: Event) =>
            store.send({
              t: 'admin:previewScreen',
              screenId: (event.target as HTMLInputElement).checked ? screen.id : null,
            })}
        />
      </label>

      ${this.#renderSilent(config, screen)}

      ${instance
        ? this.#renderInstance(instance, byId.get(instance.moduleId), config)
        : html`<p class="muted small board__hint">
            Block antippen, um ihn einzustellen. Ziehen verschiebt ihn im Raster.
          </p>`}

      <h2>Modul hinzufuegen</h2>
      <section class="cards">
        ${this.snapshot.modules.map(
          (descriptor) => html`
            <div class="card card--add">
              <div>
                <strong>${descriptor.name}</strong>
                <span class="muted small">v${descriptor.version} · ${descriptor.description ?? ''}</span>
                ${descriptor.sizes.length < WIDGET_SIZE_OPTIONS.length
                  ? html`<span class="muted small">Groessen: ${formatWidgetSizes(descriptor.sizes)}</span>`
                  : nothing}
                ${descriptor.loadError
                  ? html`<span class="banner banner--error small">${descriptor.loadError}</span>`
                  : nothing}
              </div>
              <!--
                Zwei Knoepfe, weil es zwei Absichten gibt.
                
                "Als Block" braucht Platz im Raster und scheitert, wenn keiner
                frei ist. "Nur melden" braucht keinen — und muss deshalb auch
                dann gehen, wenn der Screen voll ist. Das ist der haeufigere
                Fall, als man denkt: ein Kalender, der bloss die naechsten
                Termine in den Mitteilungsblock schiebt, will gar keine Flaeche.
              -->
              <div class="card__actions">
                <button
                  ?disabled=${Boolean(descriptor.loadError) ||
                  (descriptor.singleton && config.instances.some((i) => i.moduleId === descriptor.id))}
                  @click=${() =>
                    store.send({ t: 'admin:addInstance', moduleId: descriptor.id, screenId: screen.id })}
                >
                  Als Block
                </button>
                <button
                  class="ghost"
                  ?disabled=${Boolean(descriptor.loadError) ||
                  (descriptor.singleton && config.instances.some((i) => i.moduleId === descriptor.id))}
                  @click=${() =>
                    store.send({
                      t: 'admin:addInstance',
                      moduleId: descriptor.id,
                      screenId: screen.id,
                      visible: false,
                    })}
                >
                  Nur melden
                </button>
              </div>
            </div>
          `,
        )}
      </section>

      ${this.#renderScreenSettings(config, screen)}
    `;
  }

  /**
   * Das Brett.
   *
   * Es zeigt die Flaeche des Spiegels im richtigen Seitenverhaeltnis, mit den
   * eingestellten Raendern und dem Raster darin. Was hier passt, passt an der
   * Wand – und was hier ueber die Kante ragt, ragt auch dort darueber.
   */
  /**
   * Was laeuft, ohne auf dem Screen zu stehen.
   *
   * Diese Instanzen stehen auf keinem Brett – ohne diese Liste waeren sie
   * angelegt und danach nicht mehr erreichbar. Sie sieht bewusst nicht aus wie
   * ein Block: was hier steht, hat keinen Platz und keine Groesse, sondern nur
   * einen Namen und Einstellungen.
   */
  #renderSilent(config: MirrorConfig, screen: MirrorScreen): TemplateResult | typeof nothing {
    const silent = config.instances.filter(
      (entry) => entry.screenId === screen.id && entry.visible === false,
    );
    if (silent.length === 0) return nothing;

    return html`
      <div class="silent">
        <span class="silent__label">Nur als Mitteilung</span>
        ${silent.map(
          (entry) => html`
            <button
              class="silent__item ${this.selected === entry.id ? 'is-active' : ''} ${entry.enabled
                ? ''
                : 'is-off'}"
              @click=${() => (this.selected = this.selected === entry.id ? null : entry.id)}
            >
              ${this.#moduleName(entry.moduleId)}
              ${this.snapshot.state[entry.id]?.error
                ? html`<span class="dot dot--error"></span>`
                : nothing}
            </button>
          `,
        )}
      </div>
    `;
  }

  #renderBoard(config: MirrorConfig, screen: MirrorScreen): TemplateResult {
    const viewport = this.snapshot.viewport;
    const aspect = viewport ? viewport.width / viewport.height : FALLBACK_ASPECT;
    const grid = config.display.grid;
    const insets = config.display.insets;
    /*
     * Aufs Brett kommt nur, was einen Platz belegt.
     *
     * Eine Quelle, die bloss Mitteilungen liefert, hat im Raster nichts
     * verloren – sie stuende dort als Block, den es auf dem Spiegel nicht
     * gibt. Erreichbar bleibt sie ueber die Liste unter dem Brett.
     */
    const instances = config.instances.filter(
      (entry) => entry.screenId === screen.id && entry.visible !== false,
    );
    const overlapping = this.#overlapping(instances, grid);
    const drag = this.drag;

    const cells = Array.from({ length: grid.columns * grid.rows }, (_unused, index) => {
      const x = index % grid.columns;
      const y = Math.floor(index / grid.columns);
      return html`<div class="board__cell" style=${`grid-column:${x + 1};grid-row:${y + 1}`}></div>`;
    });

    /*
     * Eine Szene hat kein Raster, in das man Bloecke schiebt – sie hat drei
     * Baender. Das Brett zeigt deshalb etwas anderes, sobald der Screen als
     * Szene laeuft: Ziehen gaebe es dort nichts zu tun.
     */
    if (screen.layout === 'zones') return this.#renderZoneBoard(config, screen, aspect);

    return html`
      <div class="board" style=${`aspect-ratio: ${aspect}`}>
        <div
          class="board__area"
          style=${`top:${insets.top}%;right:${insets.right}%;bottom:${insets.bottom}%;left:${insets.left}%;` +
          `grid-template-columns:repeat(${grid.columns},1fr);grid-template-rows:repeat(${grid.rows},1fr)`}
        >
          ${cells}
          ${drag?.target
            ? html`<div
                class="board__ghost ${drag.valid ? '' : 'is-invalid'}"
                style=${this.#areaStyle(drag.target.x, drag.target.y, drag.size, grid)}
              ></div>`
            : nothing}
          ${instances.map((entry) => this.#renderWidget(entry, grid, overlapping.has(entry.id)))}
          ${instances.length === 0
            ? html`<p class="board__empty muted small">Noch kein Modul auf diesem Screen.</p>`
            : nothing}
        </div>
      </div>
      ${overlapping.size > 0
        ? html`<p class="banner banner--hint small">
            Zwei Bloecke liegen uebereinander. Das passiert, wenn das Raster kleiner wird als die Anordnung –
            verschiebe oder verkleinere einen der beiden.
          </p>`
        : nothing}
    `;
  }

  /**
   * Das Brett einer Szene: drei Baender statt eines Rasters.
   *
   * Es hat dieselben Proportionen wie der Spiegel und dieselben Anteile wie
   * die Anzeige (20 / 60 / 20), damit die Frage, um die es hier geht, auch
   * hier beantwortet wird: wie sieht das zusammen aus?
   *
   * Gezogen wird nichts. In einer Szene gibt es je Band nur "drin" oder
   * "nicht drin" – und ein Band waehlt man am Block aus, nicht durch Zielen
   * mit dem Daumen auf ein Fuenftel Bildschirmhoehe.
   */
  #renderZoneBoard(config: MirrorConfig, screen: MirrorScreen, aspect: number): TemplateResult {
    const insets = config.display.insets;
    /*
     * Auch hier gilt: aufs Brett kommt nur, was einen Platz belegt.
     *
     * Ein Block, der bloss meldet, steht auf dem Spiegel in keinem Band – auf
     * dem Brett stand er trotzdem, und zwar in dem Band, das seine Instanz
     * zufaellig mitschreibt. Damit zaehlte er in der Warnung "zu voll" mit,
     * fuer eine Enge, die es an der Wand gar nicht gibt. Erreichbar bleibt er
     * ueber die Liste unter dem Brett.
     */
    const instances = config.instances.filter(
      (entry) => entry.screenId === screen.id && entry.visible !== false,
    );

    return html`
      <div class="board" style=${`aspect-ratio: ${aspect}`}>
        <div
          class="board__area board__area--zones"
          style=${`top:${insets.top}%;right:${insets.right}%;bottom:${insets.bottom}%;left:${insets.left}%`}
        >
          ${ZONE_OPTIONS.map((zone) => {
            const inZone = instances.filter((entry) => entry.zone === zone.id);
            return html`
              <div
                class="board__zone board__zone--${zone.id} ${inZone.length > ZONE_CAPACITY[zone.id]
                  ? 'is-overfull'
                  : ''}"
              >
                <span class="board__zone-name">${zone.name}${this.#zoneTiming(zone.id, screen, inZone.length)}</span>
                ${inZone.map(
                  (entry) => html`
                    <button
                      class="board__widget board__widget--zone ${entry.id === this.selected
                        ? 'is-selected'
                        : ''} ${entry.enabled ? '' : 'is-off'}"
                      @click=${() => {
                        this.selected = this.selected === entry.id ? null : entry.id;
                      }}
                    >
                      <span class="board__name">${this.#moduleName(entry.moduleId)}</span>
                      <span class="board__size">${WIDGET_SIZE_SPECS[entry.size].label}</span>
                    </button>
                  `,
                )}
              </div>
            `;
          })}
          ${instances.length === 0
            ? html`<p class="board__empty muted small">Noch kein Modul in dieser Szene.</p>`
            : nothing}
        </div>
      </div>
      ${this.#zoneWarning(instances)}
    `;
  }

  /**
   * Wie lange ein Element im Fussband steht.
   *
   * Nur dort und nur ab zwei Bloecken: das Fussband stellt nicht nebeneinander,
   * sondern schaltet durch, und die Standzeit dafuer kommt aus dem Screen. Wer
   * hier einen dritten Block hineinlegt, macht damit die Zeit der beiden
   * anderen kuerzer – ohne diese Zahl waere das eine Auswirkung, die man erst
   * an der Wand bemerkt.
   */
  #zoneTiming(zone: Zone, screen: MirrorScreen, count: number): string {
    if (zone !== 'foot' || count < 2) return '';
    return ` · je ${formatScreenDuration(Math.round(screen.durationSeconds / count))}`;
  }

  /**
   * Zu voll ist kein Fehler, sondern ein Hinweis.
   *
   * Ein Band, in dem mehr steht, als hineingehoert, wird auf dem Spiegel
   * einfach enger – nichts geht verloren, nichts ueberdeckt sich. Deshalb
   * lehnt die App das nicht ab, sondern sagt es: das Design-System nennt drei
   * Elemente je Szene als Obergrenze, und ob die vierte Zeile es wert ist,
   * entscheidet, wer davorsteht.
   *
   * Im Fussband ist die Folge eine andere: dort wird nicht enger gestellt,
   * sondern schneller durchgeschaltet. Beides steht deshalb im Hinweis, denn
   * "zu voll" heisst hier zwei verschiedene Dinge.
   */
  #zoneWarning(instances: readonly ModuleInstance[]): TemplateResult | typeof nothing {
    const full = ZONE_OPTIONS.filter(
      (zone) => instances.filter((entry) => entry.zone === zone.id).length > ZONE_CAPACITY[zone.id],
    );
    if (full.length === 0) return nothing;
    return html`<p class="banner banner--hint small">
      ${full.map((zone) => zone.name).join(' und ')} traegt mehr Bloecke als vorgesehen. Im Kopf und in der
      Hauptzone ruecken sie dann zusammen, im Fussband wird der Durchlauf kuerzer – eine Szene liest sich mit
      hoechstens drei Elementen am schnellsten.
    </p>`;
  }

  /**
   * Bloecke, die sich gegenseitig verdecken.
   *
   * Entsteht nur, wenn das Raster nachtraeglich kleiner wird und alle Bloecke
   * zusammenruecken muessen. Auf dem Spiegel saehe man davon nichts – hier
   * schon, und deshalb steht der Hinweis genau hier.
   */
  #overlapping(instances: readonly ModuleInstance[], grid: GridSize): Set<string> {
    const found = new Set<string>();
    for (let i = 0; i < instances.length; i += 1) {
      for (let j = i + 1; j < instances.length; j += 1) {
        const a = instances[i]!;
        const b = instances[j]!;
        if (!rectsOverlap(rectFor(a, grid), rectFor(b, grid))) continue;
        found.add(a.id);
        found.add(b.id);
      }
    }
    return found;
  }

  #renderWidget(instance: ModuleInstance, grid: GridSize, overlaps: boolean): TemplateResult {
    const descriptor = this.snapshot.modules.find((entry) => entry.id === instance.moduleId);
    const envelope = this.snapshot.state[instance.id];
    const drag = this.drag?.id === instance.id ? this.drag : null;
    const rect = rectFor(instance, grid);

    return html`
      <div
        class="board__widget ${instance.enabled ? '' : 'is-off'} ${overlaps ? 'is-overlap' : ''} ${this.selected ===
        instance.id
          ? 'is-selected'
          : ''} ${drag ? 'is-dragging' : ''}"
        style=${this.#areaStyle(rect.x, rect.y, instance.size, grid) +
        (drag ? `;transform:translate(${drag.dx}px,${drag.dy}px)` : '')}
        @pointerdown=${(event: PointerEvent) => this.#dragStart(event, instance, grid)}
        @pointermove=${(event: PointerEvent) => this.#dragMove(event, grid)}
        @pointerup=${(event: PointerEvent) => this.#dragEnd(event, instance)}
        @pointercancel=${() => (this.drag = null)}
      >
        <span class="board__name">${descriptor?.name ?? instance.moduleId}</span>
        <span class="board__size">${WIDGET_SIZE_SPECS[instance.size].label}</span>
        ${envelope?.error ? html`<span class="dot dot--error" title=${envelope.error}></span>` : nothing}
      </div>
    `;
  }

  /** Der Name, den der Spiegel fuer ein Modul kennt – sonst seine Id. */
  #moduleName(moduleId: string): string {
    return this.snapshot.modules.find((entry) => entry.id === moduleId)?.name ?? moduleId;
  }

  /** Rasterplatz als Inline-Style. Dieselbe Rechnung wie in der Anzeige. */
  #areaStyle(x: number, y: number, size: WidgetSize, grid: GridSize): string {
    const cells = sizeCells(size, grid);
    return `grid-column:${x + 1} / span ${cells.columns};grid-row:${y + 1} / span ${cells.rows}`;
  }

  /* --------------------------------- Ziehen ---------------------------------- */

  /**
   * Ziehen mit dem Finger.
   *
   * Der Block folgt dem Finger frei, waehrend darunter ein Umriss die Zelle
   * zeigt, in die er einrasten wird. Frei folgen allein waere ungenau, nur
   * einrasten allein waere ruckelig – zusammen sieht man beides: wohin man
   * zieht und wo es landet.
   *
   * Ein Druck ohne Bewegung ist kein Ziehen, sondern eine Auswahl. Deshalb die
   * Schwelle: auf einem Handy wackelt jeder Finger um ein paar Pixel.
   */
  #dragStart(event: PointerEvent, instance: ModuleInstance, grid: GridSize): void {
    const widget = event.currentTarget as HTMLElement;
    const area = widget.parentElement;
    if (!area) return;
    widget.setPointerCapture(event.pointerId);
    this.drag = {
      id: instance.id,
      pointerId: event.pointerId,
      size: instance.size,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      origin: { x: rectFor(instance, grid).x, y: rectFor(instance, grid).y },
      area: area.getBoundingClientRect(),
      target: null,
      valid: true,
      moved: false,
    };
  }

  #dragMove(event: PointerEvent, grid: GridSize): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const moved = drag.moved || Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
    if (!moved) return;

    const cellWidth = drag.area.width / grid.columns;
    const cellHeight = drag.area.height / grid.rows;
    const cells = sizeCells(drag.size, grid);
    const x = clampCell(Math.round(drag.origin.x + dx / cellWidth), grid.columns - cells.columns);
    const y = clampCell(Math.round(drag.origin.y + dy / cellHeight), grid.rows - cells.rows);

    this.drag = { ...drag, dx, dy, moved, target: { x, y }, valid: this.#spotFree(drag.id, x, y, drag.size, grid) };
  }

  #dragEnd(event: PointerEvent, instance: ModuleInstance): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag || drag.pointerId !== event.pointerId) return;

    // Kein Weg zurueckgelegt: das war ein Antippen und heisst "einstellen".
    if (!drag.moved) {
      this.selected = this.selected === instance.id ? null : instance.id;
      return;
    }
    if (!drag.target || !drag.valid) return;
    if (drag.target.x === drag.origin.x && drag.target.y === drag.origin.y) return;

    const origin = drag.origin;
    store.send({
      t: 'admin:setLayout',
      instances: [{ id: instance.id, x: drag.target.x, y: drag.target.y }],
    });
    this.#toast('Block verschoben', 'ok', {
      label: 'Rueckgaengig',
      run: () =>
        store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, x: origin.x, y: origin.y }] }),
    });
  }

  /** Liegt an dieser Stelle schon ein anderer Block? */
  #spotFree(id: string, x: number, y: number, size: WidgetSize, grid: GridSize): boolean {
    const config = this.snapshot.config;
    const instance = config?.instances.find((entry) => entry.id === id);
    if (!config || !instance) return false;
    const cells = sizeCells(size, grid);
    const candidate = { x, y, columns: cells.columns, rows: cells.rows };
    return !config.instances
      .filter((entry) => entry.screenId === instance.screenId && entry.id !== id)
      .some((entry) => rectsOverlap(rectFor(entry, grid), candidate));
  }

  /* ------------------------------ Ausgewaehlter Block ------------------------------ */

  #renderInstance(
    instance: ModuleInstance,
    descriptor: ModuleDescriptor | undefined,
    config: MirrorConfig,
  ): TemplateResult {
    const envelope = this.snapshot.state[instance.id];
    // Ein Modul ohne Descriptor ist gerade nicht geladen – dann bleibt die
    // Auswahl stehen, wie sie ist, statt Groessen zu verbieten.
    const sizes = descriptor?.sizes ?? WIDGET_SIZES;
    const zones = config.screens.find((entry) => entry.id === instance.screenId)?.layout === 'zones';

    return html`
      <section class="card card--sheet ${instance.enabled ? '' : 'card--off'}">
        <div class="card__head">
          <div>
            <strong>${descriptor?.name ?? instance.moduleId}</strong>
            <span class="muted small">${WIDGET_SIZE_SPECS[instance.size].name}</span>
          </div>
          <label class="switch" @click=${(event: Event) => event.stopPropagation()}>
            <input
              type="checkbox"
              .checked=${instance.enabled}
              @change=${(event: Event) =>
                store.send({
                  t: 'admin:setLayout',
                  instances: [{ id: instance.id, enabled: (event.target as HTMLInputElement).checked }],
                })}
            />
            <span></span>
          </label>
        </div>

        <div class="card__body">
          ${envelope?.error ? html`<p class="banner banner--error">${envelope.error}</p>` : nothing}

          <!--
            Der offene Schritt steht ganz oben: er ist der Grund, warum das
            Modul noch nichts anzeigt, und alles darunter hilft nichts, solange
            er nicht getan ist.
          -->
          ${envelope?.action
            ? html`
                <div class="action">
                  <span class="action__label">${envelope.action.label}</span>
                  ${envelope.action.url
                    ? html`<a
                        class="action__link"
                        href=${envelope.action.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        >Oeffnen</a
                      >`
                    : nothing}
                </div>
              `
            : nothing}

          <!--
            Zuerst die Frage, ob der Block ueberhaupt einen Platz belegt. Sie
            steht vor Groesse und Band, weil sie die beiden erledigt: wer nur
            meldet, braucht keinen Platz und keine Groesse.
          -->
          <div class="field">
            <span class="field__label">
              Auf dem Spiegel
              <span class="field__hint">
                ${
                  instance.visible === false
                    ? 'Laeuft und meldet an den Mitteilungsblock – auf jedem Screen, egal wo dieser hier steht.'
                    : 'Der Block steht als Flaeche auf diesem Screen.'
                }
              </span>
            </span>
            <div class="segmented">
              <button
                class=${instance.visible !== false ? 'is-active' : ''}
                @click=${() => this.#setVisible(instance, true)}
              >
                Als Block
              </button>
              <button
                class=${instance.visible === false ? 'is-active' : ''}
                @click=${() => this.#setVisible(instance, false)}
              >
                Nur als Mitteilung
              </button>
            </div>
          </div>

          ${
            instance.visible === false
              ? nothing
              : html`
              <div class="field">
                <span class="field__label">
                  Groesse
                  <span class="field__hint">
                    ${sizes.length < WIDGET_SIZE_OPTIONS.length
                      ? `Dieses Modul gibt es in ${formatWidgetSizes(sizes)} – kleiner bliebe vom Inhalt nichts uebrig.`
                      : 'Wie viele Rasterfelder der Block belegt.'}
                  </span>
                </span>
                <div class="sizes">
                  ${WIDGET_SIZE_OPTIONS.map(
                    (option) => html`
                      <button
                        class=${option.id === instance.size ? 'is-active' : ''}
                        title=${`${option.name} · ${option.columns}×${option.rows}`}
                        ?disabled=${!sizes.includes(option.id)}
                        @click=${() => this.#resize(instance, option.id)}
                      >
                        ${option.label}
                      </button>
                    `,
                  )}
                </div>
              </div>

              ${zones
                ? html`
                    <div class="field">
                      <span class="field__label">
                        Band
                        <span class="field__hint">
                          ${ZONE_SPECS[instance.zone].note}
                        </span>
                      </span>
                      <div class="segmented">
                        ${ZONE_OPTIONS.map(
                          (zone) => html`
                            <button
                              class=${zone.id === instance.zone ? 'is-active' : ''}
                              title=${`${zone.name} · ${zone.share} %`}
                              @click=${() => this.#moveToZone(instance, zone.id)}
                            >
                              ${zone.name}
                            </button>
                          `,
                        )}
                      </div>
                    </div>
                  `
                : nothing}
                `
          }

          ${config.screens.length > 1
            ? html`
                <label class="field">
                  <span class="field__label">Screen</span>
                  <select @change=${(event: Event) => this.#moveToScreen(instance, (event.target as HTMLSelectElement).value)}>
                    ${config.screens.map(
                      (entry) => html`
                        <option value=${entry.id} ?selected=${entry.id === instance.screenId}>${entry.name}</option>
                      `,
                    )}
                  </select>
                </label>
              `
            : nothing}

          <schema-form
            .schema=${descriptor?.configSchema}
            .value=${instance.config}
            @form-change=${(event: CustomEvent<Record<string, unknown>>) =>
              store.send({
                t: 'admin:setInstanceConfig',
                instanceId: instance.id,
                config: event.detail,
              })}
          ></schema-form>

          ${(descriptor?.secrets ?? [])
            // Was ein Modul sich selbst holt, geht den Nutzer nichts an – ein
            // leeres Feld "Zugriffstoken" waere nur eine Einladung zum Raten.
            .filter((secret) => !secret.managed)
            .map(
              (secret) => html`
                <label class="field">
                  <span class="field__label">
                    ${secret.label}
                    ${descriptor?.secretsPresent.includes(secret.key)
                      ? html`<span class="muted small">· hinterlegt</span>`
                      : nothing}
                  </span>
                  <input
                    type="password"
                    placeholder="••••••••"
                    autocomplete="off"
                    @change=${(event: Event) => {
                      const input = event.target as HTMLInputElement;
                      if (!input.value) return;
                      store.send({
                        t: 'admin:setSecret',
                        moduleId: instance.moduleId,
                        key: secret.key,
                        value: input.value,
                      });
                      input.value = '';
                    }}
                  />
                  ${secret.description
                    ? html`<span class="field__hint">${secret.description}</span>`
                    : nothing}
                </label>
              `,
            )}

          <div class="card__actions">
            <button @click=${() => (this.selected = null)}>Fertig</button>
            <button
              class="danger"
              @click=${() => {
                store.send({ t: 'admin:removeInstance', instanceId: instance.id });
                this.selected = null;
              }}
            >
              Entfernen
            </button>
          </div>
        </div>
      </section>
    `;
  }

  /**
   * Groesse wechseln.
   *
   * Ein groesserer Block passt an seiner Stelle oft nicht mehr. Statt die
   * Aenderung abzulehnen, sucht die App einen freien Platz – meistens rutscht
   * der Block nur eine Zelle nach links und niemandem faellt es auf.
   */
  /**
   * Ein Block wechselt sein Band.
   *
   * Der Rasterplatz bleibt unangetastet: ein Screen laesst sich zwischen
   * Raster und Szene umschalten, und beim Zurueckschalten soll der Block
   * wieder dort liegen, wo er lag.
   */
  #moveToZone(instance: ModuleInstance, zone: Zone): void {
    if (zone === instance.zone) return;
    const previous = instance.zone;
    store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, zone }] });
    this.#toast(`In ${ZONE_SPECS[zone].name} verschoben`, 'ok', {
      label: 'Rueckgaengig',
      run: () => store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, zone: previous }] }),
    });
  }

  /**
   * Blendet einen Block ein oder aus, ohne ihn zu stoppen.
   *
   * Beim Einblenden wird nichts gesucht und nichts gerueckt: der Block kehrt
   * an seine alten Koordinaten zurueck. Liegt dort inzwischen ein anderer,
   * sieht man das auf dem Brett sofort als Ueberlappung und schiebt ihn weg –
   * besser als ein Block, der beim Einblenden woanders auftaucht, als man ihn
   * verlassen hat.
   */
  #setVisible(instance: ModuleInstance, visible: boolean): void {
    if (instance.visible === visible) return;
    store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, visible }] });
  }

  #resize(instance: ModuleInstance, size: WidgetSize): void {
    const config = this.snapshot.config;
    if (!config || size === instance.size) return;
    const descriptor = this.snapshot.modules.find((entry) => entry.id === instance.moduleId);
    if (descriptor && !descriptor.sizes.includes(size)) return;
    const grid = config.display.grid;
    const occupied = config.instances
      .filter((entry) => entry.screenId === instance.screenId && entry.id !== instance.id)
      .map((entry) => rectFor(entry, grid));
    const spot = findFreeSpot(occupied, grid, size, { x: instance.x, y: instance.y });
    if (!spot) {
      this.notice = 'Kein Platz fuer diese Groesse. Verschiebe zuerst einen anderen Block.';
      return;
    }
    this.notice = null;
    const before = { size: instance.size, x: instance.x, y: instance.y };
    store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, size, x: spot.x, y: spot.y }] });
    this.#toast(`Groesse ${WIDGET_SIZE_SPECS[size].label}`, 'ok', {
      label: 'Rueckgaengig',
      run: () => store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, ...before }] }),
    });
  }

  #moveToScreen(instance: ModuleInstance, screenId: string): void {
    const config = this.snapshot.config;
    if (!config || screenId === instance.screenId) return;
    const grid = config.display.grid;
    const occupied = config.instances
      .filter((entry) => entry.screenId === screenId)
      .map((entry) => rectFor(entry, grid));
    const spot = findFreeSpot(occupied, grid, instance.size, { x: instance.x, y: instance.y });
    if (!spot) {
      this.notice = 'Auf diesem Screen ist kein Platz frei.';
      return;
    }
    this.notice = null;
    const before = { screenId: instance.screenId, x: instance.x, y: instance.y };
    store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, screenId, x: spot.x, y: spot.y }] });
    this.screen = screenId;
    this.#toast('Auf anderen Screen gelegt', 'ok', {
      label: 'Rueckgaengig',
      run: () => {
        store.send({ t: 'admin:setLayout', instances: [{ id: instance.id, ...before }] });
        this.screen = before.screenId;
      },
    });
  }

  /* ------------------------------ Screen-Einstellungen ------------------------------ */

  #renderScreenSettings(config: MirrorConfig, screen: MirrorScreen): TemplateResult {
    const index = config.screens.findIndex((entry) => entry.id === screen.id);
    const onScreen = config.instances.filter((entry) => entry.screenId === screen.id).length;
    const grid = config.display.grid;
    /*
     * Das Raster, das zur Aufhaengung passt: quer sechs mal vier, hochkant das
     * Raster des Design-Systems. Als Vorschlag und nicht als Automatik – wer
     * seines von Hand eingestellt hat, soll es behalten, auch wenn er den
     * Spiegel spaeter dreht.
     */
    const preset = defaultGridForRotation(config.display.rotation);
    const patchGrid = (patch: Partial<GridSize>): void =>
      store.send({
        t: 'admin:setSettings',
        patch: { display: { ...config.display, grid: { ...grid, ...patch } } },
      });

    return html`
      <h2>Screen</h2>
      <section class="panel">
        <label class="field">
          <span class="field__label">Name</span>
          <input
            type="text"
            .value=${screen.name}
            @change=${(event: Event) =>
              store.send({
                t: 'admin:setScreen',
                screenId: screen.id,
                patch: { name: (event.target as HTMLInputElement).value },
              })}
          />
        </label>

        <div class="field">
          <span class="field__label">
            Standzeit
            <span class="field__hint">
              ${config.screens.length > 1
                ? 'Danach schaltet der Spiegel auf den naechsten Screen.'
                : 'Wirkt, sobald es einen zweiten Screen gibt.'}
            </span>
          </span>
          <div class="stepper-row">
            <button
              aria-label="Kuerzer"
              ?disabled=${screen.durationSeconds <= SCREEN_DURATION_MIN}
              @click=${() => this.#patchDuration(screen, -SCREEN_DURATION_STEP)}
            >
              −
            </button>
            <b>${formatScreenDuration(screen.durationSeconds)}</b>
            <button
              aria-label="Laenger"
              ?disabled=${screen.durationSeconds >= SCREEN_DURATION_MAX}
              @click=${() => this.#patchDuration(screen, SCREEN_DURATION_STEP)}
            >
              +
            </button>
          </div>
        </div>

        <div class="field">
          <span class="field__label">
            Anordnung
            <span class="field__hint">
              ${screen.layout === 'zones'
                ? 'Drei Baender: Kopf, Hauptzone, Fussband. Am schnellsten zu lesen mit hoechstens drei Bloecken.'
                : 'Bloecke frei auf dem Raster. Kann alles – auch zu viel.'}
            </span>
          </span>
          <div class="segmented">
            ${SCREEN_LAYOUT_OPTIONS.map(
              (option) => html`
                <button
                  class=${screen.layout === option.id ? 'is-active' : ''}
                  @click=${() =>
                    store.send({
                      t: 'admin:setScreen',
                      screenId: screen.id,
                      patch: { layout: option.id },
                    })}
                >
                  ${option.name}
                </button>
              `,
            )}
          </div>
        </div>

        <div class="field">
          <span class="field__label">
            Raster
            <span class="field__hint">
              ${screen.layout === 'zones'
                ? 'Gilt fuer die Screens, die als Raster angeordnet sind – und fuer die Groesse der Bloecke.'
                : 'Gilt fuer alle Screens – sonst wuerde jeder Wechsel springen.'}
            </span>
          </span>
          <div class="card__actions">
            <button
              ?disabled=${gridEqual(grid, preset)}
              @click=${() => patchGrid(preset)}
            >
              ${preset.columns} × ${preset.rows} vorschlagen
            </button>
          </div>
          <div class="stepper-row">
            <button
              aria-label="Weniger Spalten"
              ?disabled=${grid.columns <= GRID_MIN}
              @click=${() => patchGrid({ columns: grid.columns - 1 })}
            >
              −
            </button>
            <b>${grid.columns} Spalten</b>
            <button
              aria-label="Mehr Spalten"
              ?disabled=${grid.columns >= GRID_MAX}
              @click=${() => patchGrid({ columns: grid.columns + 1 })}
            >
              +
            </button>
          </div>
          <div class="stepper-row">
            <button
              aria-label="Weniger Zeilen"
              ?disabled=${grid.rows <= GRID_MIN}
              @click=${() => patchGrid({ rows: grid.rows - 1 })}
            >
              −
            </button>
            <b>${grid.rows} Zeilen</b>
            <button
              aria-label="Mehr Zeilen"
              ?disabled=${grid.rows >= GRID_MAX}
              @click=${() => patchGrid({ rows: grid.rows + 1 })}
            >
              +
            </button>
          </div>
        </div>

        <div class="card__actions">
          <button
            ?disabled=${index <= 0}
            @click=${() => this.#reorderScreen(config, index, -1)}
          >
            Nach vorne
          </button>
          <button
            ?disabled=${index < 0 || index >= config.screens.length - 1}
            @click=${() => this.#reorderScreen(config, index, 1)}
          >
            Nach hinten
          </button>
        </div>

        <div class="card__actions">
          <button
            class="danger"
            ?disabled=${config.screens.length <= 1}
            @click=${() => {
              // Zwei Schritte statt eines Systemdialogs: der Knopf sagt beim
              // zweiten Druck selbst, was verloren geht.
              if (this.pendingDelete !== screen.id) {
                this.pendingDelete = screen.id;
                return;
              }
              store.send({ t: 'admin:removeScreen', screenId: screen.id });
              this.pendingDelete = null;
              this.screen = null;
            }}
          >
            ${this.pendingDelete === screen.id
              ? onScreen > 0
                ? `Wirklich loeschen? ${onScreen} Modul${onScreen === 1 ? '' : 'e'} gehen mit`
                : 'Wirklich loeschen?'
              : 'Screen loeschen'}
          </button>
        </div>
      </section>
    `;
  }

  #patchDuration(screen: MirrorScreen, delta: number): void {
    store.send({
      t: 'admin:setScreen',
      screenId: screen.id,
      patch: { durationSeconds: clampScreenDuration(screen.durationSeconds + delta) },
    });
  }

  #reorderScreen(config: MirrorConfig, index: number, delta: number): void {
    const ids = config.screens.map((entry) => entry.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    store.send({ t: 'admin:reorderScreens', ids });
  }

  #currentScreen(): MirrorScreen | null {
    const screens = this.snapshot.config?.screens ?? [];
    return screens.find((entry) => entry.id === this.screen) ?? screens[0] ?? null;
  }

  #selectScreen(id: string): void {
    this.screen = id;
    this.selected = null;
    this.pendingDelete = null;
    // Der Spiegel folgt mit, solange die Vorschau eingeschaltet ist.
    if (this.snapshot.previewScreenId !== null) store.send({ t: 'admin:previewScreen', screenId: id });
  }

  /* --------------------------------- Anzeige --------------------------------- */

  #renderDisplay(): TemplateResult {
    const config = this.snapshot.config;
    if (!config) return html``;
    const display = config.display;
    const power = config.power;
    const night = display.nightMode;

    const patchDisplay = (patch: Partial<typeof display>): void =>
      store.send({ t: 'admin:setSettings', patch: { display: { ...display, ...patch } } });
    const patchPower = (patch: Partial<typeof power>): void =>
      store.send({ t: 'admin:setSettings', patch: { power: { ...power, ...patch } } });

    return html`
      <section class="panel">
        <label class="field">
          <span class="field__label">
            Ausrichtung
            <span class="field__hint">
              ${ROTATION_OPTIONS.find((option) => option.id === display.rotation)?.note ?? ''}
            </span>
          </span>
          <select
            @change=${(event: Event) =>
              patchDisplay({ rotation: normalizeRotation((event.target as HTMLSelectElement).value) })}
          >
            ${ROTATION_OPTIONS.map(
              (option) => html`
                <option value=${option.id} ?selected=${option.id === display.rotation}>${option.name}</option>
              `,
            )}
          </select>
        </label>

        <label class="field">
          <span class="field__label">
            Schriftart
            <span class="field__hint">
              ${FONT_OPTIONS.find((option) => option.id === display.fontFamily)?.note ?? ''}
            </span>
          </span>
          <select
            @change=${(event: Event) =>
              patchDisplay({ fontFamily: (event.target as HTMLSelectElement).value as FontId })}
          >
            ${FONT_OPTIONS.map(
              (option) => html`
                <option value=${option.id} ?selected=${option.id === display.fontFamily}>${option.name}</option>
              `,
            )}
          </select>
        </label>

        <label class="field">
          <span class="field__label">Helligkeit <b>${display.brightness}%</b></span>
          <input
            type="range"
            min="10"
            max="100"
            .value=${String(display.brightness)}
            @change=${(event: Event) => patchDisplay({ brightness: Number((event.target as HTMLInputElement).value) })}
          />
        </label>

        <!--
          Die Nachtabsenkung gab es von Anfang an in der Konfiguration, aber
          nirgends zum Anfassen. Wer nachts vor dem Spiegel stand und sich
          wunderte, wo die Farbe hin ist, hatte keine Stelle, an der das
          dranstand – und keine, an der es sich abschalten liess.
        -->
        <label class="field field--switch">
          <span class="field__label">
            Nachtabsenkung
            <span class="field__hint">
              Nachts eine Stufe dunkler: kein Akzent, keine Flaeche, keine Bewegung – und das Wetter
              schaltet nicht weiter.
            </span>
          </span>
          <input
            type="checkbox"
            .checked=${night.enabled}
            @change=${(event: Event) =>
              patchDisplay({
                nightMode: { ...night, enabled: (event.target as HTMLInputElement).checked },
              })}
          />
        </label>

        ${night.enabled
          ? html`
              <div class="rule">
                <div class="rule__times">
                  <label>
                    von
                    <input
                      type="time"
                      .value=${night.from}
                      @change=${(event: Event) =>
                        patchDisplay({
                          nightMode: { ...night, from: (event.target as HTMLInputElement).value },
                        })}
                    />
                  </label>
                  <label>
                    bis
                    <input
                      type="time"
                      .value=${night.to}
                      @change=${(event: Event) =>
                        patchDisplay({
                          nightMode: { ...night, to: (event.target as HTMLInputElement).value },
                        })}
                    />
                  </label>
                </div>
              </div>
              ${isNightIn(night, config.timezone)
                ? html`<p class="banner banner--hint">
                    Laeuft gerade – der Spiegel ist abgesenkt.
                  </p>`
                : nothing}
            `
          : nothing}

        <label class="field field--switch">
          <span class="field__label">
            Einbrennschutz
            <span class="field__hint">Verschiebt das Layout alle 15 Minuten um wenige Pixel.</span>
          </span>
          <input
            type="checkbox"
            .checked=${display.burnInProtection}
            @change=${(event: Event) =>
              patchDisplay({ burnInProtection: (event.target as HTMLInputElement).checked })}
          />
        </label>
      </section>

      <h2>Bildschirmflaeche</h2>
      <section class="panel">
        <p class="muted small">
          Vier Raender statt einem: der Bildschirm sitzt hinter dem Spiegel selten mittig im Rahmen, und ein
          gleichmaessiger Abstand macht den Inhalt dann nur kleiner statt mittig.
        </p>
        ${this.#renderInsetControls(display.insets)}
        <div class="card__actions">
          <button
            @click=${() =>
              store.send({ t: 'admin:setSettings', patch: { setup: { step: 'frame', completedAt: null } } })}
          >
            Rahmen am Spiegel einblenden
          </button>
        </div>
      </section>

      <h2>Zeitplan</h2>
      <section class="panel">
        <label class="field field--switch">
          <span class="field__label">Zeitplan aktiv</span>
          <input
            type="checkbox"
            .checked=${power.scheduleEnabled}
            @change=${(event: Event) =>
              patchPower({ scheduleEnabled: (event.target as HTMLInputElement).checked })}
          />
        </label>

        ${power.rules.map(
          (rule, index) => html`
            <div class="rule">
              <div class="rule__days">
                ${WEEKDAYS.map(
                  (label, day) => html`
                    <button
                      class=${rule.days.includes(day) ? 'is-active' : ''}
                      @click=${() => {
                        const days = rule.days.includes(day)
                          ? rule.days.filter((entry) => entry !== day)
                          : [...rule.days, day].sort();
                        const rules = [...power.rules];
                        rules[index] = { ...rule, days };
                        patchPower({ rules });
                      }}
                    >
                      ${label}
                    </button>
                  `,
                )}
              </div>
              <div class="rule__times">
                <label>
                  an
                  <input
                    type="time"
                    .value=${rule.on}
                    @change=${(event: Event) => {
                      const rules = [...power.rules];
                      rules[index] = { ...rule, on: (event.target as HTMLInputElement).value };
                      patchPower({ rules });
                    }}
                  />
                </label>
                <label>
                  aus
                  <input
                    type="time"
                    .value=${rule.off}
                    @change=${(event: Event) => {
                      const rules = [...power.rules];
                      rules[index] = { ...rule, off: (event.target as HTMLInputElement).value };
                      patchPower({ rules });
                    }}
                  />
                </label>
              </div>
            </div>
          `,
        )}
        <p class="muted small">
          Ein Schalten von Hand gilt bis zum naechsten Wechsel im Zeitplan und hebt sich danach von selbst auf.
        </p>
      </section>
    `;
  }

  /* ---------------------------------- System --------------------------------- */

  #renderSystem(): TemplateResult {
    const config = this.snapshot.config;
    const update = this.snapshot.update;
    if (!config) return html``;

    const busy = update ? ['checking', 'downloading', 'verifying', 'installing', 'restarting'].includes(update.phase) : false;

    return html`
      <section class="panel">
        <label class="field">
          <span class="field__label">Name des Spiegels</span>
          <input
            type="text"
            .value=${config.deviceName}
            @change=${(event: Event) =>
              store.send({
                t: 'admin:setSettings',
                patch: { deviceName: (event.target as HTMLInputElement).value },
              })}
          />
        </label>
        <label class="field">
          <span class="field__label">Zeitzone</span>
          <input
            type="text"
            .value=${config.timezone}
            @change=${(event: Event) =>
              store.send({
                t: 'admin:setSettings',
                patch: { timezone: (event.target as HTMLInputElement).value },
              })}
          />
        </label>
      </section>

      <h2>Updates</h2>
      <section class="panel">
        <div class="update">
          <div>
            <strong>Version ${update?.currentVersion ?? '–'}</strong>
            <span class="muted small">${this.#updateLabel()}</span>
          </div>
          ${update && typeof update.progress === 'number'
            ? html`<progress max="1" .value=${update.progress}></progress>`
            : nothing}
        </div>

        ${update?.lastError ? html`<p class="banner banner--error">${update.lastError}</p>` : nothing}

        <div class="card__actions">
          <button ?disabled=${busy} @click=${() => store.send({ t: 'admin:checkUpdate' })}>Jetzt pruefen</button>
          <button
            ?disabled=${busy || !update?.availableVersion}
            @click=${() => store.send({ t: 'admin:applyUpdate', version: update?.availableVersion })}
          >
            ${update?.availableVersion ? `Auf ${update.availableVersion} aktualisieren` : 'Aktualisieren'}
          </button>
        </div>

        <label class="field">
          <span class="field__label">
            GitHub-Repository
            <span class="field__hint">Format: benutzer/repository</span>
          </span>
          <input
            type="text"
            placeholder="benutzer/smartmirror"
            .value=${config.update.repository}
            @change=${(event: Event) =>
              store.send({
                t: 'admin:setSettings',
                patch: { update: { ...config.update, repository: (event.target as HTMLInputElement).value } },
              })}
          />
        </label>

        <label class="field field--switch">
          <span class="field__label">Automatisch aktualisieren</span>
          <input
            type="checkbox"
            .checked=${config.update.autoUpdate}
            @change=${(event: Event) =>
              store.send({
                t: 'admin:setSettings',
                patch: { update: { ...config.update, autoUpdate: (event.target as HTMLInputElement).checked } },
              })}
          />
        </label>

        <label class="field">
          <span class="field__label">Kanal</span>
          <select
            @change=${(event: Event) =>
              store.send({
                t: 'admin:setSettings',
                patch: {
                  update: { ...config.update, channel: (event.target as HTMLSelectElement).value as 'stable' | 'beta' },
                },
              })}
          >
            <option value="stable" ?selected=${config.update.channel === 'stable'}>Stabil</option>
            <option value="beta" ?selected=${config.update.channel === 'beta'}>Beta</option>
          </select>
        </label>

        ${update && update.blocked.length > 0
          ? html`<p class="muted small">
              Uebersprungen wegen fehlgeschlagenem Healthcheck: ${update.blocked.join(', ')}
            </p>`
          : nothing}
      </section>

      <h2>Neustart</h2>
      ${this.#renderRestart()}

      <h2>Gekoppelte Geraete</h2>
      ${this.#renderDevices()}
    `;
  }

  /**
   * Zwei Stufen, weil es zwei verschiedene Fehler sind.
   *
   * Haengt die Anzeige – ein Modul, das nicht mehr zeichnet, eine Verbindung,
   * die nicht zurueckkommt –, genuegen die Dienste, und der Spiegel ist nach
   * ein paar Sekunden wieder da. Haengt etwas darunter, hilft nur das ganze
   * Geraet. Die kleinere Stufe zuerst zu zeigen erspart die groessere fast
   * immer; deshalb steht sie oben und traegt den Hauptknopf.
   *
   * Beide fragen nach, bevor sie ausloesen. Nicht weil ein Neustart Schaden
   * anrichtet, sondern weil er dauert: wer im Bad steht und die Uhr ablesen
   * will, hat nicht eine Minute Zeit, sich einen Fehlgriff anzusehen.
   */
  #renderRestart(): TemplateResult {
    const offline = this.snapshot.status !== 'ready';
    return html`
      <section class="panel">
        ${this.#renderBootLookHint()}
        ${this.#renderRestartAction(
          'services',
          'Anzeige neu starten',
          'Startet Core und Anzeige neu. Der Spiegel ist nach ein paar Sekunden wieder da; die Einstellungen bleiben.',
          offline,
        )}
        ${this.#renderRestartAction(
          'device',
          'Spiegel neu starten',
          'Startet das ganze Geraet neu. Dauert etwa eine Minute – der richtige Griff, wenn auch ein Neustart der Anzeige nichts geaendert hat.',
          offline,
        )}
      </section>
    `;
  }

  /**
   * Der einzige Ort, an dem ein ausstehender Neustart sichtbar wird.
   *
   * Wie der Spiegel beim Booten aussieht, steht in /boot und in den Units –
   * ausserhalb des Releases, und wirksam erst beim naechsten Start. Wer nicht
   * ans Terminal kann, saehe sonst nirgends, dass sich etwas geaendert hat und
   * nur noch der Neustart fehlt. Deshalb steht der Hinweis hier: direkt ueber
   * dem Knopf, der ihn erledigt.
   */
  #renderBootLookHint(): TemplateResult | typeof nothing {
    const bootLook = this.snapshot.bootLook;
    if (!bootLook?.pendingReboot) return nothing;
    return html`
      <p class="banner banner--hint">
        Der Startbildschirm wurde eingerichtet${bootLook.plymouth === 'missing'
          ? ' (ohne Wortzeichen – Plymouth fehlt auf diesem Geraet)'
          : nothing}. Sichtbar wird das beim naechsten Neustart des Spiegels.
      </p>
    `;
  }

  #renderRestartAction(
    scope: RestartScope,
    label: string,
    hint: string,
    offline: boolean,
  ): TemplateResult {
    const confirming = this.pendingDelete === `restart:${scope}`;
    return html`
      <div class="field">
        <span class="field__label">
          ${label}
          <span class="field__hint">${hint}</span>
        </span>
        ${confirming
          ? html`
              <div class="card__actions">
                <button @click=${() => (this.pendingDelete = null)}>Abbrechen</button>
                <button
                  class="primary"
                  @click=${() => {
                    this.pendingDelete = null;
                    store.send({ t: 'admin:restart', scope });
                    // Die Bestaetigung muss von hier kommen: gleich darauf
                    // reisst die Verbindung ab, und der Spiegel kann nichts
                    // mehr zuruecksagen. Ohne sie saehe der Knopfdruck aus
                    // wie einer, der ins Leere ging – und der naechste Toast
                    // meldet nur noch "nicht erreichbar".
                    this.#toast(
                      scope === 'device' ? 'Spiegel startet neu …' : 'Anzeige startet neu …',
                    );
                  }}
                >
                  Jetzt neu starten
                </button>
              </div>
            `
          : html`
              <div class="card__actions">
                <button
                  ?disabled=${offline}
                  aria-label=${label}
                  @click=${() => (this.pendingDelete = `restart:${scope}`)}
                >
                  Neu starten
                </button>
              </div>
            `}
      </div>
    `;
  }

  /**
   * Alle Geraete, die den Spiegel bedienen duerfen.
   *
   * Der Spiegel gehoert selten einem allein: im Haushalt hat jeder ein Handy,
   * und auf dem iPhone zaehlen Safari und die App zum Startbildschirm getrennt.
   * Deshalb eine Liste statt einer einzigen Kopplung – mit Namen, damit man
   * beim Entziehen weiss, welches man trifft.
   */
  #renderDevices(): TemplateResult {
    const { devices, deviceId, pairing } = this.snapshot;

    return html`
      <section class="panel">
        ${devices.length === 0
          ? html`<p class="muted small">Noch kein Geraet gekoppelt.</p>`
          : html`
              <ul class="devices">
                ${devices.map((device) => this.#renderDevice(device, device.id === deviceId))}
              </ul>
            `}

        ${pairing.open
          ? html`
              <p class="muted small">
                Auf dem Spiegel steht ein Kopplungscode${pairing.expiresAt
                  ? html` bis ${formatTime(pairing.expiresAt)}`
                  : nothing}. Ihn am neuen Geraet eingeben.
              </p>
              <div class="card__actions">
                <button @click=${() => store.cancelPairing()}>Code wieder ausblenden</button>
              </div>
            `
          : html`
              <div class="card__actions">
                <button class="primary" @click=${() => store.requestPairing()}>Weiteres Geraet koppeln</button>
              </div>
            `}
      </section>
    `;
  }

  #renderDevice(device: PairedDevice, isSelf: boolean): TemplateResult {
    const confirming = this.pendingDelete === `device:${device.id}`;
    return html`
      <li class="device ${device.online ? 'is-online' : ''}">
        <div class="device__head">
          <input
            class="device__name"
            .value=${device.name}
            maxlength="64"
            aria-label="Name des Geraets"
            @change=${(event: Event) => {
              const name = (event.target as HTMLInputElement).value.trim();
              if (!name || name === device.name) return;
              store.send({ t: 'admin:renameDevice', deviceId: device.id, name });
            }}
          />
        </div>
        <p class="muted small">
          ${isSelf ? html`<span class="device__tag">dieses Geraet</span>` : nothing}
          ${device.online ? 'gerade verbunden' : `zuletzt ${formatMoment(device.lastSeen)}`} · gekoppelt
          ${formatMoment(device.pairedAt)}
        </p>
        ${confirming
          ? html`
              <p class="muted small">
                ${isSelf
                  ? 'Danach braucht dieses Geraet wieder einen Code vom Spiegel.'
                  : 'Das Geraet kann den Spiegel danach nicht mehr bedienen.'}
              </p>
              <div class="card__actions">
                <button @click=${() => (this.pendingDelete = null)}>Abbrechen</button>
                <button
                  class="danger"
                  @click=${() => {
                    this.pendingDelete = null;
                    // Das eigene Geraet raeumt zusaetzlich sein Token weg und
                    // startet die App neu – sonst bliebe eine Oberflaeche
                    // stehen, die nichts mehr darf.
                    if (isSelf) store.forgetToken();
                    else store.send({ t: 'admin:revokeDevice', deviceId: device.id });
                  }}
                >
                  Entkoppeln
                </button>
              </div>
            `
          : html`
              <div class="card__actions">
                <button class="danger" @click=${() => (this.pendingDelete = `device:${device.id}`)}>
                  Entkoppeln
                </button>
              </div>
            `}
      </li>
    `;
  }

  #updateLabel(): string {
    const update = this.snapshot.update;
    if (!update) return 'Kein Update-Dienst erreichbar';
    switch (update.phase) {
      case 'checking':
        return 'suche nach Updates …';
      case 'downloading':
        return `lade ${update.availableVersion ?? ''} …`;
      case 'verifying':
        return 'pruefe Signatur …';
      case 'installing':
        return 'installiere …';
      case 'restarting':
        return 'starte neu …';
      case 'rolled-back':
        return 'Update zurueckgerollt';
      case 'error':
        return 'Fehler beim Update';
      default:
        return update.availableVersion
          ? `Version ${update.availableVersion} verfuegbar`
          : update.lastCheck
            ? `aktuell · geprueft ${new Date(update.lastCheck).toLocaleTimeString('de-DE')}`
            : 'noch nicht geprueft';
    }
  }
}

customElements.define('mirror-remote', MirrorRemote);
