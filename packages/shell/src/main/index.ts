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

/**
 * Beendet den Startbildschirm, der unter cage lief, bis dieses Fenster stand.
 *
 * Er ist ein eigener Wayland-Client (deploy/cage-splash.py) und hat den
 * Bildschirm in den Sekunden bemalt, in denen der Compositor zwar die
 * Grafikausgabe hatte, diese Anwendung aber noch kein Bild. Er kennt diesen
 * Augenblick nicht - also sagt ihn ihm der einzige Prozess, der ihn kennt.
 *
 * Mit einer Sekunde Abstand: `ready-to-show` heisst, dass gezeichnet wurde,
 * nicht, dass das Fenster schon auf dem Bildschirm liegt. cage legt es ueber
 * den Startbildschirm, der so lange unsichtbar darunter liegt - eine Sekunde
 * zu frueh waere ein schwarzes Aufblitzen, eine Sekunde zu spaet sieht
 * niemand.
 *
 * Wenn das hier ausfaellt - kein Fenster, Absturz vorher -, beendet sich der
 * Startbildschirm nach eigener Frist von selbst. Ein Standbild, das ueber dem
 * Spiegel haengen bleibt, waere schlimmer als die Sekunden, gegen die es geht.
 */
function endeStartbild(): void {
  const pid = Number(process.env.MIRROR_SPLASH_PID);
  if (!Number.isInteger(pid) || pid <= 0) return;
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Schon beendet – dann ist genau das erreicht, worum es ging.
    }
  }, 1_000);
}

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
    /*
     * Die einzige Zahl, die den Startbildschirm betrifft und sich messen laesst.
     *
     * Zwischen dem Start von `cage` und diesem Augenblick ist der Bildschirm
     * schwarz: der Compositor hat die Grafikausgabe, aber noch kein Fenster zu
     * zeichnen. Wie lang das dauert, haengt am Geraet und daran, ob die
     * Anwendung schon im Speicher lag - deshalb steht es im Journal und nicht
     * in einer Schaetzung. Zusammen mit der Zeile "Vorgewaermt: ..." aus
     * cage-session.sh laesst sich `journalctl -u mirror-shell` lesen wie eine
     * Zeitleiste des Starts.
     */
    console.log(`[shell] erstes Bild nach ${process.uptime().toFixed(1)} s`);
    endeStartbild();
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
