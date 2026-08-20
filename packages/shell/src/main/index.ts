import { app, BrowserWindow, protocol, net, screen, powerSaveBlocker } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Hauptprozess der Anzeige.
 *
 * Bewusst kein Browser im Kiosk-Modus: das hier ist eine eigenstaendige
 * Anwendung mit eigenem Fenstermanagement, eigenem Schema fuer die Oberflaeche
 * und ohne jede Browser-Bedienelemente. Gestartet wird sie von systemd unter
 * dem Compositor `cage` – es gibt keine Desktop-Umgebung, aus der man sie
 * "aufrufen" koennte.
 */

const CORE_URL = process.env.MIRROR_CORE_URL ?? 'http://127.0.0.1:8080';
const RENDERER_ROOT = join(__dirname, '../renderer');

// Eigenes Schema fuer die Oberflaeche. Es muss "standard" und "secure" sein,
// damit der Renderer eine echte Herkunft hat – sonst verweigert Chromium den
// dynamischen Import der Modul-Frontends vom Core.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// Nur eine Instanz. Ein zweiter Start (z.B. durch einen haengenden systemd-Neustart)
// darf nicht zwei Fenster uebereinanderlegen.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let saveBlocker: number | null = null;

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    width: display.size.width,
    height: display.size.height,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    fullscreen: true,
    kiosk: process.env.MIRROR_WINDOWED === '1' ? false : true,
    resizable: false,
    // Der wichtigste Wert der ganzen Datei: alles, was nicht leuchtet, muss
    // exakt schwarz sein, sonst schimmert der Bildschirm durch den Spiegel.
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Die Oberflaeche laeuft auf einem festen Bildschirm ohne Nutzereingaben;
      // Hintergrunddrosselung wuerde die Uhr stehenbleiben lassen.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Die Anzeige navigiert nie irgendwohin. Alles andere waere ein Weg, ueber
  // ein boesartiges Modul-Frontend aus der App auszubrechen.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[shell] Renderprozess beendet (${details.reason}) – lade neu.`);
    mainWindow?.reload();
  });

  const query = `?core=${encodeURIComponent(CORE_URL)}&version=${encodeURIComponent(app.getVersion())}`;
  void mainWindow.loadURL(`app://mirror/index.html${query}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Oberflaeche aus dem App-Bundle ausliefern.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const target = join(RENDERER_ROOT, relative);
    // Kein Ausbruch aus dem Renderer-Verzeichnis.
    if (!target.startsWith(RENDERER_ROOT)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  // Der Spiegel darf nicht in den Bildschirmschoner laufen – wann er dunkel
  // wird, entscheidet ausschliesslich der Zeitplan im Core.
  saveBlocker = powerSaveBlocker.start('prevent-display-sleep');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (saveBlocker !== null && powerSaveBlocker.isStarted(saveBlocker)) {
    powerSaveBlocker.stop(saveBlocker);
  }
  app.quit();
});
