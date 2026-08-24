import {
  carouselSlotMs,
  DEFAULT_FONT,
  DEFAULT_SCREEN_DURATION,
  FONT_STACKS,
  INSET_SIDES,
  isNightNow,
  nextCarouselId,
  normalizeNightMode,
  normalizeRotation,
  rectFor,
  validate,
  ZONES,
  type MirrorConfig,
  type MirrorScreen,
  type ModuleDescriptor,
  type ModuleInstance,
  type ModuleStateEnvelope,
  type ModuleView,
  type NightModeSettings,
  type ServerMessage,
  type Zone,
} from '@mirror/sdk';
import type { CoreConnection, ConnectionState } from './connection.js';
import { loadModuleFrontend } from './module-loader.js';

interface MountedInstance {
  instance: ModuleInstance;
  host: HTMLElement;
  view: ModuleView | null;
  moduleVersion: string;
  /**
   * Konfiguration nach Schema-Validierung, also mit gefuellten Defaults.
   * Modul-Frontends muessen dieselbe Sicht bekommen wie die Backends – sonst
   * verhaelt sich ein Modul unterschiedlich, je nachdem ob eine Einstellung
   * jemals von Hand gesetzt wurde.
   */
  config: Record<string, unknown>;
}

/**
 * Wie oft geprueft wird, ob die Nachtabsenkung greifen muss.
 *
 * Eine Minute reicht: die Grenze steht in "HH:MM", feiner laesst sie sich gar
 * nicht einstellen. Ein Timer auf genau den Umschaltzeitpunkt waere praeziser
 * und zugleich zerbrechlicher — er muesste bei jeder Konfigurationsaenderung,
 * bei jedem Neustart und bei jeder Zeitumstellung neu gestellt werden.
 */
const NIGHT_CHECK_INTERVAL_MS = 60_000;

/**
 * Was der Startbildschirm vom letzten Lauf wissen muss.
 *
 * Er ist das erste Bild ueberhaupt – da hat der Core noch nicht geantwortet,
 * und Drehung wie Nachtabsenkung stehen in dessen Konfiguration. Beide einmal
 * mitzuschreiben ist gut genug: die Drehung aendert sich beim Aufhaengen und
 * danach nie wieder, und das Nachtfenster steht in Stunden, nicht in Minuten.
 * Stimmt der gemerkte Wert doch einmal nicht, korrigiert ihn der erste
 * Schnappschuss ein paar Sekunden spaeter.
 */
const BOOT_MEMORY_KEY = 'mirror.boot';

/** Wie lange die Ueberblendung des Startbildschirms braucht (--motion-screen). */
const BOOT_FADE_MS = 900;

const BURN_IN_INTERVAL_MS = 15 * 60_000;
/** Wanderpfad des Einbrennschutzes in Pixeln. Klein genug, um nicht aufzufallen. */
const BURN_IN_PATH: readonly [number, number][] = [
  [0, 0],
  [4, 3],
  [0, 6],
  [-4, 3],
  [-4, -3],
  [0, -6],
  [4, -3],
];

export class MirrorApp {
  #stage: HTMLElement;
  #screens: HTMLElement;
  #dim: HTMLElement;
  #frame: HTMLElement;
  #overlay: HTMLElement;
  #boot: HTMLElement;
  #status: HTMLElement;
  #connection: CoreConnection;
  #coreUrl: string;

  #screenElements = new Map<string, HTMLElement>();
  #mounted = new Map<string, MountedInstance>();
  #descriptors = new Map<string, ModuleDescriptor>();
  #states = new Map<string, ModuleStateEnvelope>();
  #config: MirrorConfig | null = null;
  #activeScreenId: string | null = null;
  /** Screen, den die Handy-App gerade bearbeitet. Solange gesetzt: kein Weiterschalten. */
  #previewScreenId: string | null = null;
  #cycleTimer: number | undefined;
  /*
   * Die Durchschaltung im Fussband der laufenden Szene.
   *
   * Immer nur eine: sichtbar ist genau ein Screen, und ein Band, das niemand
   * sieht, braucht weder Timer noch Beobachter. Was hier steht, gehoert
   * deshalb zum aktiven Screen und wird beim Weiterschalten neu gesetzt.
   */
  #footBand: HTMLElement | null = null;
  #footWatcher: MutationObserver | null = null;
  #footTimer: number | undefined;
  /** Instanz, die im Fussband gerade dran ist. */
  #footShown: string | null = null;
  /** Fuer wen der laufende Timer gestellt ist – und wie lang. */
  #footTimerFor: string | null = null;
  #footSlotMs = 0;
  #powerOn = true;
  #burnInIndex = 0;
  #ready = false;
  /** Was gerade ueber der Buehne liegt, damit nur das Passende wieder weggeht. */
  #overlayVariant: 'full' | 'badge' | null = null;
  /** Liegt der Startbildschirm noch? Solange: kein Verbindungshinweis. */
  #booting = true;

