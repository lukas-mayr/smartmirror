import type { JsonSchema } from './schema.js';
import type { Duration } from './duration.js';
import { isWidgetSize, WIDGET_SIZES, type WidgetSize } from './layout.js';

/**
 * Rechte, die ein Modul im Manifest anfordern muss. Was nicht angefordert
 * wurde, ist im Backend-Kontext schlicht nicht vorhanden bzw. wirft.
 *
 * Eine Liste und keine Aufzaehlung von Typen, weil die Pruefung beim Laden
 * dieselbe Quelle braucht: stuende die erlaubte Menge zweimal da — einmal als
 * Typ und einmal als Bedingung im Validator —, dann faellt beim naechsten
 * neuen Recht die zweite Stelle durch, und zwar nicht beim Uebersetzen,
 * sondern erst auf dem Spiegel.
 */
export const MODULE_PERMISSIONS = [
  /** Darf `ctx.fetch` nutzen – begrenzt auf die Hosts in `network.allow`. */
  'network',
  /** Darf `ctx.secret(...)` lesen. */
  'secrets',
  /** Darf Kommandos von der Fernbedienung empfangen. */
  'commands',
  /**
   * Darf mit `ctx.notify(...)` in den Mitteilungsfeed melden.
   *
   * Getrennt vom Lesen, weil es zwei verschiedene Rollen sind: fast jedes
   * Modul hat gelegentlich etwas zu melden, aber den gesammelten Strom aller
   * Quellen soll nur bekommen, wer ihn anzeigt.
   */
  'notify',
  /** Darf mit `ctx.onNotifications(...)` den gesammelten Feed hoeren. */
  'notifications',
] as const;

export type ModulePermission = (typeof MODULE_PERMISSIONS)[number];

export interface ModuleSecretDeclaration {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  /**
   * Das Modul schreibt dieses Geheimnis selbst und der Nutzer soll es nie
   * eintippen – etwa ein Token, den eine Anmeldung eingebracht hat. Die
   * Handy-App zeigt dafuer kein Feld an.
   */
  managed?: boolean;
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
   *
   * `allowFromConfig` nennt Konfigurationsfelder, in denen der Nutzer selbst
   * Adressen eintraegt: deren Hosts sind zusaetzlich erlaubt. Gebraucht von
   * Modulen, deren Quelle niemand vorher kennen kann — ein Kalendermodul
   * bekommt eine Adresse bei iCloud, eine bei der Gemeinde und eine beim
   * Sportverein, und keine davon liesse sich im Manifest auffuehren.
   *
   * Das Prinzip bleibt gewahrt: freigeschaltet wird nur, was jemand am Handy
   * eingetippt hat. Das Modul kann die Liste nicht selbst fuellen — die
   * Konfiguration gehoert dem Nutzer, nicht dem Modul.
   */
  network?: { allow: readonly string[]; allowFromConfig?: readonly string[] };

  /** Beschreibt die Einstellungen. Die Remote-PWA baut daraus das Formular. */
  configSchema?: JsonSchema;
  /** Geheimnisse (API-Keys), die verschluesselt abgelegt werden. */
  secrets?: readonly ModuleSecretDeclaration[];

