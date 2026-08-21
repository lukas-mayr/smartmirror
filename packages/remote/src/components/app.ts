import { LitElement, html, nothing, type TemplateResult } from 'lit';
import {
  FONT_OPTIONS,
  normalizeRotation,
  ROTATION_OPTIONS,
  ZONE_LABELS,
  ZONES,
  type FontId,
  type ModuleDescriptor,
  type ModuleInstance,
  type Zone,
} from '@mirror/sdk';
import { store, type StoreSnapshot } from '../store.js';
import './schema-form.js';

type Tab = 'module' | 'anzeige' | 'system';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

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
    const { status } = this.snapshot;
    if (status === 'pairing') return this.#renderPairing();
    if (!this.snapshot.config) return this.#renderLoading();

    return html`
      <header class="topbar">
        <div>
          <h1>${this.snapshot.config.deviceName}</h1>
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

  /* --------------------------------- Kopplung -------------------------------- */

  #renderPairing(): TemplateResult {
    return html`
      <div class="pairing">
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
      </div>
    `;
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

        <label class="field">
          <span class="field__label">
            Randabstand <b>${display.paddingPercent}%</b>
            <span class="field__hint">Der Spiegelrahmen verdeckt die aeussersten Pixel.</span>
          </span>
          <input
            type="range"
            min="0"
            max="15"
            .value=${String(display.paddingPercent)}
            @change=${(event: Event) =>
              patchDisplay({ paddingPercent: Number((event.target as HTMLInputElement).value) })}
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
