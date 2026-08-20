import { AuthStore } from './auth.js';
import { ConfigStore } from './config-store.js';
import { ModuleHost } from './module-host.js';
import { PowerController } from './power.js';
import { SecretStore } from './secrets.js';
import { UpdateBridge } from './update-bridge.js';
import { createServer } from './server.js';
import { createLogger } from './logger.js';
import { appVersion, dataDir, modulesDir } from './paths.js';

const log = createLogger('core');

const port = Number(process.env.MIRROR_PORT ?? 8080);
const host = process.env.MIRROR_HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  log.info(`Smartmirror Core v${appVersion()} startet.`);
  log.info(`Daten: ${dataDir}`);
  log.info(`Module: ${modulesDir}`);

  const config = new ConfigStore();
  await config.load();

  const secrets = new SecretStore();
  await secrets.load();

  const auth = new AuthStore();
  await auth.load();

  const modules = new ModuleHost(config.current, secrets);
  await modules.discover();

  const power = new PowerController(config.current);
  const updates = new UpdateBridge();

  const app = await createServer({ config, modules, secrets, auth, power, updates });

  // Erst zuhoeren, dann Module starten: ein Modul, das beim Start haengt, darf
  // nicht verhindern, dass der Healthcheck des Updaters antwortet.
  await app.listen({ port, host });
  log.info(`Server hoert auf http://${host}:${port}`);

  await power.start();
  updates.start();
  await modules.sync(config.current);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} empfangen – fahre herunter.`);
    power.stop();
    updates.stop();
    await modules.stopAll();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Ein unbehandelter Fehler in einem Modul darf den Spiegel nicht schwarz
  // machen. Protokollieren und weiterlaufen; systemd startet nur bei echtem
  // Prozessende neu.
  process.on('unhandledRejection', (reason) => log.error('Unbehandelte Promise-Ablehnung', reason));
  process.on('uncaughtException', (error) => log.error('Unbehandelte Ausnahme', error));
}

main().catch((error: unknown) => {
  log.error('Start fehlgeschlagen', error);
  process.exit(1);
});
