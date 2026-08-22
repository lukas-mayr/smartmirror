import { LitElement, html, nothing, type TemplateResult } from 'lit';
import type { JsonSchema } from '@mirror/sdk';

/**
 * Baut ein Einstellungsformular aus dem configSchema eines Moduls.
 *
 * Das ist der Grund, warum ein neues Modul keine eigene Oberflaeche in der
 * Handy-App braucht: es beschreibt seine Einstellungen im Manifest, und das
 * Formular entsteht daraus.
 */
export class SchemaForm extends LitElement {
  static override properties = {
    schema: { type: Object },
    value: { type: Object },
  };

  declare schema: JsonSchema | undefined;
  declare value: Record<string, unknown>;

  constructor() {
    super();
    this.value = {};
  }

  // Kein Shadow DOM: die App hat ein gemeinsames Stylesheet, und Formulare
  // sollen daraus erben statt ihre Stile zu duplizieren.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override render(): TemplateResult | typeof nothing {
    const properties = this.schema?.properties;
    if (!properties || Object.keys(properties).length === 0) {
      return html`<p class="muted">Dieses Modul hat keine Einstellungen.</p>`;
    }
    return html`
      <div class="form">
        ${Object.entries(properties).map(([key, schema]) => this.#field(key, schema))}
      </div>
    `;
  }

  #emit(key: string, next: unknown): void {
    this.value = { ...this.value, [key]: next };
    this.dispatchEvent(new CustomEvent('form-change', { detail: this.value, bubbles: true, composed: true }));
    this.requestUpdate();
  }

  #field(key: string, schema: JsonSchema): TemplateResult {
    const current = this.value[key] ?? schema.default;
    const label = schema.title ?? key;
    const hint = schema.description ? html`<span class="field__hint">${schema.description}</span>` : nothing;

    if (schema.type === 'boolean') {
      return html`
        <label class="field field--switch">
          <span class="field__label">${label}${hint}</span>
          <input
            type="checkbox"
            .checked=${current === true}
            @change=${(event: Event) => this.#emit(key, (event.target as HTMLInputElement).checked)}
          />
        </label>
      `;
    }

    if (schema.enum) {
      return html`
        <label class="field">
          <span class="field__label">${label}${hint}</span>
          <select @change=${(event: Event) => this.#emit(key, (event.target as HTMLSelectElement).value)}>
            ${schema.enum.map(
              (option, index) => html`
                <option value=${String(option)} ?selected=${String(current) === String(option)}>
                  ${schema.enumLabels?.[index] ?? String(option)}
                </option>
              `,
            )}
          </select>
        </label>
      `;
    }

    if (schema.type === 'number' || schema.type === 'integer') {
      const hasRange = schema.minimum !== undefined && schema.maximum !== undefined;
      return html`
        <label class="field">
          <span class="field__label">
            ${label} ${hasRange ? html`<b>${String(current ?? '')}</b>` : nothing}${hint}
          </span>
          <input
            type=${hasRange ? 'range' : 'number'}
            .value=${String(current ?? '')}
            min=${schema.minimum ?? nothing}
            max=${schema.maximum ?? nothing}
            step=${schema.step ?? (schema.type === 'integer' ? 1 : 'any')}
            @input=${(event: Event) => this.#emit(key, Number((event.target as HTMLInputElement).value))}
          />
        </label>
      `;
    }

    /*
     * Mehrere Zeilen brauchen ein mehrzeiliges Feld. In einer einzeiligen
     * Eingabe tippt man ab dem zweiten Satz blind, und genau das ist die
     * Form, in der Mitteilungen eingetragen werden.
     */
    if (schema.format === 'textarea') {
      return html`
        <label class="field">
          <span class="field__label">${label}${hint}</span>
          <textarea
            rows="4"
            .value=${String(current ?? '')}
            maxlength=${schema.maxLength ?? nothing}
            @change=${(event: Event) => this.#emit(key, (event.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
      `;
    }

    return html`
      <label class="field">
        <span class="field__label">${label}${hint}</span>
        <input
          type=${schema.format === 'time' ? 'time' : 'text'}
          .value=${String(current ?? '')}
          minlength=${schema.minLength ?? nothing}
          maxlength=${schema.maxLength ?? nothing}
          @change=${(event: Event) => this.#emit(key, (event.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }
}

customElements.define('schema-form', SchemaForm);
