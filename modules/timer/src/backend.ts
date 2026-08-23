import { defineBackend } from '@mirror/sdk';
import { durationMs, timerLabel, type TimerConfig, type TimerState } from './shared.js';

/**
 * Der Timer im Core.
 *
 * Er tut sehr wenig, und das ist Absicht. Zwei Zeitpunkte in den Zustand
 * legen, einmal am Ende eine Mitteilung melden — mehr braucht es nicht. Wie
 * lange noch laeuft, rechnet die Anzeige aus denselben zwei Zeitpunkten selbst
 * aus; sie hat dieselbe Uhr. Ein Timer, der jede Sekunde eine Nachricht ueber
 * den Bus schickt, waere sechzig Nachrichten je Minute fuer eine Zahl, die
 * beide Seiten kennen.
 *
 * **Der Startknopf ist der Schalter in den Einstellungen.** Ein Modul hat in
 * der Handy-App keine eigene Oberflaeche — sie baut ihr Formular aus dem
 * Schema, und darin gibt es Felder und keine Knoepfe. Jede
 * Konfigurationsaenderung startet die Instanz neu, also *ist* dieser Neustart
 * der Start: `setup` laeuft, sieht den Schalter auf "an" und setzt die Uhr.
 *
 * Daraus folgt eine Eigenschaft, die man kennen muss: startet der Spiegel neu,
 * waehrend der Schalter noch an steht, beginnt der Timer von vorn. Der Core
 * merkt sich den Zustand eines Moduls nicht ueber einen Neustart hinweg, und
 * die Konfiguration gehoert dem Nutzer — ein Modul kann nicht hineinschreiben,
 * dass es schon gelaufen ist. Lieber ein Timer, der nach einem Stromausfall
 * noch einmal laeuft, als einer, der still verschwindet.
 */

/**
 * Wie lange die Mitteilung im Feed steht, nachdem die Zeit um ist.
 *
 * Lang genug, dass man sie auch dann noch sieht, wenn man beim Klingeln nicht
 * im Raum war, und kurz genug, dass sie nicht am naechsten Morgen noch dort
 * steht. Ein abgelaufener Timer ist eine Nachricht von jetzt.
 */
const NOTICE_TTL_SECONDS = 15 * 60;

export default defineBackend<TimerConfig, TimerState>({
  async setup(ctx) {
    if (!ctx.config.running) {
      // Ausgeschaltet heisst leerer Block und leerer Feed. Kein "kein Timer":
      // eine leere Flaeche auf einem Spiegel ist ein Spiegel, ein Satz darueber
      // ist eine Meldung, dass nichts zu melden ist.
      ctx.setState({ startedAt: null, endsAt: null });
      ctx.notify([]);
      return;
    }

    const total = durationMs(ctx.config.minutes);
    const started = new Date();
    const ends = new Date(started.getTime() + total);
    const label = timerLabel(ctx.config.label);

    ctx.setState({ startedAt: started.toISOString(), endsAt: ends.toISOString() });
    // Waehrend er laeuft, meldet der Timer nichts: die Restzeit steht im Block,
    // und der Feed ist fuer das da, was man sonst verpassen wuerde.
    ctx.notify([]);
    ctx.log.info(`Timer "${label}" laeuft ${ctx.config.minutes} min, bis ${ends.toISOString()}.`);

    ctx.after(total, () => {
      const at = new Date();
      ctx.notify([
        {
          id: 'done',
          label: 'Timer',
          title: label,
          meta: `abgelaufen um ${new Intl.DateTimeFormat(ctx.locale, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: ctx.timezone,
          }).format(at)}`,
          /*
           * Nicht dringend, obwohl es verlockend waere.
           *
           * "Dringend" ist im Feed die Auszeichnung fuer eine Warnung: sie
           * bekommt das Warndreieck und den warmen Ton, und wer sie zu oft
           * vergibt, hat am Ende einen Feed aus lauter Dreiecken. Ein
           * abgelaufener Timer steht auch ohne sie ganz oben — er traegt den
           * Zeitpunkt "jetzt", und der Feed sortiert das Naechste nach vorn.
           * Auffaellig genug ist der Block selbst: dort steht "Fertig" in Sand.
           */
          at: at.toISOString(),
          ttlSeconds: NOTICE_TTL_SECONDS,
        },
      ]);
    });
  },
});
