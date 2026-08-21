import { createHash, randomBytes } from 'node:crypto';
import { defineBackend, type BackendContext, type Duration } from '@mirror/sdk';
import {
  extractCode,
  MAX_ACCOUNTS,
  REDIRECT_URI,
  SCOPE,
  type AccountPlayback,
  type SpotifyConfig,
  type SpotifyState,
} from './shared.js';

/**
 * Spotify rechnet in einem gleitenden Fenster von 30 Sekunden, und zwar je
 * App, nicht je Konto. Fuenf Konten alle zehn Sekunden sind eine Anfrage alle
 * zwei Sekunden – weit unter der Grenze, und die Anzeige rechnet den
 * Fortschritt zwischen zwei Antworten ohnehin selbst weiter.
 */
const POLL_PLAYING: Duration = '10s';
/** Hoert niemand, ist jede Frage eine zu viel. */
const POLL_IDLE: Duration = '30s';
/** Nach einem Fehler nicht sofort wieder – ein Netz, das weg ist, bleibt weg. */
const POLL_ERROR: Duration = '60s';
/** So lange vor Ablauf wird der Zugang erneuert. */
const TOKEN_MARGIN_MS = 120_000;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface CurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number | null;
  item: {
    name: string;
    duration_ms: number;
    artists?: { name: string }[];
    album?: { name: string };
    /** Bei Podcasts steht hier die Sendung statt eines Interpreten. */
    show?: { name: string };
  } | null;
}

/** Ein angemeldetes Konto zur Laufzeit. Der dauerhafte Teil liegt im SecretStore. */
interface Slot {
  slot: number;
  accessToken: string | null;
  expiresAt: number;
  name: string;
  /** Der Profilname wird einmal geholt; bis dahin heisst das Konto "Konto N". */
  named: boolean;
  entry: AccountPlayback;
}

/** 429: Spotify bremst die ganze App, nicht ein Konto – die Runde endet sofort. */
class RateLimited extends Error {
  constructor(readonly seconds: number) {
    super(`Spotify bremst uns aus – naechster Versuch in ${seconds} s.`);
  }
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** Fehlermeldung aus einer Antwort von Spotify, so genau wie sie hergibt. */
async function describeFailure(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: string };
      error_description?: string;
    };
    const detail =
      body.error_description ??
      (typeof body.error === 'string' ? body.error : body.error?.message);
    if (detail) return `${fallback}: ${detail}`;
  } catch {
    // Antwort ohne JSON – dann bleibt es beim Statuscode.
  }
  return `${fallback} (HTTP ${response.status})`;
}

