/**
 * Mitgelieferte Schriftfamilien.
 *
 * Auswahlkriterien: runde, freundliche Formen in der Naehe von Roboto, und
 * eine Lizenz, die das Mitliefern erlaubt – alle vier stehen unter der SIL
 * Open Font License 1.1. Sie werden lokal ausgeliefert, nie von einem CDN:
 * der Spiegel muss auch ohne Internet mit der richtigen Schrift starten.
 *
 * Gewichte bewusst nur 300-500: sehr duenne Schnitte wirken hinter der
 * Spiegelfolie ausgewaschen, sehr fette wirken plump und leuchten zu stark.
 */
export const FONT_FAMILIES = [
  {
    id: 'rubik',
    name: 'Rubik',
    package: '@fontsource/rubik',
    weights: [300, 400, 500],
    note: 'Leicht abgerundete Ecken, Proportionen nahe an Roboto. Ruhigste Wahl.',
  },
  {
    id: 'nunito',
    name: 'Nunito',
    package: '@fontsource/nunito',
    // 700/800 fuer das Spotify-Modul: dessen Titelzeile lebt vom fetten
    // Schnitt, und kuenstlich verdickte Schrift franst hinter der Folie aus.
    weights: [300, 400, 500, 700, 800],
    note: 'Deutlich abgerundete Endungen, wirkt weicher und freundlicher.',
  },
  {
    id: 'm-plus-rounded-1c',
    name: 'M PLUS Rounded 1c',
    package: '@fontsource/m-plus-rounded-1c',
    weights: [300, 400, 500],
    note: 'Durchgehend runde Strichenden, am staerksten "rund" von allen.',
  },
  {
    id: 'varela-round',
    name: 'Varela Round',
    package: '@fontsource/varela-round',
    // Diese Familie gibt es nur in einem Schnitt; duennere Gewichte werden
    // auf 400 abgebildet statt vom Browser kuenstlich verduennt.
    weights: [400],
    note: 'Sehr rund und kompakt, nur ein Schnitt verfuegbar.',
  },
];

/** Voreinstellung fuer neue Installationen. */
export const DEFAULT_FONT_ID = 'nunito';

/** Fallback-Kette, falls eine Datei fehlt – nie eine Serifenschrift. */
export const FONT_FALLBACK = "'Helvetica Neue', Arial, system-ui, sans-serif";
