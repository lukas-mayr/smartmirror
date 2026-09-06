/**
 * WLAN des Spiegels.
 *
 * Der Spiegel haengt an der Wand und hat weder Tastatur noch Knopf. Faellt das
 * WLAN aus der Konfiguration – ein zurueckgesetzter Router, ein neues Passwort,
 * ein frisch aufgesetztes Image –, war die einzige Rettung bisher ein Kabel
 * oder eine Tastatur am Pi. Beides hat, wer einen Spiegel aufhaengt, selten
 * hinter dem Spiegel.
 *
 * Deshalb zwei Wege hinein, und der zweite ist der eigentliche Grund fuer
 * diese Datei:
 *
 *  1. Die Handy-App zeigt die Netze in Reichweite und nimmt das Passwort
 *     entgegen – erreichbar, solange der Spiegel ueberhaupt am Netz haengt,
 *     also auch ueber Kabel.
 *  2. Hat er gar keine Verbindung, macht er selbst ein WLAN auf. Das Handy
 *     verbindet sich damit, bekommt dieselbe App und traegt dort das Heimnetz
 *     ein. Die Zugangsdaten dafuer stehen auf dem Spiegel – dieselbe Huerde wie
 *     beim Kopplungscode: wer einrichten will, steht davor.
 *
 * Ausgefuehrt wird nichts davon vom Core. Er laeuft unprivilegiert und schreibt
 * nur eine Auftragsdatei; gelesen wird sie von deploy/mirror-wifi.sh als root.
 * Dieselbe Bruecke wie beim Neustart und beim Updater, aus demselben Grund.
 */

/**
 * Zustand der Funkstrecke.
 *
 * `unavailable` heisst nicht "aus", sondern "hier gibt es nichts zu steuern":
 * kein NetworkManager, kein Funkgeraet – etwa in der Entwicklung auf einem
 * Rechner, der sein WLAN selbst verwaltet. Die App zeigt dann gar keine
 * WLAN-Karte, statt eine anzubieten, die nichts bewirkt.
 */
export type WifiState = 'unavailable' | 'offline' | 'connecting' | 'online' | 'hotspot';

/** Ein Netz in Reichweite. */
export interface WifiNetwork {
  ssid: string;
  /** Empfangsstaerke in Prozent, wie NetworkManager sie meldet. */
  signal: number;
  /** Verschluesselt? Ein offenes Netz braucht kein Passwortfeld. */
  secured: boolean;
  /** Liegt fuer dieses Netz schon ein Profil auf dem Spiegel? */
  known: boolean;
}

/**
 * Das Einrichtungs-WLAN, das der Spiegel selbst aufmacht.
 *
 * Das Passwort steht hier im Klartext, und das ist Absicht: es gehoert auf den
 * Spiegel, damit man es abschreiben kann. Es schuetzt nichts weiter als eine
 * Einrichtungsseite, die ohnehin nur oeffnet, wer davorsteht – anders als das
 * Passwort des Heimnetzes, das der Spiegel nie zurueckgibt.
 */
export interface WifiHotspot {
  active: boolean;
  ssid: string;
  passphrase: string;
  /** Adresse, unter der die App im Einrichtungs-WLAN steht. */
  address: string;
}

/** Was gerade unterwegs ist. Setzt der Core, nicht das Skript. */
export type WifiPending = 'scan' | 'connect' | 'forget' | 'hotspot';

export interface WifiStatus {
  /** Wann der Dienst zuletzt nachgesehen hat. */
  updatedAt: string;
  state: WifiState;
  /** Netz, mit dem der Spiegel verbunden ist. */
  ssid: string | null;
  /** Empfangsstaerke in Prozent, sofern verbunden. */
  signal: number | null;
  /**
   * Haengt ein Netzwerkkabel, das traegt?
   *
   * Steht neben `state` und nicht darin: beides gilt gleichzeitig, und die
   * Unterscheidung entscheidet ueber das Einrichtungs-WLAN. Ein Spiegel am
   * Kabel ist erreichbar und braucht keines.
   */
  ethernet: boolean;
  /** Netze aus dem letzten Suchlauf, stark zuerst. */
  networks: WifiNetwork[];
  scannedAt: string | null;
  /** Gespeicherte Netze, auch die gerade nicht in Reichweite sind. */
  known: string[];
  hotspot: WifiHotspot | null;
  /** Was zuletzt schiefging – etwa ein falsches Passwort. */
  lastError: string | null;
  /**
   * Zeitstempel des Auftrags, den dieser Stand beantwortet.
   *
   * Daran erkennt der Core, ob sein Auftrag angekommen ist. Ohne diese Angabe
   * bliebe ein Knopf, dessen Root-Dienst nicht laeuft, fuer immer bei
   * "verbinde …" stehen – derselbe Fehler, den der Updater schon einmal hatte.
   */
  answeredAt: string | null;
  /** Nur im Core gesetzt, solange ein Auftrag unterwegs ist. */
  pending?: WifiPending | null;
}