export default defineBackend<SpotifyConfig, SpotifyState>({
  async setup(ctx: BackendContext<SpotifyConfig, SpotifyState>) {
    const clientId = (ctx.config.clientId ?? '').trim();
    const slots = new Map<number, Slot>();

    const secretKey = (slot: number): string => `refreshToken.${slot}`;

    const emptyEntry = (slot: number, name: string): AccountPlayback => ({
      slot,
      name,
      playing: false,
      title: null,
      artist: null,
      album: null,
      durationMs: null,
      progressMs: null,
      sampledAt: null,
    });

    const publish = (): void => {
      const accounts = [...slots.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((slot) => slot.entry);
      ctx.setState({ connectedCount: slots.size, accounts });
    };

    const freeSlot = (): number | null => {
      for (let n = 1; n <= MAX_ACCOUNTS; n += 1) if (!slots.has(n)) return n;
      return null;
    };

    const postToken = async (body: URLSearchParams, fallback: string): Promise<TokenResponse> => {
      const response = await ctx.fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!response.ok) throw new Error(await describeFailure(response, fallback));
      return (await response.json()) as TokenResponse;
    };

    /**
     * Haelt die Bitte an den Nutzer aktuell: solange ein Platz frei ist, steht
     * im Einstellungsblatt eine Anmeldeadresse bereit; sind alle belegt,
     * verschwindet sie.
     *
     * Der Nachweis (PKCE) wird verschluesselt abgelegt und wiederverwendet,
     * solange die Anmeldung offen ist – zwischen Antippen und Einfuegen der
     * Antwort koennen Minuten liegen, und ein Neustart dazwischen darf die
     * Anmeldung nicht in eine Sackgasse fuehren.
     */
    const updateAction = async (): Promise<void> => {
      if (freeSlot() === null) {
        ctx.setAction(null);
        return;
      }
      let verifier = ctx.secret('verifier');
      if (!verifier) {
        verifier = base64url(randomBytes(64));
        await ctx.setSecret('verifier', verifier);
      }
      const challenge = base64url(createHash('sha256').update(verifier).digest());

      const url = new URL('https://accounts.spotify.com/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', REDIRECT_URI);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('scope', SCOPE);
      // Damit auch die zweite Person im Haushalt ihr eigenes Konto erwischt
      // und nicht die noch offene Sitzung der ersten.
      url.searchParams.set('show_dialog', 'true');

      ctx.setAction({
        label:
          slots.size === 0
            ? 'Bei Spotify anmelden. Danach zeigt der Browser eine Fehlerseite – ihre Adresse unten einfuegen.'
            : `Weiteres Konto verbinden (${slots.size} von ${MAX_ACCOUNTS} belegt). Danach die Adresse der Fehlerseite unten einfuegen.`,
        url: url.toString(),
      });
    };

    const refreshAccess = async (slot: Slot): Promise<void> => {
      const refreshToken = ctx.secret(secretKey(slot.slot));
      if (!refreshToken) throw new Error('Kein Zugang hinterlegt.');

      const token = await postToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }),
        `Zugang fuer "${slot.name}" laesst sich nicht erneuern`,
      );
      slot.accessToken = token.access_token;
      slot.expiresAt = Date.now() + token.expires_in * 1000;
      // Bei PKCE tauscht Spotify den dauerhaften Zugang regelmaessig aus. Den
      // alten zu behalten, hiesse: beim naechsten Neustart ist er wertlos.
      if (token.refresh_token && token.refresh_token !== refreshToken) {
        await ctx.setSecret(secretKey(slot.slot), token.refresh_token);
      }
    };

    const ensureAccess = async (slot: Slot): Promise<string> => {
      if (!slot.accessToken || Date.now() > slot.expiresAt - TOKEN_MARGIN_MS) {
        await refreshAccess(slot);
      }
      return slot.accessToken as string;
    };

    /** Profilname – reiner Komfort. Scheitert er, bleibt es bei "Konto N". */
    const fetchName = async (slot: Slot): Promise<void> => {
      if (slot.named) return;
      try {
        const response = await ctx.fetch('https://api.spotify.com/v1/me', {
          headers: { authorization: `Bearer ${slot.accessToken}` },
        });
        if (response.ok) {
          const body = (await response.json()) as { display_name?: string | null };
          if (body.display_name) slot.name = body.display_name;
        }
      } catch {
        // Ohne Namen laeuft alles weiter.
      }
      slot.named = true;
      slot.entry.name = slot.name;
    };

    /** Ein Konto abmelden und seinen Platz wieder freigeben. */
    const disconnect = async (slot: Slot, reason: string): Promise<void> => {
      slots.delete(slot.slot);
      await ctx.setSecret(secretKey(slot.slot), null);
      ctx.log.warn(`Konto "${slot.name}" getrennt: ${reason}`);
      await updateAction();
    };

    const connectSlot = (n: number): Slot => {
      const slot: Slot = {
        slot: n,
        accessToken: null,
        expiresAt: 0,
        name: `Konto ${n}`,
        named: false,
        entry: emptyEntry(n, `Konto ${n}`),
      };
      slots.set(n, slot);
      return slot;
    };

    const exchangeCode = async (pasted: string): Promise<void> => {
      const verifier = ctx.secret('verifier');
      if (!verifier) throw new Error('Zu dieser Antwort gibt es keine offene Anmeldung.');
      const free = freeSlot();
      if (free === null) throw new Error(`Alle ${MAX_ACCOUNTS} Plaetze sind belegt.`);

      const token = await postToken(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: extractCode(pasted),
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
        }),
        'Anmeldung fehlgeschlagen',
      );
      if (!token.refresh_token) {
        throw new Error('Spotify hat keinen dauerhaften Zugang mitgeschickt.');
      }

      const slot = connectSlot(free);
      slot.accessToken = token.access_token;
      slot.expiresAt = Date.now() + token.expires_in * 1000;
      await ctx.setSecret(secretKey(free), token.refresh_token);
      // Beide haben ihren Zweck erfuellt. Ein Code ist einmalig gueltig, und
      // was nicht mehr gebraucht wird, soll auch nicht mehr herumliegen.
      await ctx.setSecret('verifier', null);
      await ctx.setSecret('authResponse', null);
      await fetchName(slot);
      ctx.log.info(`Konto "${slot.name}" auf Platz ${free} angemeldet.`);
    };

    /** Einmal nachsehen, was auf diesem Konto laeuft. */
    const pollAccount = async (slot: Slot): Promise<boolean> => {
      const response = await ctx.fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { authorization: `Bearer ${await ensureAccess(slot)}` },
      });

      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after') ?? '30');
        throw new RateLimited(Number.isFinite(wait) ? Math.max(5, wait) : 30);
      }
      if (response.status === 401) {
        // Zugang seit der letzten Frage abgelaufen – naechste Runde mit frischem.
        slot.accessToken = null;
        return slot.entry.playing;
      }
      await fetchName(slot);

      // Nichts laeuft. Spotify antwortet dann ohne Inhalt.
      if (response.status === 204) {
        slot.entry = emptyEntry(slot.slot, slot.name);
        return false;
      }
      if (!response.ok) {
        throw new Error(await describeFailure(response, `Abfrage fuer "${slot.name}" fehlgeschlagen`));
      }

      const body = (await response.json()) as CurrentlyPlaying;
      const item = body.item;
      if (!item) {
        // Private Sitzung oder lokale Datei: Spotify meldet die Wiedergabe,
        // aber nicht, was gespielt wird. Fuer die Anzeige ist das Stille.
        slot.entry = emptyEntry(slot.slot, slot.name);
        return body.is_playing;
      }

      const artists = (item.artists ?? []).map((artist) => artist.name).filter(Boolean);
      slot.entry = {
        slot: slot.slot,
        name: slot.name,
        playing: body.is_playing,
        title: item.name,
        artist: artists.length > 0 ? artists.join(', ') : (item.show?.name ?? null),
        album: item.album?.name ?? null,
        durationMs: item.duration_ms,
        progressMs: body.progress_ms ?? 0,
        sampledAt: new Date().toISOString(),
      };
      return body.is_playing;
    };

    /**
     * Eine Runde ueber alle Konten, dann selbst festlegen, wann die naechste
     * kommt. Bewusst kein festes Intervall: laeuft irgendwo Musik, will die
     * Anzeige den Wechsel mitbekommen; hoert niemand, waere derselbe Takt nur
     * Verkehr fuer nichts.
     */
    const tick = async (): Promise<void> => {
      let anyPlaying = false;
      const failures: string[] = [];

      for (const slot of [...slots.values()]) {
        if (ctx.signal.aborted) return;
        try {
          anyPlaying = (await pollAccount(slot)) || anyPlaying;
        } catch (error) {
          if (error instanceof RateLimited) {
            // Die Bremse gilt der ganzen App – weiterzufragen macht es schlimmer.
            ctx.log.warn(error.message);
            publish();
            ctx.after(`${error.seconds}s`, tick);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          // Ein zurueckgezogener Zugang ist kein Netzfehler, sondern das Ende
          // dieser einen Anmeldung: Platz freigeben, die anderen laufen weiter.
          if (/invalid_grant|revoked/i.test(message)) {
            try {
              await disconnect(slot, message);
            } catch (nested) {
              ctx.log.error(`Konto "${slot.name}" liess sich nicht abmelden`, nested);
            }
            continue;
          }
          failures.push(message);
        }
      }

      publish();
      let next: Duration = anyPlaying ? POLL_PLAYING : POLL_IDLE;
      // Erst wenn kein einziges Konto mehr antwortet, ist es ein Fehler des
      // Moduls. Ein einzelnes stures Konto macht den Block nicht kaputt.
      if (failures.length > 0 && failures.length >= slots.size) {
        ctx.setError(failures[0] ?? 'Abfrage fehlgeschlagen');
        next = POLL_ERROR;
      }
      if (slots.size > 0 && !ctx.signal.aborted) ctx.after(next, tick);
    };

    /* --------------------------------- Start --------------------------------- */

    if (!clientId) {
      ctx.setAction({
        label: 'Client ID aus der eigenen Spotify-App eintragen – ohne sie gibt Spotify nichts heraus.',
      });
      ctx.setState({ connectedCount: 0, accounts: [] });
      return;
    }

    for (let n = 1; n <= MAX_ACCOUNTS; n += 1) {
      if (ctx.secret(secretKey(n))) connectSlot(n);
    }

    let loginError: string | null = null;
    const pasted = ctx.secret('authResponse')?.trim();
    if (pasted) {
      try {
        await exchangeCode(pasted);
      } catch (error) {
        loginError = error instanceof Error ? error.message : String(error);
        // Ein Code gilt einmal und nur wenige Minuten. Ihn stehen zu lassen,
        // hiesse: jeder Neustart scheitert an derselben alten Antwort. Der
        // Nachweis geht mit, damit die naechste Anmeldung frisch beginnt.
        await ctx.setSecret('authResponse', null);
        await ctx.setSecret('verifier', null);
      }
    }

    await updateAction();
    publish();
    if (loginError) ctx.setError(loginError);
    if (slots.size > 0) await tick();
  },
});
