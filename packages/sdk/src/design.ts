/**
 * Das Design-System, als Zahlen.
 *
 * Zwei Oberflaechen, ein System: die *Anzeige* hinter dem Zwei-Wege-Spiegel
 * (1080 x 1920, kein Eingabegeraet) und die *Fernbedienung* als PWA am Handy.
 * Beide haben ihr eigenes Stylesheet, und beide brauchen dieselben Werte –
 * aber nicht nur als CSS: das Wetter-Modul muss wissen, wie lange eine Karte
 * steht, der Feed, wann er nachrueckt, die Anzeige, wie hoch das Kopfband ist.
 *
 * Deshalb stehen die Werte hier und nicht nur in den beiden Stylesheets. Was
 * ausschliesslich CSS betrifft (Farben, Radien, Schriftgroessen), steht als
 * Konstante hier *und* als Custom Property dort; ein Test in packages/sdk/test
 * vergleicht beide Seiten, damit sie nicht auseinanderlaufen. Was Logik
 * braucht (Standzeiten, Rastermasse, Bandhoehen), wird von hier importiert.
 *
 * Die Custom Properties heissen auf der Anzeige `--mirror-*` und in der PWA
 * schlicht `--bg`, `--surface`, `--accent`: die Anzeige teilt sich ihr
 * Dokument mit Modul-Frontends fremder Herkunft, die PWA nicht.
 */

/* ------------------------------ Anzeige: Farbe ----------------------------- */

/**
 * Die Farben der Anzeige.
 *
 * Zwei Toene und sonst Grauwerte. Salbei traegt die Normalwerte – Beschriftungen,
 * Balken, Ringe, Konturen –, Sand die Spitzen und alles, was Aufmerksamkeit
 * verlangt. Ein dritter Ton wuerde die Rollen aufweichen: sobald Farbe nur noch
 * huebsch ist und nichts mehr bedeutet, liest man sie nicht mehr mit.
 */
export const MIRROR_COLORS = {
  /** Exakt schwarz, nie #050505: jeder Grauwert leuchtet durch das Glas. */
  bg: '#000000',
  /** Nur Text und Strich, nie Flaeche. */
  fg: '#ffffff',
  /** Sekundaerwerte. */
  fgDim: '#9a9a9a',
  /** Untergrenze, Achsen, Zustaende. Darunter verschwindet alles. */
  fgMute: '#707070',
  /** Salbei: Beschriftungen, Daten, Balken, Ringe. */
  accent: '#93b1a6',
  /** Sand: Spitzenwerte, Aufmerksamkeit. */
  accentWarm: '#d4b483',
  /** Dunkler Text auf einer deckenden Salbei-Flaeche. */
  onAccent: '#0d1512',
  /** Dunkler Text auf einer deckenden Sand-Flaeche. */
  onAccentWarm: '#1a1408',
  /** Fehler. Der einzige Zustand, der eine eigene Toenung tragen darf. */
  danger: '#c4574a',
  /** Fehlertext – die Flaeche selbst bleibt bei 8 %. */
  dangerFg: '#d97a6c',
} as const;

/**
 * Getoente Flaechen.
 *
 * Obergrenze fuer jede Flaeche: 12 % Deckkraft. Daruber summieren sich zwei
 * Boxen nebeneinander zu einem Leuchtfeld, und genau daran erkennt man von der
 * anderen Zimmerseite, dass hinter dem Spiegel ein Bildschirm haengt.
 */
export const MIRROR_SURFACES = {
  /** Neutrale Box: fast schwarz mit einer Kontur, die man eher ahnt. */
  box: '#0a0c0f',
  boxLine: 'rgba(255, 255, 255, 0.12)',
  boxAccent: 'rgba(147, 177, 166, 0.09)',
  boxAccentLine: 'rgba(147, 177, 166, 0.35)',
  boxWarm: 'rgba(212, 180, 131, 0.10)',
  boxWarmLine: 'rgba(212, 180, 131, 0.32)',
  boxDanger: 'rgba(196, 87, 74, 0.08)',
  boxDangerLine: 'rgba(196, 87, 74, 0.35)',
} as const;

