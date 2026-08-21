import { LitElement, html, nothing, type TemplateResult } from 'lit';
import {
  adjustAllInsets,
  adjustInset,
  createDefaultInsets,
  FONT_OPTIONS,
  INSET_MAX,
  INSET_MIN,
  INSET_SIDE_OPTIONS,
  INSET_STEP,
  insetsEqual,
  insetToPixels,
  normalizeRotation,
  ROTATION_OPTIONS,
  SETUP_FLOW_STEPS,
  SETUP_STEP_TITLES,
  setupStepNumber,
  ZONE_LABELS,
  ZONES,
  type FontId,
  type InsetSide,
  type ModuleDescriptor,
  type ModuleInstance,
  type ScreenInsets,
  type SetupStep,
  type Zone,
} from '@mirror/sdk';
import { store, type StoreSnapshot } from '../store.js';
import './schema-form.js';

type Tab = 'module' | 'anzeige' | 'system';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** Seitenverhaeltnis der Vorschau, solange die Anzeige noch nichts gemeldet hat. */
const FALLBACK_ASPECT = 16 / 9;

const formatPercent = (value: number): string => value.toFixed(1).replace('.', ',').replace(',0', '');

export class MirrorRemote extends LitElement {
  static override properties = {
    snapshot: { state: true },
    tab: { state: true },
    expanded: { state: true },
    code: { state: true },
  };

  declare snapshot: StoreSnapshot;
  declare tab: Tab;
  declare expanded: string | null;
  declare code: string;

  constructor() {
    super();
    this.snapshot = store.value;
    this.tab = 'module';
    this.expanded = null;
    this.code = '';
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    store.addEventListener('change', this.#onChange);
  }

  override disconnectedCallback(): void {
    store.removeEventListener('change', this.#onChange);
    super.disconnectedCallback();
  }

  #onChange = (): void => {
    this.snapshot = store.value;
  };

  protected override render(): TemplateResult {
    const { status, config } = this.snapshot;
    // Die Einrichtung ist kein Reiter neben den anderen: solange sie laeuft,
    // ist sie die ganze App. Wer beim Ausrichten zwischen Modulen und Rahmen
    // hin- und herspringen kann, richtet nicht aus.
    if (status === 'pairing') return this.#renderSetup('pair');
    if (!config) return this.#renderLoading();
    if (config.setup.step !== 'done') return this.#renderSetup(config.setup.step);

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
            <button class=${this.tab === tab ? 'is-active' : ''} @click=${() => (this.tab = tab)}>
              ${tab === 'module' ? 'Module' : tab === 'anzeige' ? 'Anzeige' : 'System'}
            </button>
          `,
        )}
      </nav>

      ${this.snapshot.lastError ? html`<p class="banner banner--error">${this.snapshot.lastError}</p>` : nothing}

      <main>
        ${this.tab === 'module'
          ? this.#renderModules()
          : this.tab === 'anzeige'
            ? this.#renderDisplay()
            : this.#renderSystem()}
      </main>
    `;
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
        <input
          class="pairing__input"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="6"
          placeholder="000000"
          .value=${this.code}
          @input=${(event: Event) => {
            this.code = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
            if (this.code.length === 6) store.pair(this.code);
          }}
        />
        ${this.snapshot.lastError ? html`<p class="banner banner--error">${this.snapshot.lastError}</p>` : nothing}
        <p class="muted small">
          Der Code wird nur angezeigt, wenn ein ungekoppeltes Geraet verbunden ist, und laeuft nach fuenf Minuten ab.
        </p>
      </section>
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

  #renderModules(): TemplateResult {
    const config = this.snapshot.config;
    if (!config) return html``;
    const byId = new Map(this.snapshot.modules.map((entry) => [entry.id, entry]));
    const instances = [...config.instances].sort(
      (a, b) => ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone) || a.order - b.order,
    );

    return html`
      <section class="cards">
        ${instances.map((instance) => this.#renderInstance(instance, byId.get(instance.moduleId)))}
      </section>

      <h2>Modul hinzufuegen</h2>
      <section class="cards">
        ${this.snapshot.modules.map(
          (descriptor) => html`
            <div class="card card--add">
              <div>
                <strong>${descriptor.name}</strong>
                <span class="muted small">v${descriptor.version} · ${descriptor.description ?? ''}</span>
                ${descriptor.loadError
                  ? html`<span class="banner banner--error small">${descriptor.loadError}</span>`
                  : nothing}
              </div>
              <button
                ?disabled=${Boolean(descriptor.loadError) ||
                (descriptor.singleton && instances.some((i) => i.moduleId === descriptor.id))}
                @click=${() =>
                  store.send({
                    t: 'admin:addInstance',
                    moduleId: descriptor.id,
                    zone: descriptor.preferredZone ?? 'top-center',
                  })}
              >
                Hinzufuegen
              </button>
            </div>
          `,
        )}
      </section>
    `;
  }

