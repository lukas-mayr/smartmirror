import type { JsonSchema } from './schema.js';
import type { Duration } from './duration.js';

/**
 * Rechte, die ein Modul im Manifest anfordern muss. Was nicht angefordert
 * wurde, ist im Backend-Kontext schlicht nicht vorhanden bzw. wirft.
 */
export type ModulePermission =
  /** Darf `ctx.fetch` nutzen – begrenzt auf die Hosts in `network.allow`. */
  | 'network'
  /** Darf `ctx.secret(...)` lesen. */
  | 'secrets'
  /** Darf Kommandos von der Fernbedienung empfangen. */
  | 'commands';

export interface ModuleSecretDeclaration {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
}

export interface ModuleManifest {
  /** Eindeutig, kebab-case. Entspricht dem Ordnernamen unter `modules/`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;

  permissions?: readonly ModulePermission[];
  /**
   * Host-Allowlist fuer `ctx.fetch`. Eintraege sind Hostnamen, optional mit
   * fuehrendem "*." fuer Subdomains. Ohne Eintrag ist `network` wirkungslos –
   * ein Modul kann sich also nicht selbst freischalten, indem es nur die
   * Permission setzt.
   */
  network?: { allow: readonly string[] };

  /** Beschreibt die Einstellungen. Die Remote-PWA baut daraus das Formular. */
  configSchema?: JsonSchema;
  /** Geheimnisse (API-Keys), die verschluesselt abgelegt werden. */
  secrets?: readonly ModuleSecretDeclaration[];

  /** Wenn true, ist nur eine Instanz erlaubt. */
  singleton?: boolean;
  /** Vorschlag fuer die Zone bei der ersten Platzierung. */
  preferredZone?: string;
  /** Rein informativ fuer die Oberflaeche. */
  refreshInterval?: Duration;
}

/** Was der Server der Oberflaeche ueber ein verfuegbares Modul mitteilt. */
export interface ModuleDescriptor {
  id: string;
  name: string;
  version: string;
  description?: string;
  singleton: boolean;
  preferredZone?: string;
  configSchema?: JsonSchema;
  secrets: readonly ModuleSecretDeclaration[];
  /** Welche der deklarierten Geheimnisse bereits hinterlegt sind. */
  secretsPresent: readonly string[];
  /** Fehler beim Laden – Modul ist dann nicht instanziierbar. */
  loadError?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * Prueft ein Manifest beim Laden. Ein kaputtes Manifest darf den Spiegel nicht
 * anhalten – der Modul-Host faengt den Fehler und markiert nur dieses Modul
 * als nicht ladbar.
 */
export function assertValidManifest(input: unknown, source: string): asserts input is ModuleManifest {
  // Explizite Typannotation, damit TypeScript den never-Rueckgabetyp fuer die
  // Kontrollfluss-Analyse beruecksichtigt und danach korrekt einengt.
  const fail: (message: string) => never = (message) => {
    throw new Error(`Ungueltiges Manifest in ${source}: ${message}`);
  };
  if (typeof input !== 'object' || input === null) fail('kein Objekt');
  const m = input as Record<string, unknown>;

  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
    fail(`"id" fehlt oder ist kein kebab-case-Bezeichner (erhalten: ${JSON.stringify(m.id)})`);
  }
  if (typeof m.name !== 'string' || m.name.length === 0) fail('"name" fehlt');
  if (typeof m.version !== 'string' || !SEMVER_PATTERN.test(m.version)) {
    fail(`"version" fehlt oder ist kein Semver (erhalten: ${JSON.stringify(m.version)})`);
  }
  const permissions: unknown = m.permissions;
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) fail('"permissions" muss eine Liste sein');
    for (const p of permissions) {
      if (p !== 'network' && p !== 'secrets' && p !== 'commands') {
        fail(`unbekannte Permission "${String(p)}"`);
      }
    }
    if (permissions.includes('network')) {
      const allow = (m.network as { allow?: unknown } | undefined)?.allow;
      if (!Array.isArray(allow) || allow.length === 0) {
        fail('Permission "network" ohne "network.allow" – die Host-Allowlist ist Pflicht');
      }
    }
  }
}

/** Prueft, ob ein Host von der Allowlist des Manifests abgedeckt ist. */
export function hostAllowed(manifest: ModuleManifest, hostname: string): boolean {
  const allow = manifest.network?.allow ?? [];
  const host = hostname.toLowerCase();
  return allow.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}
