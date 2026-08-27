import { isLocalOutletHost } from '@mirror/sdk';
import { createLogger } from './logger.js';

const log = createLogger('outlet');

/**
 * Eine Steckdose im WLAN darf den Spiegel nicht aufhalten. Vier Sekunden sind
 * grosszuegig fuer ein Geraet im selben Netz und kurz genug, dass ein
 * Schaltvorgang nicht in den naechsten laeuft (der Zeitplan tickt alle 20s).
 */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * Wo der Token der Steckdose liegt.
 *
 * Derselbe verschluesselte Speicher wie fuer Modul-Geheimnisse, aber unter
 * einem Bezeichner, den kein Modul tragen kann: Modul-Ids sind kebab-case und
 * enthalten keinen Doppelpunkt. Damit ist der Token vor den Modulen ebenso
 * sicher wie vor der Anzeige.
 */
export const OUTLET_SECRET_SCOPE = 'core:power';
export const OUTLET_SECRET_KEY = 'outletToken';

/** Was `/report` liefert – so viel davon, wie hier gebraucht wird. */
export interface OutletReport {
  relay: boolean;
  /** Momentanleistung in Watt. */
  watts: number;
  /** Gehaeusetemperatur in Grad, falls die Firmware sie mitschickt. */
  temperature: number | null;
}

/**
 * Ein Fehler, dessen Text in der Handy-App steht.
 *
 * Deshalb steht er auf Deutsch und nennt, was zu tun ist: wer eine Adresse
 * eintippt und "fetch failed" zurueckbekommt, weiss nicht, ob die IP falsch
 * ist, das Geraet schlaeft oder die Steckdose einen Token verlangt.
 */
export class OutletError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OutletError';
  }
}

/**
 * Lokale REST-Schnittstelle der myStrom-Steckdose.
 *
 * Sie ist bewusst die einzige Anbindung: kein Konto, keine Cloud, kein Weg
 * nach draussen. Der Spiegel spricht mit einem Geraet im selben Netz, und was
 * dort passiert, passiert auch dann noch, wenn es myStrom einmal nicht mehr
 * gibt. Bezahlt wird das mit einer Schnittstelle ohne Anmeldung – wer im
 * Netz ist, kann schalten. Das ist die Vorgabe des Geraets und nichts, was
 * der Spiegel entschieden haette.
 */
export async function readReport(host: string, token = ''): Promise<OutletReport> {
  const raw = await request(host, '/report', token);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Trifft zu, wenn hinter der Adresse etwas anderes sitzt – ein Router, ein
    // Drucker, ein zweiter Spiegel. Die Adresse ist dann erreichbar und
    // trotzdem falsch, und genau das soll dastehen.
    throw new OutletError('Unter dieser Adresse antwortet keine myStrom-Steckdose.');
  }
  const report = parsed as Record<string, unknown>;
  if (typeof report.relay !== 'boolean') {
    throw new OutletError('Unter dieser Adresse antwortet keine myStrom-Steckdose.');
  }
  return {
    relay: report.relay,
    watts: typeof report.power === 'number' ? Math.round(report.power * 10) / 10 : 0,
    temperature: typeof report.temperature === 'number' ? Math.round(report.temperature * 10) / 10 : null,
  };
}

/**
 * Schaltet und liest danach nach.
 *
 * `/relay` antwortet ohne Inhalt – ein Schaltbefehl allein ist deshalb nur
 * eine Behauptung. Erst der zweite Aufruf sagt, ob das Relais wirklich
 * umgelegt hat; genau daran haengt in der App die Anzeige, ob die Steckdose
 * tut, was der Zeitplan sagt.
 */
export async function setRelay(host: string, on: boolean, token = ''): Promise<OutletReport> {
  await request(host, `/relay?state=${on ? 1 : 0}`, token);
  const report = await readReport(host, token);
  if (report.relay !== on) {
    throw new OutletError(`Die Steckdose liess sich nicht ${on ? 'ein' : 'aus'}schalten.`);
  }
  log.debug(`Steckdose ${host} ${on ? 'ein' : 'aus'}geschaltet.`);
  return report;
}

async function request(host: string, path: string, token: string): Promise<string> {
  if (!host) throw new OutletError('Fuer die Steckdose ist keine Adresse hinterlegt.');
  // Die Grenze steht hier und nicht erst in den Einstellungen: was auch immer
  // in der Konfiguration steht, hinaus geht ueber diesen Weg nichts. Die
  // Steckdose ist die einzige Adresse, die jemand von Hand eintippt – jede
  // andere Adresse, die der Spiegel aufruft, steht im Quelltext.
  if (!isLocalOutletHost(host)) {
    throw new OutletError('Nur Steckdosen im eigenen Netz. Diese Adresse liegt ausserhalb.');
  }
  // Die Adresse wird hier gebaut und nicht uebernommen: `host` ist beim
  // Speichern auf Hostname und Port zusammengestrichen worden, damit aus einem
  // eingefuegten Link kein Aufruf irgendwohin wird.
  const url = `http://${host}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      // Der Token schuetzt die Schnittstelle der Dose, wenn er in der
      // myStrom-App eingeschaltet wurde. Er liegt verschluesselt neben den
      // Modul-Geheimnissen und erreicht weder die Anzeige noch die Handy-App.
      headers: token ? { Token: token } : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OutletError(reasonFor(error), { cause: error });
  }
  if (response.status === 401 || response.status === 403) {
    // Neuere Firmware kann die Schnittstelle mit einem Token schuetzen. Den
    // Schutz abzuschalten waere der bequeme Rat und der falsche – also nach
    // dem Token fragen.
    throw new OutletError(
      token
        ? 'Die Steckdose weist den hinterlegten Token zurueck.'
        : 'Die Steckdose verlangt einen Token. Er steht in der myStrom-App unter den Einstellungen der Dose.',
    );
  }
  if (!response.ok) throw new OutletError(`Die Steckdose antwortet mit Fehler ${response.status}.`);
  return await response.text();
}

/** Aus dem, was `fetch` wirft, einen Satz machen, der weiterhilft. */
function reasonFor(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'Die Steckdose antwortet nicht.';
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Diesen Namen kennt das Netz nicht.';
    case 'ECONNREFUSED':
      return 'Unter dieser Adresse nimmt niemand Verbindungen an.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Diese Adresse ist im Netz nicht erreichbar.';
    default:
      return 'Die Steckdose ist nicht erreichbar.';
  }
}