/** Hoechste erlaubte Deckkraft einer getoenten Flaeche, in Prozent. */
export const MIRROR_SURFACE_MAX_ALPHA = 12;

/* ------------------------------ Anzeige: Typo ------------------------------ */

/**
 * Die Groessenstufen der Anzeige, in Pixeln auf 1080 x 1920.
 *
 * Der Kontrast entsteht aus dem Sprung: 240 gegen 26. Mittlere Groessen
 * sparsam – wo alles gleich gross ist, muss man jede Zeile einzeln lesen,
 * statt die Hierarchie in einer Sekunde zu sehen.
 *
 * Auf der Anzeige selbst rechnen die Module in Container-Einheiten (`cqh`,
 * `cqw`), damit dasselbe Modul jede Blockgroesse fuellt. Die Zahlen hier sind
 * die Referenz, gegen die diese Rechnungen gedacht sind – und die Vorlage fuer
 * jedes Element, das nicht in einem Block liegt (Zonen, Feed, Overlays).
 */
export const MIRROR_TYPE = {
  /** Die Uhrzeit im Kopfband. */
  mega: 240,
  /** Ein Titel, der den Raum traegt. */
  hero: 112,
  /** Grosse Werte: Temperatur, Restzeit. */
  xl: 84,
  /** Werte in mittleren Boecken. */
  l: 56,
  /** Zweitzeilen. */
  m: 40,
  /** Beschriftungen. Versalien, gesperrt, farbig. */
  label: 26,
  /** Untergrenze fuer 2 bis 3 m Leseabstand. */
  min: 32,
} as const;

/**
 * Schriftschnitte.
 *
 * Werte duenn, Beschriftungen halbfett. Das ist der Punkt, an dem das
 * Design-System der frueheren Handschrift widerspricht: bis 0.8 standen die
 * Werte im Schnitt 800. Ein fetter Wert in 240 px ist aber genau die grosse
 * helle Flaeche, vor der die Physik warnt – bei 300 traegt allein die Groesse
 * die Hierarchie, und die Flaeche bleibt klein.
 */
export const MIRROR_WEIGHT = {
  value: 300,
  label: 700,
  labelSoft: 600,
} as const;

/** Sperrung der Beschriftungen. */
export const MIRROR_TRACKING = {
  /** Grosse Werte ziehen optisch auseinander und werden zurueckgenommen. */
  value: '-0.035em',
  label: '0.14em',
  labelWide: '0.16em',
} as const;

/* ---------------------------- Anzeige: Geometrie --------------------------- */

/** Radien in Pixeln. Eine Box waehlt nach ihrer Groesse, nicht nach Geschmack. */
export const MIRROR_RADIUS = { s: 24, m: 24, l: 28, xl: 32, pill: 999 } as const;

/** Strichstaerken in Pixeln. */
export const MIRROR_STROKE = {
  /** Konturen von Boxen. */
  line: 1,
  /** Symbole. */
  icon: 1.5,
  /** Ringe, Linien, Diagramme. */
  graph: 4,
} as const;

/**
 * Das Raster der Anzeige, in Pixeln auf 1080 x 1920.
 *
 * 1080 minus zweimal 43 ergibt 994 px Inhaltsbreite. Davon drei Abstaende zu
 * je 32 px abgezogen bleiben 898 px fuer vier Spalten – also 224,5 px je
 * Spalte. `cellWidth` ist die abgerundete Zahl; die zwei Pixel Rest sind der
 * Grund, warum die Anzeige das Raster mit `1fr` rechnet und nicht mit diesem
 * Wert: der Browser verteilt sie, eine feste Spaltenbreite liesse sie am
 * rechten Rand liegen.
 *
 * In der Hoehe geht es exakt auf: zehn Zeilen zu 148 px plus neun Abstaende
 * ergeben 1768 px, oben und unten bleiben je 76 px Rand.
 *
 * Die Zelle ist bewusst quer (3:2) und nicht quadratisch: eine Box traegt eine
 * Beschriftung und darunter einen grossen Wert, und dafuer ist Breite mehr
 * wert als Hoehe.
 */