  constructor(stage: HTMLElement, connection: CoreConnection, coreUrl: string) {
    this.#stage = stage;
    this.#screens = stage.querySelector('#screens') as HTMLElement;
    this.#dim = stage.querySelector('#dim') as HTMLElement;
    this.#frame = stage.querySelector('#frame') as HTMLElement;
    this.#overlay = stage.querySelector('#overlay') as HTMLElement;
    this.#boot = stage.querySelector('#boot') as HTMLElement;
    this.#connection = connection;
    this.#coreUrl = coreUrl;

    // Vor allem anderen: der Startbildschirm steht schon im Dokument und soll
    // gleich richtig herum und in der richtigen Helligkeit dastehen.
    this.#recallBootMemory();

    this.#status = document.createElement('div');
    this.#status.className = 'status';
    stage.append(this.#status);

    this.#buildFrame();
    this.#watchViewport();
    this.#startBurnInProtection();
    this.#startNightWatch();
  }

  handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        if (message.needsPairing) {
          this.#showOverlay(
            'Spiegel koppeln',
            null,
            'Oeffne die Spiegel-App auf dem Handy und gib den Code ein, sobald er hier erscheint.',
          );
        }
        return;

      case 'snapshot':
        this.#descriptors = new Map(message.modules.map((entry) => [entry.id, entry]));
        this.#states = new Map(Object.entries(message.state));
        this.#powerOn = message.power.on;
        this.#previewScreenId = message.previewScreenId;
        this.#applyConfig(message.config);
        this.#applyPower();
        this.#hideOverlay();
        this.#hideBoot();
        if (!this.#ready) {
          this.#ready = true;
          // Signal fuer den Healthcheck des Updaters: die Anzeige rendert
          // tatsaechlich Inhalte, nicht nur ein schwarzes Fenster.
          this.#connection.send({ t: 'shell:ready', appVersion: this.#appVersion() });
        }
        // Erst jetzt steht die Verbindung sicher genug, dass die Masse auch
        // ankommen. Der Beobachter unten hat vorher womoeglich ins Leere
        // gemeldet – der Core wirft doppelte Werte ohnehin weg.
        this.#reportViewport();
        return;

      case 'config:update':
        this.#applyConfig(message.config);
        return;

