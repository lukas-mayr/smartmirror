import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimale Bruecke. Die Oberflaeche braucht vom Hauptprozess fast nichts –
 * alle Inhalte kommen ueber den WebSocket vom Core. Je kleiner diese Flaeche,
 * desto weniger kann ein fehlerhaftes Modul-Frontend anrichten.
 */
contextBridge.exposeInMainWorld('mirror', {
  version: process.env.npm_package_version ?? '0.0.0',
  platform: process.platform,
  reload: () => ipcRenderer.send('mirror:reload'),
});
