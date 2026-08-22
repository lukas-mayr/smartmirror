import {
  DEFAULT_FONT,
  FONT_STACKS,
  INSET_SIDES,
  isNightNow,
  rectFor,
  validate,
  ZONES,
  type MirrorConfig,
  type MirrorScreen,
  type ModuleDescriptor,
  type ModuleInstance,
  type ModuleStateEnvelope,
  type ModuleView,
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
  #powerOn = true;
  #burnInIndex = 0;
  #ready = false;
  /** Was gerade ueber der Buehne liegt, damit nur das Passende wieder weggeht. */
  #overlayVariant: 'full' | 'badge' | null = null;

  constructor(stage: HTMLElement, connection: CoreConnection, coreUrl: string) {
    this.#stage = stage;
    this.#screens = stage.querySelector('#screens') as HTMLElement;
    this.#dim = stage.querySelector('#dim') as HTMLElement;
    this.#frame = stage.querySelector('#frame') as HTMLElement;
    this.#overlay = stage.querySelector('#overlay') as HTMLElement;
    this.#connection = connection;
    this.#coreUrl = coreUrl;

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
    const visible = state !== 'online';
    this.#status.textContent = state === 'connecting' ? 'verbinde …' : 'keine Verbindung';
    this.#status.classList.toggle('status--visible', visible);
  }

  /* ---------------------------------- intern --------------------------------- */

  #appVersion(): string {
    return (window as unknown as { mirror?: { version: string } }).mirror?.version ?? '0.0.0';
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

    const desired = config.instances.filter((instance) => instance.enabled);
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
      config.instances.some((instance) => instance.enabled && instance.screenId === screen.id),
    );
  }

  #showScreen(id: string | null): void {
    this.#activeScreenId = id;
    for (const [screenId, element] of this.#screenElements) {
      element.classList.toggle('screen--active', screenId === id);
    }
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