export const MIRROR_RASTER = {
  width: 1080,
  height: 1920,
  columns: 4,
  rows: 10,
  /** 4 % der Breite. */
  marginX: 43,
  marginY: 76,
  /** 2 rem. */
  gap: 32,
  cellWidth: 224,
  cellHeight: 148,
  /** Innenabstand einer Box. */
  boxPadding: 28,
} as const;

/**
 * Wieviele der zehn Zeilen hoechstens belegt sein duerfen.
 *
 * Leere Zeilen gruppieren die Boecke und lassen den Spiegel Spiegel bleiben.
 * Randvoll summieren sich die Toenungen zu einer leuchtenden Flaeche, und
 * nichts hat mehr Vorrang.
 */
export const MIRROR_MAX_FILLED_ROWS = 6;

/** Hoechstens zwei Boxen nebeneinander – vier erzwingen Schrift unter 32 px. */
export const MIRROR_MAX_BOXES_PER_ROW = 2;

/* ------------------------------ Anzeige: Zonen ----------------------------- */

/**
 * Die drei Baender einer Szene.
 *
 * Kopf 20 %, Hauptzone 60 %, Fussband 20 %. Die Uhr sitzt fix links oben,
 * rechts daneben genau ein Slot. Die Hauptzone traegt die Aussage der Szene,
 * das Fussband nur breite, flache Elemente – und darf leer bleiben.
 *
 * Der Unterschied zum freien Raster ist keine Geschmacksfrage: im Raster kann
 * jeder Block ueberall liegen, und wer zehn Zeilen hat, fuellt sie irgendwann.
 * Die Baender machen die Obergrenze zur Form.
 */
export const ZONES = ['head', 'main', 'foot'] as const;

export type Zone = (typeof ZONES)[number];

export const DEFAULT_ZONE: Zone = 'main';

export interface ZoneSpec {
  id: Zone;
  name: string;
  /** Hoehe in Pixeln auf 1920; `null` heisst "der Rest". */
  height: number | null;
  /** Anteil an der Hoehe, in Prozent – die Bezeichnung in der Handy-App. */
  share: number;
  note: string;
}

export const ZONE_SPECS: Record<Zone, ZoneSpec> = {
  head: {
    id: 'head',
    name: 'Kopf',
    height: 328,
    share: 20,
    note: 'Uhr fix links, rechts ein Slot – beide so breit wie ein L-Block.',
  },
  main: {
    id: 'main',
    name: 'Hauptzone',
    height: null,
    share: 60,
    note: 'Die Aussage der Szene. 1 bis 2 Bloecke, hoechstens eine Flaeche.',
  },
  foot: {
    id: 'foot',
    name: 'Fussband',
    height: 328,
    share: 20,
    note: 'Nur laengliche Elemente. Darf leer bleiben.',
  },
};

export const ZONE_OPTIONS: readonly ZoneSpec[] = ZONES.map((zone) => ZONE_SPECS[zone]);

/** Abstand zwischen zwei Baendern, in Pixeln. */
export const ZONE_GAP = 32;

/**
 * Hoechstens drei Elemente pro Szene: Uhr, ein Kopf-Slot, ein Hauptwidget.
 * Das Fussband zaehlt als viertes nur, wenn es etwas Laufendes zeigt.
 */
export const SCENE_MAX_ELEMENTS = 3;