      case 'modules:update':
        this.#descriptors = new Map(message.modules.map((entry) => [entry.id, entry]));
        if (this.#config) this.#applyConfig(this.#config);
        return;

      case 'state:patch': {
        const previous = this.#states.get(message.envelope.instanceId);
        const merged: ModuleStateEnvelope = {
          instanceId: message.envelope.instanceId,
          patch: { ...(previous?.patch ?? {}), ...message.envelope.patch },
          error: message.envelope.error ?? null,
          updatedAt: message.envelope.updatedAt ?? previous?.updatedAt,
        };
        this.#states.set(merged.instanceId, merged);
        this.#pushState(merged);
        return;
      }

      case 'display:power':
        this.#powerOn = message.on;
        this.#applyPower();
        return;

      case 'display:previewScreen':
        // Die Handy-App bearbeitet einen Screen: ihn zeigen und stehen lassen,
        // sonst schaltet der Spiegel genau dann weiter, wenn jemand hinsieht.
        this.#previewScreenId = message.screenId;
        if (message.screenId) this.#showScreen(message.screenId);
        this.#scheduleCycle();
        return;

      case 'pair:code': {
        if (!message.code) {
          this.#hideOverlay();
          return;
        }
        // Beim ersten Koppeln gehoert der Code ueber den ganzen Spiegel – es
        // gibt ohnehin nichts anderes zu sehen. Danach ist er ein Zettel am
        // unteren Rand: ein zweites Handy zu koppeln darf weder die Wand
        // leerraeumen noch den Ausricht-Rahmen verdecken.
        const initial = (this.#config?.setup.step ?? 'pair') === 'pair';
        this.#showOverlay(
          initial ? 'Spiegel koppeln' : 'Neues Geraet koppeln',
          message.code,
          'Diesen Code in der Spiegel-App eingeben.',
          initial ? 'full' : 'badge',
        );
        return;
      }

      case 'error':
        console.error(`[shell] ${message.code}: ${message.message}`);
        return;

      default:
        return;
    }
  }

  setConnectionState(state: ConnectionState): void {
    // Waehrend eines Updates ist der Core kurz weg. Das ist kein Fehler, den
    // man gross anzeigen muesste – ein kleiner Hinweis unten rechts genuegt.
    //
    // Beim Start dagegen gar nichts: dass noch keine Verbindung steht, ist
    // dort der Normalfall und steht ohnehin auf dem Startbildschirm.
    const visible = state !== 'online' && !this.#booting;
    this.#status.textContent = state === 'connecting' ? 'verbinde …' : 'keine Verbindung';
    this.#status.classList.toggle('status--visible', visible);
  }

  /* ---------------------------------- intern --------------------------------- */

  #appVersion(): string {
    return (window as unknown as { mirror?: { version: string } }).mirror?.version ?? '0.0.0';
  }

  /**
   * Blendet den Startbildschirm aus, sobald etwas darunter steht.
   *
   * Erst beim Schnappschuss und nicht schon beim Verbindungsaufbau: dazwischen
   * liegt das Laden der Modul-Frontends, und ein leerer schwarzer Spiegel sieht
   * aus wie ein ausgeschalteter. Die Ueberblendung deckt den Rest ab – die
   * ersten Bloecke bauen sich darunter auf, waehrend sie laeuft.
   */
  #hideBoot(): void {
    if (!this.#booting) return;
    this.#booting = false;
    this.#boot.classList.add('boot--done');
    // Danach ganz aus dem Weg raeumen: ein durchsichtiges Element bliebe sonst
    // fuer immer ueber der Buehne liegen.
    window.setTimeout(() => this.#boot.classList.add('boot--gone'), BOOT_FADE_MS);
  }

  /**
   * Stellt Drehung und Nachtabsenkung des letzten Laufs wieder her.
   *
   * Ohne die Drehung laege das Wortzeichen auf einem hochkant aufgehaengten
   * Spiegel quer – derselbe Fehler, den die Drehung in der Konfiguration
   * (statt in der Handy-App) gerade vermeiden soll. Und ohne die Absenkung
   * leuchtete der Spiegel nach einem naechtlichen Update in voller Helligkeit
   * auf, statt dunkel zu bleiben.
   *
   * Fehlt der Wert, gilt das Standardfenster: das faellt im Zweifel dunkler
   * aus, und dunkler ist hinter einem Spiegel nie der Fehler.
   */
  #recallBootMemory(): void {
    let stored: unknown;
    try {
      const raw = window.localStorage.getItem(BOOT_MEMORY_KEY);
      if (!raw) return;
      stored = JSON.parse(raw);
    } catch {
      // Gesperrter oder beschaedigter Speicher: dann startet der Spiegel eben
      // ungedreht und hell. Der erste Schnappschuss richtet beides.
      return;
    }
    const memory = (typeof stored === 'object' && stored !== null ? stored : {}) as {
      rotation?: unknown;
      nightMode?: unknown;
    };
    document.documentElement.dataset.rotation = String(normalizeRotation(memory.rotation));
    if (isNightNow(normalizeNightMode(memory.nightMode))) document.documentElement.dataset.night = '1';
  }

  /** Schreibt mit, was der Startbildschirm beim naechsten Mal wissen muss. */
  #rememberBootMemory(config: MirrorConfig): void {
    const memory: { rotation: number; nightMode: NightModeSettings } = {
      rotation: config.display.rotation,
      nightMode: config.display.nightMode,
    };
    try {
      window.localStorage.setItem(BOOT_MEMORY_KEY, JSON.stringify(memory));
    } catch {
      // Ohne Speicher steht der Startbildschirm beim naechsten Mal wieder
      // ungedreht da – kein Grund, deswegen irgendetwas abzubrechen.
    }
  }

  /**
   * Schaltet die Nachtabsenkung.
   *
   * Ein einziges Attribut am Wurzelelement, und das Stylesheet setzt dieselben
   * Tokens eine Stufe dunkler. Der Vorteil gegenueber einer zweiten Variante
   * je Block: kein Modul muss von der Nacht wissen, und keines kann sie
   * vergessen.
   */
  #applyNight(): void {
    const settings = this.#config?.display.nightMode;
    const night = settings ? isNightNow(settings) : false;
    if (night) document.documentElement.dataset.night = '1';
    else delete document.documentElement.dataset.night;
  }

  /**
   * Prueft im Minutentakt, ob die Absenkung greifen muss.
   *
   * Kein Timer auf genau den Umschaltzeitpunkt: der waere praeziser und
   * zugleich zerbrechlicher – er muesste bei jeder Konfigurationsaenderung,
   * bei jedem Neustart und bei jeder Zeitumstellung neu gestellt werden. Eine
   * Minute Ungenauigkeit ist bei einer Grenze in "HH:MM" ohnehin die
   * Aufloesung der Einstellung selbst.
   */
  #startNightWatch(): void {
    window.setInterval(() => this.#applyNight(), NIGHT_CHECK_INTERVAL_MS);
  }

  #applyConfig(config: MirrorConfig): void {
    this.#config = config;
    // Die Drehung greift damit auch fuer den Kopplungscode: die Anzeige
    // bekommt ihre Konfiguration direkt beim Verbinden, lange bevor ein Handy
    // ueberhaupt gekoppelt ist.
    document.documentElement.dataset.rotation = String(config.display.rotation);
    this.#rememberBootMemory(config);
    for (const side of INSET_SIDES) {
      document.documentElement.style.setProperty(`--mirror-inset-${side}`, `${config.display.insets[side]}%`);
    }
    document.documentElement.style.setProperty(
      '--mirror-font',
      FONT_STACKS[config.display.fontFamily] ?? FONT_STACKS[DEFAULT_FONT],
    );
    document.documentElement.style.setProperty('--mirror-columns', String(config.display.grid.columns));
    document.documentElement.style.setProperty('--mirror-rows', String(config.display.grid.rows));
    this.#applyNight();
    this.#applyPower();
    this.#applySetup(config);
    this.#syncScreens(config.screens);

    /*
     * Angezeigt wird, was laeuft und was einen Platz belegt.
     *
     * Zwei Bedingungen, weil es zwei Fragen sind: `enabled` heisst, dass die
     * Instanz ueberhaupt laeuft, `visible`, dass man sie sieht. Eine Quelle,
     * die nur Mitteilungen liefert, laeuft im Core weiter und wird hier
     * einfach nicht aufgehaengt — der Mitteilungsblock zeigt, was sie meldet.
     */
    const desired = config.instances.filter((instance) => instance.enabled && instance.visible !== false);
    const desiredIds = new Set(desired.map((instance) => instance.id));

    for (const [id, mounted] of [...this.#mounted]) {
      if (!desiredIds.has(id)) this.#unmount(id, mounted);
    }

    for (const instance of desired) {
      const descriptor = this.#descriptors.get(instance.moduleId);
      const version = descriptor?.version ?? '0.0.0';
      const existing = this.#mounted.get(instance.id);

      if (existing && existing.moduleVersion === version) {
        existing.instance = instance;
        existing.config = this.#effectiveConfig(instance, descriptor);
        this.#place(existing.host, instance);
        this.#pushState(this.#states.get(instance.id), existing);
        continue;
      }

      if (existing) this.#unmount(instance.id, existing);
      void this.#mount(instance, version);
    }

    this.#scheduleCycle();
    // Die Standzeit des Screens ist der Takt der Durchschaltung: aendert sie
    // sich am Handy, muss das Fussband es sofort merken.
    this.#syncFoot();
  }

  /**
   * Legt fuer jeden Screen eine Flaeche an und raeumt verschwundene weg.
   *
   * Die Flaechen liegen alle gleichzeitig im Dokument und werden nur ein- und
   * ausgeblendet. Sie bei jedem Wechsel neu aufzubauen hiesse, jedes Modul neu
   * zu starten: die Uhr faenge von vorn an zu ticken, das Wetter holte seine
   * Daten erneut, und beim Zurueckschalten waere die Flaeche erst einmal leer.
   */
  #syncScreens(screens: readonly MirrorScreen[]): void {
    const known = new Set(screens.map((screen) => screen.id));
    for (const [id, element] of [...this.#screenElements]) {
      if (known.has(id)) continue;
      element.remove();
      this.#screenElements.delete(id);
    }

    for (const screen of screens) {
      let element = this.#screenElements.get(screen.id);
      if (!element) {
        element = document.createElement('section');
        element.className = 'screen';
        element.dataset.screen = screen.id;
        this.#screenElements.set(screen.id, element);
      }
      this.#syncZones(element, screen);
      // Auch bekannte Flaechen neu anhaengen: das stellt die Reihenfolge her,
      // in der weitergeschaltet wird.
      this.#screens.append(element);
    }

    // Haelt die Handy-App gerade einen Screen fest, gilt der – auch wenn die
    // Anzeige mitten im Bearbeiten neu verbunden hat.
    if (this.#previewScreenId && this.#screenElements.has(this.#previewScreenId)) {
      this.#showScreen(this.#previewScreenId);
      return;
    }

    const visible = this.#visibleScreens();
    const stillThere = this.#activeScreenId !== null && visible.some((s) => s.id === this.#activeScreenId);
    if (!stillThere) this.#showScreen((visible[0] ?? screens[0])?.id ?? null);
  }

  /**
   * Baut die drei Baender einer Szene auf oder raeumt sie wieder weg.
   *
   * Die Baender sind echte Elemente und keine Rasterzeilen, weil sie sich
   * anders verhalten: Kopf und Fuss haben eine feste Hoehe, die Mitte nimmt
   * den Rest, und ein leeres Fussband verschwindet. Als Raster mit drei Zeilen
   * waere jede dieser Regeln eine Ausnahme.
   *
   * Beim Umschalten zwischen Raster und Szene bleiben die Baender bzw. die
   * Bloecke im Dokument – nur ihr Elternteil wechselt. `#place` haengt jeden
   * Block gleich danach an die richtige Stelle, und weil kein Modul dabei
   * abgeraeumt wird, laeuft die Uhr weiter und das Wetter holt nichts neu.
   */
  #syncZones(element: HTMLElement, screen: MirrorScreen): void {
    const zones = screen.layout === 'zones';
    element.classList.toggle('screen--zones', zones);

    if (!zones) {
      for (const zone of [...element.querySelectorAll<HTMLElement>('.zone')]) zone.remove();
      return;
    }

    for (const zone of ZONES) {
      let band = element.querySelector<HTMLElement>(`.zone--${zone}`);
      if (!band) {
        band = document.createElement('div');
        band.className = `zone zone--${zone}`;
        band.dataset.zone = zone;
        element.append(band);
      }
      // Anhaengen stellt auch hier die Reihenfolge her: Kopf, Mitte, Fuss.
      element.append(band);
    }
  }

  /**
   * Setzt einen Block an seinen Platz – im Raster oder in seinem Band.
   *
   * Beides steht in der Instanz: Rasterkoordinaten *und* Band. Welches gilt,
   * entscheidet der Screen. So ueberlebt ein Block das Umschalten zwischen
   * beiden Anordnungen, ohne dass irgendwo ein Platz neu erfunden werden muss.
   */
  #place(host: HTMLElement, instance: ModuleInstance): void {
    host.dataset.size = instance.size;

    const screen = this.#screenElements.get(instance.screenId);
    if (!screen) return;

    if (screen.classList.contains('screen--zones')) {
      const zone: Zone = instance.zone;
      const band = screen.querySelector<HTMLElement>(`.zone--${zone}`);
      if (!band) return;
      // Die Rasterangaben abraeumen: sonst gaebe der Block im Band weiterhin
      // eine Spaltenbreite vor, die es dort gar nicht gibt.
      host.style.gridColumn = '';
      host.style.gridRow = '';
      host.dataset.zone = zone;
      if (host.parentElement !== band) band.append(host);
      return;
    }

    const grid = this.#config?.display.grid ?? { columns: 1, rows: 1 };
    const rect = rectFor(instance, grid);
    host.style.gridColumn = `${rect.x + 1} / span ${rect.columns}`;
    host.style.gridRow = `${rect.y + 1} / span ${rect.rows}`;
    delete host.dataset.zone;
    if (host.parentElement !== screen) screen.append(host);
  }

  /**
   * Screens, auf denen tatsaechlich etwas steht.
   *
   * Ein leerer Screen wuerde beim Weiterschalten zwanzig Sekunden schwarze
   * Wand ergeben – und genau so aussehen, als waere der Spiegel kaputt. Wer
   * einen Screen leert, will ihn vorbereiten, nicht abschalten.
   */
  #visibleScreens(): MirrorScreen[] {
    const config = this.#config;
    if (!config) return [];
    return config.screens.filter((screen) =>
      config.instances.some(
        (instance) => instance.enabled && instance.visible !== false && instance.screenId === screen.id,
      ),
    );
  }

  #showScreen(id: string | null): void {
    const changed = id !== this.#activeScreenId;
    this.#activeScreenId = id;
    for (const [screenId, element] of this.#screenElements) {
      element.classList.toggle('screen--active', screenId === id);
    }
    // Ein neuer Screen faengt sein Fussband von vorn an: nur so ist ein
    // Durchlauf genau so lang wie der Screen und niemand sieht das erste
    // Element zweimal, bevor er das letzte einmal gesehen hat.
    if (changed) this.#footShown = null;
    this.#syncFoot();
  }

  /**
   * Legt fest, wann der naechste Screen an die Reihe kommt.
   *
   * Kein gleichmaessiger Takt, sondern ein Timer je Screen: die Standzeit
   * gehoert zum Screen, und ein Blick auf die Uhr braucht keine zwei Minuten,
   * eine Einkaufsliste schon.
   */
  #scheduleCycle(): void {
    window.clearTimeout(this.#cycleTimer);
    this.#cycleTimer = undefined;

    // Waehrend am Handy an einem Screen gearbeitet wird, steht die Runde.
    if (this.#previewScreenId) return;

    const visible = this.#visibleScreens();
    if (visible.length < 2) return;

    const index = visible.findIndex((screen) => screen.id === this.#activeScreenId);
    const current = visible[index] ?? visible[0]!;
    if (index < 0) this.#showScreen(current.id);

    this.#cycleTimer = window.setTimeout(() => {
      const next = this.#visibleScreens();
      if (next.length === 0) return;
      const position = next.findIndex((screen) => screen.id === this.#activeScreenId);
      this.#showScreen(next[(position + 1) % next.length]!.id);
      this.#scheduleCycle();
    }, current.durationSeconds * 1000);
  }

  /* --------------------------- Fussband: Durchschaltung ---------------------- */

  /**
   * Das Fussband des laufenden Screens – falls es eine Szene ist.
   *
   * Ein Raster hat keine Baender, und ein Screen, den gerade niemand sieht,
   * hat nichts durchzuschalten.
   */
  #activeFoot(): HTMLElement | null {
    const screen = this.#activeScreenId ? this.#screenElements.get(this.#activeScreenId) : undefined;
    if (!screen?.classList.contains('screen--zones')) return null;
    return screen.querySelector<HTMLElement>('.zone--foot');
  }

  /**
   * Schaltet die Elemente des Fussbandes nacheinander durch.
   *
   * Zwei Bloecke nebeneinander sind im Fussband zwei halbe Baender – jedes zu
   * schmal fuer die Zeile, fuer die es gedacht ist. Nacheinander bekommt jedes
   * das ganze Band, und bezahlt wird mit Zeit statt mit Breite: die Standzeit
   * des Screens, geteilt durch die Anzahl (siehe `carouselSlotMs`).
   *
   * Mitgezaehlt wird nur, was gerade etwas zeigt. Ein Spotify-Block ohne
   * laufende Musik ist ein leerer Platz, und ein leerer Platz im Durchlauf
   * sieht aus wie ein Aussetzer des Spiegels. Er faellt deshalb aus der
   * Rechnung – und kommt von selbst wieder hinein, sobald etwas laeuft.
   *
   * Die Funktion ist absichtlich ohne Gedaechtnis ausser `#footShown`: sie
   * liest den Zustand aus dem Band, richtet ihn und aendert dabei nichts, was
   * schon stimmt. Nur so darf der Beobachter unten sie nach jeder Aenderung
   * im Band erneut aufrufen, ohne dass daraus eine Schleife wird.
   */
  #syncFoot(): void {
    const band = this.#activeFoot();

    /*
     * Baender anderer Screens bleiben stehen, wie sie stehen.
     *
     * Sie beim Wegschalten aufzuraeumen waere der naheliegende Reflex und
     * genau der falsche: der alte Screen blendet 900 ms lang aus, und in
     * dieser Zeit saehe man seine Fussleiste noch – mit einem Mal alle
     * Elemente nebeneinander. Ein angehaltener Durchlauf ist dagegen ein
     * gueltiges Bild, und wenn der Screen wiederkommt, richtet `#showScreen`
     * ihn vor dem ersten Bild neu aus.
     *
     * Geraeumt wird nur, was gar nicht mehr durchschalten kann – sonst bliebe
     * ein Band mit einem einzigen Block auf ewig ausgeblendet, weil kein
     * Timer mehr kommt, der es wieder einblendet.
     */
    for (const screen of this.#screenElements.values()) {
      const other = screen.querySelector<HTMLElement>('.zone--foot');
      if (!other || other === band) continue;
      if (other.querySelectorAll(':scope > .module').length < 2) this.#calmFoot(other);
    }

    this.#watchFoot(band);
    if (!band) {
      this.#stopFoot();
      return;
    }

    const hosts = [...band.querySelectorAll<HTMLElement>(':scope > .module')];
    // Ein einzelnes Element hat nichts, wozu es abwechseln koennte – und ein
    // leeres Band ist ohnehin keines: beide bleiben, wie sie sind.
    if (hosts.length < 2) {
      this.#calmFoot(band);
      this.#stopFoot();
      return;
    }

    band.classList.add('zone--cycling');

    const order = hosts.map((host) => host.dataset.instance ?? '');
    const eligible = hosts
      .filter((host) => this.#showsSomething(host))
      .map((host) => host.dataset.instance ?? '');

    const current =
      this.#footShown !== null && eligible.includes(this.#footShown)
        ? this.#footShown
        : nextCarouselId(order, eligible, this.#footShown);
    this.#footShown = current;

    for (const host of hosts) {
      host.classList.toggle('module--current', current !== null && host.dataset.instance === current);
    }
    this.#syncFootDots(band, eligible.length, current === null ? -1 : eligible.indexOf(current));

    const wanted = eligible.length > 1 ? carouselSlotMs(this.#activeDuration(), eligible.length) : 0;
    if (wanted <= 0) {
      this.#stopFoot();
      return;
    }

    /*
     * Der Timer wird nur gestellt, wenn er noch nicht laeuft oder fuer etwas
     * anderes laeuft.
     *
     * Sonst setzte ihn jede Aenderung im Band zurueck – und weil ein Modul
     * sich haeufiger neu zeichnet, als hier weitergeschaltet wird, stuende die
     * Durchschaltung fuer immer still.
     */
    if (this.#footTimer !== undefined && this.#footTimerFor === current && this.#footSlotMs === wanted) return;
    window.clearTimeout(this.#footTimer);
    this.#footTimerFor = current;
    this.#footSlotMs = wanted;
    this.#footTimer = window.setTimeout(() => this.#advanceFoot(), wanted);
  }

  /**
   * Weiter zum naechsten Element.
   *
   * Gezaehlt wird erst hier und nicht schon beim Stellen des Timers: zwischen
   * beidem liegt die ganze Standzeit, und in der kann ein Block dazugekommen
   * sein oder aufgehoert haben, etwas zu zeigen. Wer die Reihenfolge vorher
   * festlegt, schaltet auf einen Platz weiter, den es nicht mehr gibt.
   */
  #advanceFoot(): void {
    this.#footTimer = undefined;
    const band = this.#activeFoot();
    if (band) {
      const hosts = [...band.querySelectorAll<HTMLElement>(':scope > .module')];
      this.#footShown = nextCarouselId(
        hosts.map((host) => host.dataset.instance ?? ''),
        hosts.filter((host) => this.#showsSomething(host)).map((host) => host.dataset.instance ?? ''),
        this.#footShown,
      );
    }
    this.#syncFoot();
  }

  /**
   * Zeigt der Block ueberhaupt etwas?
   *
   * Gefragt wird das DOM und nicht das Modul: ein Modul, das nichts anzeigen
   * will, rendert nichts – das ist der Vertrag, den Spotify mit
   * "Ausblenden, wenn nichts laeuft" schon erfuellt. Ein zusaetzliches Feld
   * im Protokoll ("ich bin gerade leer") waere ein zweiter Zustand neben dem
   * ersten, und der kann falsch stehen.
   *
   * Text allein reicht als Antwort nicht: ein Block kann aus einer Grafik
   * bestehen und trotzdem etwas zeigen. Deshalb zusaetzlich die Frage, ob
   * irgendetwas darin eine Flaeche belegt.
   */
  #showsSomething(host: HTMLElement): boolean {
    if ((host.textContent ?? '').trim().length > 0) return true;
    // Erst hier kostet die Frage etwas: `getBoundingClientRect` erzwingt ein
    // Layout, und das soll nicht bei jedem Zeichnen eines Blocks anfallen,
    // der ohnehin Text zeigt.
    if (host.childElementCount === 0) return false;
    for (const node of host.querySelectorAll<HTMLElement>('*')) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }

  /**
   * Die Punktreihe an der rechten Kante des Bandes.
   *
   * Dieselbe wie im Wetter, und aus demselben Grund: ohne sie liest man im
   * Vorbeigehen die eine Zeile und weiss nicht, dass gleich eine andere
   * dasteht. Gezaehlt wird, was tatsaechlich drankommt – ein Block, der
   * nichts zeigt, bekommt auch keinen Punkt.
   *
   * Aufgebaut wird sie Stueck fuer Stueck und nicht bei jedem Aufruf neu:
   * jede Aenderung im Band ruft `#syncFoot` erneut auf, und ein Neuaufbau
   * waere eine Aenderung, die sich selbst ausloest.
   */
  #syncFootDots(band: HTMLElement, count: number, active: number): void {
    const existing = band.querySelector<HTMLElement>(':scope > .dots');
    if (count < 2) {
      existing?.remove();
      return;
    }

    const dots = existing ?? document.createElement('div');
    if (!existing) {
      dots.className = 'dots';
      band.append(dots);
    }
    while (dots.childElementCount > count) dots.lastElementChild?.remove();
    while (dots.childElementCount < count) dots.append(document.createElement('i'));
    [...dots.children].forEach((dot, index) => dot.classList.toggle('is-active', index === active));
  }

  /**
   * Beobachtet das Band des laufenden Screens.
   *
   * Ob ein Block etwas zeigt, aendert sich waehrend des Betriebs: Musik faengt
   * an zu laufen, eine Verbindung faehrt ab. Das steht in keiner Konfiguration
   * und in keinem Timer – es steht im DOM, und genau dort wird es abgeholt.
   *
   * Nur `childList`, und ausdruecklich kein `characterData`: aus nichts wird
   * etwas, indem Knoten entstehen, nicht indem sich ein Text aendert. Eine
   * Uhr im Fussband loeste sonst jede Sekunde eine Runde aus – und die Runde
   * misst Bloecke aus, was ein Layout erzwingt.
   */
  #watchFoot(band: HTMLElement | null): void {
    if (band === this.#footBand) return;
    this.#footWatcher?.disconnect();
    this.#footBand = band;
    if (!band) return;
    this.#footWatcher ??= new MutationObserver(() => this.#syncFoot());
    this.#footWatcher.observe(band, { childList: true, subtree: true });
  }

  /** Ein Band ohne Durchschaltung: alle Bloecke sichtbar, keine Punktreihe. */
  #calmFoot(band: HTMLElement): void {
    band.classList.remove('zone--cycling');
    band.querySelector<HTMLElement>(':scope > .dots')?.remove();
    for (const host of band.querySelectorAll<HTMLElement>(':scope > .module')) {
      host.classList.remove('module--current');
    }
  }

  #stopFoot(): void {
    window.clearTimeout(this.#footTimer);
    this.#footTimer = undefined;
    this.#footTimerFor = null;
    this.#footSlotMs = 0;
  }

  /** Standzeit des laufenden Screens – der Takt, den sich das Fussband teilt. */
  #activeDuration(): number {
    const screen = this.#config?.screens.find((entry) => entry.id === this.#activeScreenId);
    return screen?.durationSeconds ?? DEFAULT_SCREEN_DURATION;
  }

  async #mount(instance: ModuleInstance, moduleVersion: string): Promise<void> {
    const host = document.createElement('div');
    host.className = `module module--${instance.moduleId}`;
    host.dataset.instance = instance.id;
    this.#place(host, instance);

    const descriptor = this.#descriptors.get(instance.moduleId);
    const mounted: MountedInstance = {
      instance,
      host,
      view: null,
      moduleVersion,
      config: this.#effectiveConfig(instance, descriptor),
    };
    this.#mounted.set(instance.id, mounted);
    if (descriptor?.loadError) {
      host.classList.add('module--failed');
      host.textContent = `${descriptor.name}: ${descriptor.loadError}`;
      return;
    }

    try {
      const frontend = await loadModuleFrontend(this.#coreUrl, instance.moduleId, moduleVersion);
      // Waehrend des Ladens kann die Instanz schon wieder entfernt worden sein.
      if (this.#mounted.get(instance.id) !== mounted) return;

      mounted.view = frontend.create(host, {
        instanceId: instance.id,
        moduleId: instance.moduleId,
        config: mounted.config,
        locale: this.#config?.locale ?? 'de-DE',
        timezone: this.#config?.timezone ?? 'Europe/Vienna',
        sendCommand: (name, payload) =>
          this.#connection.send({ t: 'command', instanceId: instance.id, name, payload }),
      });
      this.#pushState(this.#states.get(instance.id), mounted);
    } catch (error) {
      // Ein Modul, das nicht laedt, darf die anderen nicht mitreissen.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[shell] Modul "${instance.moduleId}" nicht geladen:`, message);
      host.classList.add('module--failed');
      host.textContent = `${instance.moduleId} nicht verfuegbar`;
    }
  }

  #unmount(id: string, mounted: MountedInstance): void {
    try {
      mounted.view?.destroy?.();
    } catch (error) {
      console.warn(`[shell] destroy von "${id}" hat geworfen`, error);
    }
    mounted.host.remove();
    this.#mounted.delete(id);
  }

  #pushState(envelope: ModuleStateEnvelope | undefined, target?: MountedInstance): void {
    if (!envelope) return;
    const mounted = target ?? this.#mounted.get(envelope.instanceId);
    if (!mounted?.view) return;
    try {
      mounted.view.update(envelope.patch, mounted.config);
      mounted.view.setError?.(envelope.error ?? null);
    } catch (error) {
      console.error(`[shell] update von "${envelope.instanceId}" hat geworfen`, error);
    }
  }

  /**
   * Fuellt fehlende Einstellungen aus dem Schema des Moduls auf. Ohne das
   * bekaeme ein frisch hinzugefuegtes Modul eine leere Konfiguration und
   * wuerde sich anders verhalten als eines, das einmal konfiguriert wurde.
   */
  #effectiveConfig(instance: ModuleInstance, descriptor: ModuleDescriptor | undefined): Record<string, unknown> {
    if (!descriptor?.configSchema) return instance.config;
    return validate(descriptor.configSchema, instance.config).value as Record<string, unknown>;
  }

  /**
   * Baut den Ausricht-Rahmen einmal auf. Er haengt danach immer im Dokument
   * und wird nur ein- und ausgeblendet: waehrend des Ausrichtens kommt bei
   * jedem Tastendruck am Handy eine neue Konfiguration herein, und ein
   * Neuaufbau bei jeder davon waere ein Flackern genau an der Kante, auf die
   * der Nutzer gerade schaut.
   */
  #buildFrame(): void {
    for (const corner of ['tl', 'tr', 'br', 'bl']) {
      const element = document.createElement('div');
      element.className = `frame__corner frame__corner--${corner}`;
      this.#frame.append(element);
    }
    for (const orientation of ['vertical', 'horizontal']) {
      const element = document.createElement('div');
      element.className = `frame__cross frame__cross--${orientation}`;
      this.#frame.append(element);
    }

    const hint = document.createElement('div');
    hint.className = 'frame__hint';
    const title = document.createElement('b');
    title.textContent = 'Bildschirm ausrichten';
    hint.append(
      title,
      'Dieser Rahmen zeigt die bespielbare Flaeche. Verschiebe die Kanten in der Spiegel-App, bis rundum gleich viel Rand bleibt.',
    );
    this.#frame.append(hint);
  }

  /** Zweiter Schritt der Einrichtung: Rahmen zeigen statt Kopplungscode. */
  #applySetup(config: MirrorConfig): void {
    const aligning = config.setup.step === 'frame';
    this.#frame.classList.toggle('frame--visible', aligning);
    // Beim Ausrichten zaehlt der Rahmen, und zwar ganz – eine deckende
    // Einblendung muss weg. Der kleine Kopplungszettel darf bleiben: sonst
    // haette ein zweites Handy, das waehrenddessen dazukommt, keinen Code.
    if (aligning && this.#overlayVariant === 'full') this.#hideOverlay();
  }

  /**
   * Meldet die Kantenlaengen der Buehne an den Core.
   *
   * `offsetWidth`/`offsetHeight` und nicht `getBoundingClientRect()`: die
   * Buehne wird fuer hochkante Spiegel per CSS gedreht, und das Rechteck waere
   * dann wieder in Bildschirmkoordinaten. Gebraucht wird aber die Sicht des
   * Nutzers – auf einem hochkanten Spiegel ist "oben" die kurze Kante.
   */
  #reportViewport(): void {
    const width = this.#stage.offsetWidth;
    const height = this.#stage.offsetHeight;
    if (width <= 0 || height <= 0) return;
    this.#connection.send({ t: 'shell:viewport', viewport: { width, height } });
  }

  #watchViewport(): void {
    // Faengt beides ab: einen anderen Bildschirm am Kabel und einen Wechsel
    // der Drehung, der die Kantenlaengen tauscht.
    new ResizeObserver(() => this.#reportViewport()).observe(this.#stage);
  }

  #applyPower(): void {
    const brightness = this.#config?.display.brightness ?? 100;
    // Aus = vollstaendig schwarz. Gedimmt = teilweise abgedeckt. Das ist die
    // Rueckfallebene fuer alles, was per wlr-randr/ddcutil nicht erreichbar ist.
    const opacity = this.#powerOn ? Math.min(0.92, 1 - brightness / 100) : 1;
    this.#dim.style.opacity = String(opacity);
    this.#screens.setAttribute('aria-hidden', this.#powerOn ? 'false' : 'true');
  }

  /**
   * Einblendung ueber der Buehne.
   *
   * `full` deckt den Spiegel ab, `badge` legt eine kleine Karte an den unteren
   * Rand und laesst alles andere stehen.
   */
  #showOverlay(title: string, code: string | null, hint: string, variant: 'full' | 'badge' = 'full'): void {
    const card = document.createElement('div');
    card.className = 'overlay__card';

    const titleElement = document.createElement('div');
    titleElement.className = 'overlay__title';
    titleElement.textContent = title;
    card.append(titleElement);

    if (code) {
      const codeElement = document.createElement('div');
      codeElement.className = 'overlay__code';
      codeElement.textContent = code;
      card.append(codeElement);
    }

    const hintElement = document.createElement('div');
    hintElement.className = 'overlay__hint';
    hintElement.textContent = hint;
    card.append(hintElement);

    this.#overlay.replaceChildren(card);
    this.#overlay.classList.toggle('overlay--badge', variant === 'badge');
    this.#overlay.classList.add('overlay--visible');
    this.#overlayVariant = variant;
  }

  #hideOverlay(): void {
    this.#overlay.classList.remove('overlay--visible', 'overlay--badge');
    this.#overlayVariant = null;
  }

  #startBurnInProtection(): void {
    window.setInterval(() => {
      if (this.#config?.display.burnInProtection === false) return;
      this.#burnInIndex = (this.#burnInIndex + 1) % BURN_IN_PATH.length;
      const [x, y] = BURN_IN_PATH[this.#burnInIndex] as [number, number];
      document.documentElement.style.setProperty('--mirror-shift-x', `${x}px`);
      document.documentElement.style.setProperty('--mirror-shift-y', `${y}px`);
    }, BURN_IN_INTERVAL_MS);
  }
}
