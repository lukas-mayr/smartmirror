import type { RestartScope } from '@mirror/sdk';
import { writeJsonAtomic } from './atomic-file.js';
import { createLogger } from './logger.js';
import { systemRequestFile } from './paths.js';

const log = createLogger('system');

export interface SystemRequest {
  action: 'restart-services' | 'reboot';
  requestedAt: string;
}

/**
 * Bindeglied zum Root-Dienst, der Dienste neu startet und das Geraet bootet.
 *
 * Derselbe Umweg wie beim Updater, und aus demselben Grund: der Core laeuft
 * unprivilegiert. Ein "systemctl restart" von hier aus beantwortet polkit mit
 * "Interactive authentication required", und ihm das Recht zu geben hiesse,
 * dem einzigen ans Netz gebundenen Dienst Kontrolle ueber das Geraet zu
 * geben. Eine Datei zu schreiben, die er ohnehin schreiben darf, reicht:
 * mirror-system.path sieht sie und startet mirror-system.service.
 *
 * Kein Status und keine Rueckmeldung — anders als beim Updater gibt es hier
 * nichts zu berichten. Ob es geklappt hat, sieht man daran, dass der Spiegel
 * neu startet; die Fernbedienung merkt es daran, dass die Verbindung abreisst
 * und wiederkommt.
 */
export async function requestRestart(scope: RestartScope): Promise<void> {
  const action: SystemRequest['action'] = scope === 'device' ? 'reboot' : 'restart-services';
  // Der Zeitstempel ist nicht Protokoll, sondern Schutz: faellt zwischen dem
  // Schreiben und dem Ausfuehren der Strom aus, liegt die Datei beim naechsten
  // Start noch da und die Path-Unit loest sofort wieder aus. Ein Spiegel, der
  // sich beim Booten selbst neu startet, kaeme aus der Schleife nicht mehr
  // heraus. mirror-system.sh verwirft deshalb alles, was zu alt ist.
  await writeJsonAtomic(systemRequestFile, { action, requestedAt: new Date().toISOString() });
  log.info(action === 'reboot' ? 'Neustart des Geraets angefordert.' : 'Neustart der Dienste angefordert.');
}