/** Wieviele Bloecke ein Band traegt, bevor es zu voll wird. */
export const ZONE_CAPACITY: Record<Zone, number> = { head: 2, main: 2, foot: 1 };

export function isZone(value: unknown): value is Zone {
  return typeof value === 'string' && (ZONES as readonly string[]).includes(value);
}

export function normalizeZone(value: unknown, fallback: Zone = DEFAULT_ZONE): Zone {
  return isZone(value) ? value : fallback;
}

/* -------------------------------- Bewegung -------------------------------- */

/**
 * Bewegt wird nur, was sich inhaltlich aendert.
 *
 * Ein Wechsel steigt kurz auf und blendet ueber, Fortschritt waechst als
 * Breite, Laden atmet. Nie gleichzeitig zwei Elemente, nie Position und
 * Groesse zusammen, nachts gar nicht: im dunklen Raum zieht jede Animation den
 * Blick auf sich, und ein Spiegel, der den Blick zieht, ist kaputt.
 */
export const MOTION = {
  /** Dauer eines Wechsels in ms. */
  swap: 500,
  swapEasing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  /** Wie lange eine Karte steht, bevor die naechste kommt. */
  dwell: 2600,
  /** Takt einer fortlaufenden Bewegung (Fortschrittsbalken). */
  tick: 900,
  /** Atmen des Ladezustands. */
  breathe: 1400,
  /** Ueberblendung zwischen zwei Screens. */
  screen: 900,
} as const;

/* ------------------------------ Mitteilungsfeed ---------------------------- */

/**
 * Der Feed zeigt eine Mitteilung oben und darunter so viele als Ausblick, wie
 * in den Block passen.
 *
 * Eine Mitteilung ist eine schmale Zeile: Symbol, Titel, Beschreibung. Die
 * oberste traegt die Flaeche, die darunter stehen frei und nach unten hin
 * blasser. Damit liest man aus 3 m nur die oberste Zeile und weiss trotzdem,
 * dass mehr wartet. Ein leerer Feed heisst leere Hauptzone – kein "Keine
 * Mitteilungen".
 *
 * Die Masse sind bewusst zurueckhaltend. Bis 0.13 stand die oberste Mitteilung
 * in 72 px auf 232 px Hoehe – das ist die Groesse eines Wertes, und eine
 * Mitteilung ist keiner: man sieht nicht hin, um sie abzulesen, man
 * ueberfliegt sie. Seit 0.14 lag der Titel dafuer bei 30 px, und das war eine
 * Stufe zu weit: aus 3 m ueberfliegt man 30 px nicht mehr, man tritt naeher.
 * Seit 0.16 traegt die oberste Zeile die Stufe M (40 px) und der Ausblick die
 * Untergrenze fuer 3 m Leseabstand (32 px) – gross genug zum Ueberfliegen,
 * klein genug, dass in dieselbe Hauptzone weiterhin eine Liste passt und keine
 * drei Meldungen.
 *
 * Wem das nicht reicht, dreht am Faktor: `TEXT_SCALE` multipliziert die ganze
 * Zeile, und die Liste wird dann eben kuerzer. Das ist die richtige Reihenfolge
 * – lieber drei lesbare Mitteilungen als sechs, die niemand liest.
 *
 * Wieviele Positionen es sind, steht bewusst nicht hier: das entscheidet die
 * Blockhoehe. Eine feste Zahl waere in einem hohen Block eine halbleere Liste
 * und in einem flachen eine abgeschnittene. Was hier steht, sind die Masse,
 * aus denen sich die Zahl ergibt.
 */
