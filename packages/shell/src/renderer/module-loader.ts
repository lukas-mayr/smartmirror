import type { ModuleFrontend } from '@mirror/sdk';

const cache = new Map<string, Promise<ModuleFrontend>>();

/**
 * Laedt das Frontend eines Moduls zur Laufzeit vom Core.
 *
 * Genau hier wird das Modulsystem zu einem echten: ein neues Modul landet auf
 * dem Pi und erscheint auf dem Spiegel, ohne dass die Anzeige-App neu gebaut
 * oder ausgeliefert werden muss.
 */
export function loadModuleFrontend(coreUrl: string, moduleId: string, version: string): Promise<ModuleFrontend> {
  const key = `${moduleId}@${version}`;
  const existing = cache.get(key);
  if (existing) return existing;

  // Die Version im Query-String haengt den Browser-Cache an die Modulversion:
  // nach einem Update wird neu geladen, sonst nicht.
  const url = new URL(`/modules/${moduleId}/frontend.js`, coreUrl);
  url.searchParams.set('v', version);

  const promise = import(/* @vite-ignore */ url.toString())
    .then((imported: { default?: ModuleFrontend }) => {
      const frontend = imported.default;
      if (!frontend || typeof frontend.create !== 'function') {
        throw new Error(`Modul "${moduleId}" exportiert kein Frontend mit create()`);
      }
      return frontend;
    })
    .catch((error: unknown) => {
      // Fehlgeschlagene Ladeversuche nicht dauerhaft merken – nach einem
      // Neustart des Core soll es wieder gehen.
      cache.delete(key);
      throw error;
    });

  cache.set(key, promise);
  return promise;
}

export function clearModuleCache(): void {
  cache.clear();
}