/** Adresse des Spiegels im eigenen Einrichtungs-WLAN (NetworkManager, "shared"). */
export const HOTSPOT_ADDRESS = '10.42.0.1';

export interface NetworkSettings {
  /**
   * Darf der Spiegel ein Einrichtungs-WLAN aufmachen, wenn er sonst nirgends
   * hinkommt?
   *
   * An, weil der Fall, in dem es hilft, genau der ist, in dem man es nicht
   * mehr einschalten koennte. Es kommt nur hoch, wenn weder WLAN noch Kabel
   * traegt – ein Spiegel am Kabel macht nie eines auf.
   */
  setupHotspot: boolean;
}

export const DEFAULT_NETWORK: NetworkSettings = { setupHotspot: true };

export function normalizeNetwork(value: unknown): NetworkSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<NetworkSettings>;
  return { setupHotspot: source.setupHotspot !== false };
}

const WIFI_STATES: WifiState[] = ['unavailable', 'offline', 'connecting', 'online', 'hotspot'];

/**
 * Steuerzeichen.
 *
 * Sie haben weder in einer SSID noch in einem Passwort etwas zu suchen – und
 * schon gar nicht in der Profildatei, die daraus entsteht: ein Zeilenumbruch
 * darin waere eine neue Zeile im Format und damit eine neue Einstellung.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Bringt auf die Form, was aus einem Shell-Skript kommt.
 *
 * Die Statusdatei schreibt deploy/mirror-wifi.sh, nicht das Typsystem. Eine
 * halb geschriebene oder aeltere Fassung soll die App nicht durcheinander-
 * bringen, sondern nur weniger zeigen.
 */
export function normalizeWifiStatus(value: unknown): WifiStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.updatedAt !== 'string') return null;

  const state = WIFI_STATES.includes(source.state as WifiState) ? (source.state as WifiState) : 'unavailable';

  return {
    updatedAt: source.updatedAt,
    state,
    ssid: typeof source.ssid === 'string' && source.ssid ? source.ssid : null,
    signal: clampSignal(source.signal),
    ethernet: source.ethernet === true,
    networks: normalizeNetworks(source.networks),
    scannedAt: typeof source.scannedAt === 'string' ? source.scannedAt : null,
    known: Array.isArray(source.known)
      ? source.known.filter((entry): entry is string => typeof entry === 'string')
      : [],
    hotspot: normalizeHotspot(source.hotspot),
    lastError: typeof source.lastError === 'string' && source.lastError ? source.lastError : null,
    answeredAt: typeof source.answeredAt === 'string' && source.answeredAt ? source.answeredAt : null,
    pending: null,
  };
}

function clampSignal(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(100, Math.max(0, Math.round(num)));
}

function normalizeNetworks(value: unknown): WifiNetwork[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const networks: WifiNetwork[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const source = entry as Record<string, unknown>;
    const ssid = typeof source.ssid === 'string' ? source.ssid.trim() : '';
    // Ein verstecktes Netz meldet sich ohne Namen. Es liesse sich weder
    // antippen noch benennen – also gar nicht erst auflisten. Und derselbe
    // Name kommt bei zwei Zugangspunkten zweimal: gezaehlt wird das Netz und
    // nicht die Antenne.
    if (!ssid || seen.has(ssid)) continue;
    seen.add(ssid);
    networks.push({
      ssid,
      signal: clampSignal(source.signal) ?? 0,
      secured: source.secured === true,
      known: source.known === true,
    });
  }
  // Stark zuerst: das eigene Netz ist fast immer das staerkste, und die Liste
  // wird auf einem Handy gelesen, das jemand vor dem Spiegel haelt.
  return networks.sort((a, b) => b.signal - a.signal);
}

function normalizeHotspot(value: unknown): WifiHotspot | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.ssid !== 'string' || !source.ssid) return null;
  return {
    active: source.active === true,
    ssid: source.ssid,
    passphrase: typeof source.passphrase === 'string' ? source.passphrase : '',
    address: typeof source.address === 'string' && source.address ? source.address : HOTSPOT_ADDRESS,
  };
}

/**
 * Taugt das als Netzname?
 *
 * Geprueft wird hier und nicht erst im Skript, damit die App es sagen kann,
 * bevor der Auftrag geschrieben ist. Die Grenze kommt aus dem Standard: eine
 * SSID hat 1 bis 32 Byte.
 */
export function isValidSsid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (CONTROL_CHARS.test(value)) return false;
  return new TextEncoder().encode(value).length <= 32;
}

/**
 * Taugt das als WLAN-Passwort?
 *
 * WPA laesst 8 bis 63 Zeichen zu, dazu genau 64 Hex-Zeichen fuer den fertig
 * gerechneten Schluessel. Die leere Eingabe ist ebenfalls gueltig – das ist ein
 * offenes Netz.
 */
export function isValidPassphrase(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return true;
  if (CONTROL_CHARS.test(value)) return false;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  return value.length >= 8 && value.length <= 63;
}