export const FEED = {
  /** Ohne die oberste Position ist es kein Feed, sondern eine Meldung. */
  visibleMin: 1,
  /**
   * Obergrenze der Positionen.
   *
   * Nicht, weil mehr nicht passten, sondern weil ab hier niemand mehr eine
   * Liste liest, sondern eine Wand aus Text sieht – und die untersten Zeilen
   * waeren so blass, dass sie ohnehin nur noch Textur sind.
   */
  visibleMax: 8,
  /** Wie lange, bis die Liste eine Position nachrueckt. */
  advance: 3400,
  /** Hoehe der obersten Position in Pixeln. */
  itemHeight: 108,
  /** Hoehe jeder weiteren. */
  itemHeightRest: 80,
  /**
   * Anteil der Blockhoehe, den eine Position hoechstens einnimmt.
   *
   * Dieselben Werte wie die `cqh`-Deckel im Stylesheet: in einem flachen Block
   * gewinnt der Anteil, in einem hohen die Pixelhoehe. Sie stehen hier, weil
   * die Anzeige mit genau dieser Rechnung ermittelt, wieviele Positionen sie
   * besetzen darf – rechnete sie anders als das Stylesheet legt, waere die
   * unterste Zeile mal angeschnitten und mal fehlte eine.
   */
  itemShare: 0.15,
  itemShareRest: 0.11,
  /**
   * Abstand zwischen zwei Zeilen.
   *
   * Die Haelfte des Blockabstands: zwischen zwei Bloecken trennt der Abstand
   * zwei Themen, zwischen zwei Zeilen desselben Blocks nur zwei Zeilen. Auf
   * dem vollen Rasterabstand fiele eine Liste in lauter Einzelmeldungen
   * auseinander.
   */
  gap: 16,
  /**
   * Schriftgroesse des Titels oben bzw. auf den Ausblick-Positionen.
   *
   * Die Stufe M des Design-Systems und darunter die Untergrenze fuer 2 bis 3 m
   * Leseabstand: die oberste Zeile liest man aus dem Flur, die darunter, wenn
   * man hinsieht.
   */
  titleSize: 40,
  titleSizeRest: 32,
  /**
   * Deckkraft der Ausblick-Positionen: die erste darunter, die unterste.
   *
   * Dazwischen wird verteilt. Der Verlauf ist die Rangfolge – wer nur zwei
   * Stufen haette, muesste bei sechs Positionen vier davon gleich hell zeigen,
   * und dann steht dort eine Liste ohne Reihenfolge.
   */
  dim1: 0.8,
  dim2: 0.45,
} as const;

/* ------------------------------ Abfahrtstafel ------------------------------ */

/**
 * Die Zeile einer Abfahrtstafel.
 *
 * Sie steht hier aus demselben Grund wie der Feed: das Stylesheet setzt die
 * Zeile, die Anzeige rechnet aus, wieviele davon in den Block passen – und
 * beide muessen mit denselben Zahlen rechnen, sonst ist die unterste Zeile mal
 * angeschnitten und mal fehlt eine.
 *
 * Eine Zeile ist breit und flach: Fahrzeugsymbol, Linie, Ziel, Gleis, Restzeit.
 * Was frueher als Wort dastand, steht jetzt als Symbol – das Fahrzeug statt
 * "Bus", ein Kreuz statt "faellt aus", ein Wegweiser statt "Gleis". Damit
 * bleibt in derselben Zeile Platz fuer groessere Ziffern, und genau die sind
 * der Grund hinzusehen.
 */
export const BOARD = {
  /** Hoehe einer Zeile in Pixeln auf 1080 x 1920. */
  rowHeight: 112,
  /**
   * Anteil der Blockhoehe, den eine Zeile hoechstens einnimmt.
   *
   * Derselbe Deckel wie im Stylesheet: in einem flachen Block gewinnt der
   * Anteil, in einem hohen die Pixelhoehe.
   */
  rowShare: 0.26,
  /** Abstand zwischen zwei Zeilen – wie im Feed die Haelfte des Blockabstands. */
  gap: 16,
  /**
   * Das Mass, an dem alles in der Zeile haengt.
   *
   * Die Linie steht in dieser Groesse, das Ziel etwas darueber, die Restzeit
   * deutlich darueber und Gleis und Einheit darunter. Ein Mass statt fuenf:
   * eine Zeile, die aus fuenf unabhaengigen Groessen besteht, faellt beim
   * ersten Faktor auseinander.
   */
  textSize: 40,
} as const;

