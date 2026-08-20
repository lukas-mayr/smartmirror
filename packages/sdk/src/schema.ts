/**
 * Bewusst kleiner JSON-Schema-Ausschnitt.
 *
 * Er reicht aus, um Modul-Einstellungen zu beschreiben, und ist klein genug,
 * dass die Remote-PWA daraus zuverlaessig ein Formular generieren kann. Ein
 * Modul, das hier nicht abbildbar ist, ist fast immer ein Modul mit zu
 * komplizierten Einstellungen.
 */
export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface JsonSchema {
  type: SchemaType;
  title?: string;
  description?: string;
  default?: unknown;

  /** string */
  enum?: readonly (string | number)[];
  /** Anzeigetexte zu `enum`, gleiche Reihenfolge. */
  enumLabels?: readonly string[];
  format?: 'time' | 'date' | 'uri' | 'color' | 'timezone';
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  /** number | integer */
  minimum?: number;
  maximum?: number;
  step?: number;

  /** array */
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;

  /** object */
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T = Record<string, unknown>> {
  valid: boolean;
  /** Eingabe, ergaenzt um Defaults und auf den Schematyp gebracht. */
  value: T;
  issues: ValidationIssue[];
}

/**
 * Validiert und normalisiert einen Wert gegen ein Schema.
 *
 * Normalisieren heisst: fehlende Felder mit `default` fuellen, Zahlen aus
 * Formular-Strings parsen und auf `minimum`/`maximum` begrenzen. Dadurch kann
 * die Remote-Oberflaeche einfache HTML-Inputs schicken, ohne selbst zu casten.
 */
export function validate(schema: JsonSchema, input: unknown, path = ''): ValidationResult<any> {
  const issues: ValidationIssue[] = [];
  const at = (child: string) => (path ? `${path}.${child}` : child);
  const fail = (message: string) => issues.push({ path: path || '(root)', message });

  let value: unknown = input;
  if (value === undefined || value === null || value === '') {
    if (schema.default !== undefined) {
      value = structuredClone(schema.default);
    } else if (schema.type === 'object') {
      value = {};
    } else if (schema.type === 'array') {
      value = [];
    } else {
      return { valid: true, value: undefined, issues };
    }
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') value = String(value);
      const str = value as string;
      if (schema.enum && !schema.enum.includes(str)) {
        fail(`"${str}" ist keine erlaubte Auswahl (${schema.enum.join(', ')})`);
      }
      if (schema.minLength !== undefined && str.length < schema.minLength) {
        fail(`mindestens ${schema.minLength} Zeichen erwartet`);
      }
      if (schema.maxLength !== undefined && str.length > schema.maxLength) {
        fail(`hoechstens ${schema.maxLength} Zeichen erlaubt`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(str)) {
        fail(`entspricht nicht dem erwarteten Format`);
      }
      break;
    }
    case 'number':
    case 'integer': {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) {
        fail(`Zahl erwartet, "${String(value)}" erhalten`);
        break;
      }
      let normalized = schema.type === 'integer' ? Math.round(num) : num;
      if (schema.minimum !== undefined && normalized < schema.minimum) normalized = schema.minimum;
      if (schema.maximum !== undefined && normalized > schema.maximum) normalized = schema.maximum;
      value = normalized;
      break;
    }
    case 'boolean': {
      value = value === true || value === 'true' || value === 1 || value === '1';
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        fail('Liste erwartet');
        value = [];
        break;
      }
      if (schema.items) {
        const out: unknown[] = [];
        (value as unknown[]).forEach((entry, index) => {
          const child = validate(schema.items as JsonSchema, entry, at(String(index)));
          issues.push(...child.issues);
          out.push(child.value);
        });
        value = out;
      }
      if (schema.minItems !== undefined && (value as unknown[]).length < schema.minItems) {
        fail(`mindestens ${schema.minItems} Eintraege erwartet`);
      }
      if (schema.maxItems !== undefined && (value as unknown[]).length > schema.maxItems) {
        fail(`hoechstens ${schema.maxItems} Eintraege erlaubt`);
      }
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('Objekt erwartet');
        value = {};
      }
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
        const child = validate(childSchema, source[key], at(key));
        issues.push(...child.issues);
        if (child.value !== undefined) out[key] = child.value;
        else if (schema.required?.includes(key)) {
          issues.push({ path: at(key), message: 'Pflichtfeld fehlt' });
        }
      }
      // Unbekannte Schluessel werden verworfen, nicht durchgereicht: sonst
      // sammelt die Config ueber Versionswechsel hinweg Altlasten an.
      value = out;
      break;
    }
  }

  return { valid: issues.length === 0, value, issues };
}

/** Baut das Default-Objekt eines Schemas, ohne dass eine Eingabe vorliegt. */
export function defaultsOf(schema: JsonSchema): Record<string, unknown> {
  return validate(schema, undefined).value ?? {};
}
