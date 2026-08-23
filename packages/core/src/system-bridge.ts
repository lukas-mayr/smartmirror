import type { RestartScope } from '@mirror/sdk';
import { writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { systemRequestFile } from './paths.js';

const log = createLogger('system');

export interface SystemRequest {
  action: 'restart-services' | 'reboot' | 'run-updater';
  requestedAt: string;
}

/*
 * Bindeglied zum Root-Dienst, der Dienste neu startet, das Geraet bootet und
 * den Updater anstoesst.
 *
 * Der Umweg ueber eine Datei ist Absicht: der Core laeuft unprivilegiert. Ein
 * "systemctl" von hier aus beantwortet polkit mit "Interactive authentication
 * required", und ihm das Recht zu geben hiesse, dem einzigen ans Netz
 * gebundenen Dienst Kontrolle ueber das Geraet zu geben. Eine Datei zu
 * schreiben, die er ohnehin schreiben darf, reicht.
 *
 * Abgeholt wird sie von zwei Seiten: mirror-system.path bemerkt sie sofort,
 * mirror-system.timer sieht alle zehn Sekunden nach. Das zweite gibt es, weil
 * das erste auf einem Geraet im Feld ausblieb - und ein Knopf, der nichts tut
 * und nichts sagt, ist schlimmer als einer, der zehn Sekunden braucht.
 *
 * Es liegt immer nur ein Auftrag vor. Zwei Knopfdruecke innerhalb derselben
 * zehn Sekunden ueberschreiben sich deshalb; der zweite gewinnt. Das ist
 * hinnehmbar, weil der Core jetzt meldet, wenn eine Anfrage unbeantwortet
 * bleibt - der verlorene Druck faellt auf und laesst sich wiederholen.
 */

/**
 * Bittet darum, Dienste oder Geraet neu zu starten.
 */
export async function requestRestart(scope: RestartScope): Promise<void> {
  const action: SystemRequest['action'] = scope === 'device' ? 'reboot' : 'restart-services';
  await schreibe(action);
  log.info(action === 'reboot' ? 'Neustart des Geraets angefordert.' : 'Neustart der Dienste angefordert.');
}

/**
 * Bittet darum, den Updater zu starten.
 *
 * Sein eigentlicher Auftrag liegt schon in update-request.json; hier fehlt nur
 * der Startschuss. Frueher gab ihn allein mirror-updater.path, sobald diese
 * Datei entstand - blieb das aus, wirkte der Knopf "Jetzt pruefen" nie, und
 * der Spiegel zeigte dauerhaft "suche nach Updates ...".
 */
export async function requestUpdaterRun(): Promise<void> {
  await schreibe('run-updater');
}

async function schreibe(action: SystemRequest['action']): Promise<void> {
  // Der Zeitstempel ist nicht Protokoll, sondern Schutz: faellt zwischen dem
  // Schreiben und dem Ausfuehren der Strom aus, liegt die Datei beim naechsten
  // Start noch da und der Auftrag wuerde erneut ausgefuehrt. Ein Spiegel, der
  // sich beim Booten selbst neu startet, kaeme aus der Schleife nicht mehr
  // heraus. mirror-system.sh verwirft deshalb alles, was zu alt ist.
  await writeJsonAtomic(systemRequestFile, { action, requestedAt: new Date().toISOString() });
}