/* --------------------------------- Aushub ---------------------------------- */

/**
 * Der Timer als Baustelle: ein Bagger traegt einen Berg ab.
 *
 * Ein Timer auf einem Spiegel hat ein Problem, das eine Sanduhr nicht hat: man
 * geht daran vorbei. Eine Zahl, die herunterzaehlt, beantwortet "wieviel noch"
 * erst, wenn man sie liest — ein Berg, der kleiner geworden ist, beantwortet es
 * im Vorbeigehen. Deshalb zeigt dieses Modul die Restzeit zweimal: als Ziffern
 * fuer den, der hinsieht, und als Berg fuer den, der nur vorbeigeht.
 *
 * Die Zahlen hier tragen die eine Regel, an der die ganze Darstellung haengt:
 * **der Bagger arbeitet immer gleich schnell.** Ein Eimer dauert `bucket`, egal
 * ob der Timer auf drei Minuten oder auf zwei Stunden steht. Was sich mit der
 * Dauer aendert, ist der Berg — er ist bei einem langen Timer groesser und
 * braucht deshalb mehr Eimer. Andersherum waere es falsch: ein Bagger, der bei
 * einer Stunde in Zeitlupe schwenkt, sieht nicht nach viel Arbeit aus, sondern
 * nach einem haengenden Bildschirm.
 *
 * Die Taktung steht doppelt: hier als Zahl und im Stylesheet als Dauer der
 * Keyframes. Das Modul braucht sie, um auszurechnen, aus wievielen Eimern ein
 * Berg besteht; das Stylesheet braucht sie, um den Arm zu bewegen. Ein Test
 * haelt beide Seiten gegeneinander.
 */
export const DIG = {
  /** Ein Eimer: ausheben, heben, schwenken, kippen, zurueck. In ms. */
  bucket: 5000,
  /** Eimer, die auf einen Lastwagen gehen. Danach faehrt er, und der naechste kommt. */
  perLoad: 4,
  /**
   * Zahl der Ladungen, ab der der Berg den Block ganz ausfuellt.
   *
   * 360 Ladungen sind zwei Stunden — die laengste Dauer, die sich einstellen
   * laesst. Der Berg waechst also ueber den ganzen Bereich und stoesst erst
   * ganz oben an: waere die Grenze frueher erreicht, saehen eine halbe und
   * eine ganze Stunde gleich aus.
   */
  fullLoads: 360,
  /**
   * Kleinster Berg, als Anteil der vollen Groesse.
   *
   * Auch drei Minuten brauchen einen Berg, den man als Berg erkennt. Ohne
   * diese Untergrenze waere er ein Strich auf dem Boden, und der Bagger
   * schaufelte sichtbar an nichts.
   */
  minSize: 0.25,
  /**
   * Wie stark die Zahl der Ladungen auf die Groesse durchschlaegt.
   *
   * Kleiner als 1, weil der Block nicht mitwaechst: bei linearem Zusammenhang
   * waere ein Zehn-Minuten-Berg ein Kruemel neben dem Zwei-Stunden-Berg. Mit
   * 0,3 liegen zehn Minuten bei knapp der Haelfte, eine halbe Stunde bei zwei
   * Dritteln und eine ganze bei gut vier Fuenfteln — Unterschiede, die man
   * sieht, ohne dass die kurzen Timer zu einem Kruemel werden.
   */
  growth: 0.3,
  /**
   * Wann im Eimer gekippt wird, als Anteil seiner Dauer.
   *
   * `from` ist der Moment, in dem die Schaufel aufgeht, `to` der, in dem der
   * letzte Stoff unten angekommen ist. Danach ist die Schaufel leer — und erst
   * danach darf der Wagen anfahren.
   */
  dump: { from: 0.4, to: 0.56 },
  /**
   * Wann der Wagen wechselt, als Anteil einer Ladung.
   *
   * `leave` ist die Abfahrt des vollen, `ready` der Moment, in dem der naechste
   * steht. Beide Zahlen haben genau eine Aufgabe: der volle Wagen faehrt erst
   * los, wenn der letzte Eimer ausgeschuettet ist, und der neue steht, bevor
   * der naechste kippt. Sonst faellt eine Ladung neben die Mulde — und das
   * sieht man sofort.
   */
  swap: { leave: 0.92, ready: 0.08 },
} as const;