  #renderInstance(instance: ModuleInstance, descriptor: ModuleDescriptor | undefined): TemplateResult {
    const open = this.expanded === instance.id;
    const envelope = this.snapshot.state[instance.id];

    return html`
      <div class="card ${instance.enabled ? '' : 'card--off'}">
        <div class="card__head" @click=${() => (this.expanded = open ? null : instance.id)}>
          <div>
            <strong>${descriptor?.name ?? instance.moduleId}</strong>
            <span class="muted small">${ZONE_LABELS[instance.zone]}</span>
            ${envelope?.error ? html`<span class="dot dot--error" title=${envelope.error}></span>` : nothing}
          </div>
          <label class="switch" @click=${(event: Event) => event.stopPropagation()}>
            <input
              type="checkbox"
              .checked=${instance.enabled}
              @change=${(event: Event) =>
                store.send({
                  t: 'admin:setLayout',
                  instances: [
                    {
                      id: instance.id,
                      zone: instance.zone,
                      order: instance.order,
                      enabled: (event.target as HTMLInputElement).checked,
                    },
                  ],
                })}
            />
            <span></span>
          </label>
        </div>

        ${open
          ? html`
              <div class="card__body">
                ${envelope?.error ? html`<p class="banner banner--error">${envelope.error}</p>` : nothing}

                <label class="field">
                  <span class="field__label">Position</span>
                  <select
                    @change=${(event: Event) =>
                      store.send({
                        t: 'admin:setLayout',
                        instances: [
                          {
                            id: instance.id,
                            zone: (event.target as HTMLSelectElement).value as Zone,
                            order: instance.order,
                            enabled: instance.enabled,
                          },
                        ],
                      })}
                  >
                    ${ZONES.map(
                      (zone) => html`
                        <option value=${zone} ?selected=${zone === instance.zone}>${ZONE_LABELS[zone]}</option>
                      `,
                    )}
                  </select>
                </label>

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

                ${(descriptor?.secrets ?? []).map(
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
                    </label>
                  `,
                )}

                <div class="card__actions">
                  <button
                    class="danger"
                    @click=${() => store.send({ t: 'admin:removeInstance', instanceId: instance.id })}
                  >
                    Entfernen
                  </button>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  /* --------------------------------- Anzeige --------------------------------- */

  #renderDisplay(): TemplateResult {
    const config = this.snapshot.config;
    if (!config) return html``;
    const display = config.display;
    const power = config.power;

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

      <h2>Dieses Geraet</h2>
      <section class="panel">
        <p class="muted small">
          Die Kopplung liegt nur auf diesem Handy. Loeschen bedeutet, den Code am Spiegel erneut einzugeben.
        </p>
        <div class="card__actions">
          <button class="danger" @click=${() => store.forgetToken()}>Kopplung auf diesem Geraet loeschen</button>
        </div>
      </section>
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