  /** Wenn true, ist nur eine Instanz erlaubt. */
  singleton?: boolean;
  /**
   * Blockgroessen, in denen es das Modul gibt. Fehlt die Angabe, sind es alle.
   *
   * Eine Groesse ist keine Einstellung, sondern eine Aussage ueber den Inhalt:
   * eine Wochenvorhersage braucht Platz fuer sieben Spalten, eine Uhrzeit
   * kommt mit einem Feld aus. Was inhaltlich nicht aufgeht, soll am Handy
   * erst gar nicht auswaehlbar sein – besser als ein Block, in dem das halbe
   * Modul abgeschnitten ist.
   */
  sizes?: readonly WidgetSize[];
  /**
   * Blockgroesse, mit der das Modul hinzugefuegt wird. Muss in `sizes` stehen.
   *
   * Ein Vorschlag und keine Vorgabe: welche Groesse passt, weiss das Modul
   * besser als der Nutzer, aber wohin der Block gehoert, weiss nur der Nutzer.
   */
  preferredSize?: WidgetSize;
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
  /** Immer gefuellt und in kanonischer Reihenfolge, auch ohne Angabe im Manifest. */
  sizes: readonly WidgetSize[];
  /** Immer eine Groesse aus `sizes`. */
  preferredSize: WidgetSize;
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
  const sizes: unknown = m.sizes;
  if (sizes !== undefined) {
    if (!Array.isArray(sizes) || sizes.length === 0) {
      fail('"sizes" muss eine nicht leere Liste von Blockgroessen sein');
    }
    for (const size of sizes) {
      if (!isWidgetSize(size)) {
        fail(`unbekannte Blockgroesse "${String(size)}" (erlaubt: ${WIDGET_SIZES.join(', ')})`);
      }
    }
  }
  if (m.preferredSize !== undefined) {
    if (!isWidgetSize(m.preferredSize)) {
      fail(`"preferredSize" ist keine Blockgroesse (erhalten: ${JSON.stringify(m.preferredSize)})`);
    }
    // Ein Modul, das sich selbst in einer Groesse vorschlaegt, die es nicht
    // anbietet, ist ein Fehler im Manifest und keine Auslegungsfrage.
    if (Array.isArray(sizes) && !sizes.includes(m.preferredSize)) {
      fail(`"preferredSize" (${m.preferredSize}) steht nicht in "sizes"`);
    }
  }

  const permissions: unknown = m.permissions;
  if (permissions !== undefined) {
    if (!Array.isArray(permissions)) fail('"permissions" muss eine Liste sein');
    for (const p of permissions) {
      if (!(MODULE_PERMISSIONS as readonly unknown[]).includes(p)) {
        fail(`unbekannte Permission "${String(p)}"`);
      }
    }
    if (permissions.includes('network')) {
      const net = m.network as { allow?: unknown; allowFromConfig?: unknown } | undefined;
      const allow = Array.isArray(net?.allow) ? net.allow : [];
      const fromConfig = Array.isArray(net?.allowFromConfig) ? net.allowFromConfig : [];
      // Eine der beiden Quellen muss etwas hergeben. Ein Modul, dessen Adressen
      // erst der Nutzer eintraegt, hat eine leere feste Liste – aber es hat
      // benannt, aus welchem Feld die Freigabe kommt, und das ist die Angabe,
      // um die es hier geht.
      if (allow.length === 0 && fromConfig.length === 0) {
        fail(
          'Permission "network" ohne "network.allow" und ohne "network.allowFromConfig" –' +
            ' eine der beiden Quellen fuer die Host-Allowlist ist Pflicht',
        );
      }
    }
  }
}

/** Prueft, ob ein Host von der Allowlist des Manifests abgedeckt ist. */
/**
 * Hosts, die der Nutzer selbst eingetragen hat.
 *
 * Gelesen wird nur aus den Feldern, die das Manifest in `allowFromConfig`
 * nennt, und daraus nur, was tatsaechlich wie eine Adresse aussieht. Ein
 * mehrzeiliges Feld darf dabei mehrere enthalten – so tippt man Kalender ein.
 *
 * `webcal://` zaehlt mit: iCloud und Google geben einen Kalender genau so
 * heraus, das Kalendermodul macht daraus vor dem Laden ein `https://`, und
 * ohne diese Zeile stuende der Host trotzdem nicht auf der Allowlist – der
 * eingetragene Kalender bliebe stumm, obwohl er richtig eingetragen ist.
 */
export function hostsFromConfig(
  manifest: ModuleManifest,
  config: Readonly<Record<string, unknown>>,
): string[] {
  const fields = manifest.network?.allowFromConfig ?? [];
  const hosts: string[] = [];
  for (const field of fields) {
    const value = config[field];
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/(?:https?|webcal):\/\/([^\s/|"']+)/gi)) {
      const host = match[1]?.toLowerCase();
      if (host) hosts.push(host.split('@').pop() as string);
    }
  }
  return hosts;
}

export function hostAllowed(
  manifest: ModuleManifest,
  hostname: string,
  config: Readonly<Record<string, unknown>> = {},
): boolean {
  const allow = [...(manifest.network?.allow ?? []), ...hostsFromConfig(manifest, config)];
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