/* ------------------------------ Schriftgroesse ----------------------------- */

/**
 * Der Faktor, mit dem ein Block seine Schrift vergroessert.
 *
 * Die Masse des Design-Systems gelten fuer einen Spiegel im Flur bei 2 bis 3 m
 * Abstand. Ein Spiegel im Bad haengt naeher, einer am Ende des Korridors
 * weiter weg, und wer ohne Brille davorsteht, liest anders als der Rest der
 * Familie. Genau dafuer ist der Faktor da – und nicht dafuer, einen Block zum
 * Plakat zu machen: bei 1,6 ist Schluss.
 *
 * Er vergroessert die ganze Zeile, nicht nur die Schrift. Die Liste wird
 * dadurch kuerzer, weil weniger Zeilen in denselben Block passen. Das ist die
 * richtige Reihenfolge: lieber drei lesbare Zeilen als sechs, die niemand
 * liest.
 */
export const TEXT_SCALE = { min: 0.8, max: 1.6, step: 0.05, default: 1 } as const;

/** Der Faktor, auf die erlaubten Grenzen gebracht. Unsinn wird zu 1. */
export function clampTextScale(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return TEXT_SCALE.default;
  return Math.min(TEXT_SCALE.max, Math.max(TEXT_SCALE.min, num));
}

/* ---------------------------------- PWA ----------------------------------- */

/**
 * Die Fernbedienung.
 *
 * Sie haengt nicht hinter Glas und darf deshalb Flaechen und Grauwerte nutzen.
 * Die beiden Akzente behalten aber ihre Rollen: Salbei traegt die primaere
 * Aktion, Sand Hinweise und Updates, Rot ausschliesslich Zerstoerendes.
 */
export const PWA_COLORS = {
  bg: '#101012',
  surface: '#1a1a1d',
  surfaceRaised: '#24242a',
  line: '#33333a',
  text: '#f2f2f4',
  textDim: '#9a9aa4',
  accent: '#93b1a6',
  accentWarm: '#d4b483',
  danger: '#c4574a',
  /** Lesbares Rot auf dunklem Grund – die Flaeche selbst bleibt bei 14 %. */
  dangerFg: '#e08b80',
  success: '#6fa36f',
  /** Text auf einer deckenden Akzentflaeche. */
  onAccent: '#05060a',
} as const;

/** Groessenstufen der PWA in Pixeln. */
export const PWA_TYPE = {
  title: 28,
  heading: 20,
  body: 17,
  sm: 15,
  label: 13,
} as const;

export const PWA_RADIUS = { field: 12, card: 14, sheet: 28, pill: 999 } as const;

export const PWA_METRICS = {
  /**
   * Kleinstes Tap-Ziel. Alles, was man antippen kann, ist mindestens so gross –
   * darunter trifft ein Daumen zuverlaessig daneben.
   */
  tap: 48,
  /** Hoehe eines Formularfelds und einer Schaltflaeche. */
  field: 52,
  /** Hoehe eines Segments in einer Auswahlleiste. */
  segment: 44,
  /** Der Bildschirm, gegen den die Screens gezeichnet sind. */
  screenWidth: 390,
  screenHeight: 844,
} as const;
