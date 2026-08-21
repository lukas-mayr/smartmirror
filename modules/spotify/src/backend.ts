import { createHash, randomBytes } from 'node:crypto';
import { defineBackend, type BackendContext, type Duration } from '@mirror/sdk';
import { extractCode, REDIRECT_URI, SCOPE, type SpotifyConfig, type SpotifyState } from './shared.js';

/**
 * Spotify rechnet in einem gleitenden Fenster von 30 Sekunden. Alle zehn
 * Sekunden zu fragen, ist davon weit entfernt und reicht: die Anzeige rechnet
 * den Fortschritt zwischen zwei Antworten selbst weiter.
 */
const POLL_PLAYING: Duration = '10s';
/** Laeuft nichts, ist jede Frage eine zu viel. */
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

const IDLE_STATE: SpotifyState = {
  connected: true,
  playing: false,
  title: null,
  artist: null,
  album: null,
  durationMs: null,
  progressMs: null,
  sampledAt: null,
};

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
    let accessToken: string | null = null;
    let expiresAt = 0;

    const disconnected = (): void => {
      ctx.setState({ ...IDLE_STATE, connected: false });
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
     * Beginnt eine Anmeldung: Nachweis erzeugen, ablegen, Adresse anbieten.
     *
     * Der Nachweis (PKCE) wird verschluesselt gespeichert und nicht nur im
     * Speicher gehalten – zwischen dem Antippen der Adresse und dem Einfuegen
     * der Antwort koennen Minuten liegen, und ein Stromausfall in dieser Zeit
     * darf die Anmeldung nicht in eine Sackgasse fuehren.
     */
    const beginLogin = async (): Promise<void> => {
      const verifier = base64url(randomBytes(64));
      await ctx.setSecret('verifier', verifier);
      const challenge = base64url(createHash('sha256').update(verifier).digest());

      const url = new URL('https://accounts.spotify.com/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', REDIRECT_URI);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('scope', SCOPE);

      ctx.setAction({
        label: 'Bei Spotify anmelden. Danach zeigt der Browser eine Fehlerseite – ihre Adresse unten einfuegen.',
        url: url.toString(),
      });
      disconnected();
    };

    const exchangeCode = async (pasted: string): Promise<void> => {
      const verifier = ctx.secret('verifier');
      if (!verifier) throw new Error('Zu dieser Antwort gibt es keine offene Anmeldung.');

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

      accessToken = token.access_token;
      expiresAt = Date.now() + token.expires_in * 1000;
      await ctx.setSecret('refreshToken', token.refresh_token);
      // Beide haben ihren Zweck erfuellt. Ein Code ist einmalig gueltig, und
      // was nicht mehr gebraucht wird, soll auch nicht mehr herumliegen.
      await ctx.setSecret('verifier', null);
      await ctx.setSecret('authResponse', null);
      ctx.setAction(null);
      ctx.log.info('Bei Spotify angemeldet.');
    };

    /** Frischen Zugang holen. Wirft, wenn die Anmeldung nicht mehr gilt. */
    const refreshAccess = async (): Promise<void> => {
      const refreshToken = ctx.secret('refreshToken');
      if (!refreshToken) throw new Error('Kein Zugang hinterlegt.');

      const token = await postToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        }),
        'Zugang laesst sich nicht erneuern',
      );
      accessToken = token.access_token;
      expiresAt = Date.now() + token.expires_in * 1000;
      // Bei PKCE tauscht Spotify den dauerhaften Zugang regelmaessig aus. Den
      // alten zu behalten, hiesse: beim naechsten Neustart ist er wertlos.
      if (token.refresh_token && token.refresh_token !== refreshToken) {
        await ctx.setSecret('refreshToken', token.refresh_token);
      }
    };

    const ensureAccess = async (): Promise<string> => {
      if (!accessToken || Date.now() > expiresAt - TOKEN_MARGIN_MS) await refreshAccess();
      return accessToken as string;
    };

    /** Einmal nachsehen, was laeuft. Gibt zurueck, wann wieder gefragt wird. */
    const poll = async (): Promise<Duration> => {
      const response = await ctx.fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { authorization: `Bearer ${await ensureAccess()}` },
      });

      // Nichts laeuft. Spotify antwortet dann ohne Inhalt.
      if (response.status === 204) {
        ctx.setState(IDLE_STATE);
        return POLL_IDLE;
      }
      if (response.status === 401) {
        // Zugang seit der letzten Frage abgelaufen oder zurueckgezogen.
        accessToken = null;
        await refreshAccess();
        return '2s';
      }
      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after') ?? '30');
        ctx.log.warn(`Spotify bremst uns aus – naechster Versuch in ${wait} s.`);
        return `${Number.isFinite(wait) ? Math.max(5, wait) : 30}s`;
      }
      if (!response.ok) throw new Error(await describeFailure(response, 'Abfrage fehlgeschlagen'));

      const body = (await response.json()) as CurrentlyPlaying;
      const item = body.item;
      if (!item) {
        // Private Sitzung oder lokale Datei: Spotify meldet die Wiedergabe,
        // aber nicht, was gespielt wird. Fuer die Anzeige ist das Stille.
        ctx.setState(IDLE_STATE);
        return body.is_playing ? POLL_PLAYING : POLL_IDLE;
      }

      const artists = (item.artists ?? []).map((artist) => artist.name).filter(Boolean);
      ctx.setState({
        connected: true,
        playing: body.is_playing,
        title: item.name,
        artist: artists.length > 0 ? artists.join(', ') : (item.show?.name ?? null),
        album: item.album?.name ?? null,
        durationMs: item.duration_ms,
        progressMs: body.progress_ms ?? 0,
        sampledAt: new Date().toISOString(),
      });
      return body.is_playing ? POLL_PLAYING : POLL_IDLE;
    };

    /**
     * Nach einem Fehler: sagt, wann es wieder losgeht – oder `null`, wenn es
     * nichts mehr zu fragen gibt, weil die Anmeldung neu beginnen muss.
     */
    const recover = async (error: unknown): Promise<Duration | null> => {
      const message = error instanceof Error ? error.message : String(error);
      // Ein zurueckgezogener Zugang ist kein Netzfehler, sondern das Ende
      // dieser Anmeldung: dann lieber neu fragen als ewig weiterprobieren.
      if (/invalid_grant|revoked/i.test(message)) {
        try {
          await ctx.setSecret('refreshToken', null);
          accessToken = null;
          ctx.log.warn('Zugang gilt nicht mehr – neue Anmeldung noetig.');
          await beginLogin();
          return null;
        } catch (nested) {
          // Selbst das ist schiefgegangen. Weiterlaufen und es spaeter noch
          // einmal versuchen ist besser, als die Schleife hier enden zu lassen.
          ctx.log.error('Neue Anmeldung liess sich nicht vorbereiten', nested);
        }
      }
      ctx.setError(message);
      return POLL_ERROR;
    };

    /**
     * Fragt und legt selbst fest, wann wieder gefragt wird.
     *
     * Bewusst kein festes Intervall: waehrend ein Titel laeuft, will die
     * Anzeige mitbekommen, wenn er wechselt; steht die Musik, waere derselbe
     * Takt nur Verkehr fuer nichts.
     */
    const tick = async (): Promise<void> => {
      let next: Duration | null;
      try {
        next = await poll();
        ctx.setError(null);
      } catch (error) {
        next = await recover(error);
      }
      // Die Instanz kann waehrend der Abfrage gestoppt worden sein. Dann darf
      // hier kein neuer Zeitgeber mehr entstehen – der wuerde niemanden mehr
      // interessieren und trotzdem weiterlaufen.
      if (next !== null && !ctx.signal.aborted) ctx.after(next, tick);
    };

    if (!clientId) {
      ctx.setAction({
        label: 'Client ID aus der eigenen Spotify-App eintragen – ohne sie gibt Spotify nichts heraus.',
      });
      disconnected();
      return;
    }

    const pasted = ctx.secret('authResponse')?.trim();
    if (pasted) {
      try {
        await exchangeCode(pasted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Ein Code gilt einmal und nur wenige Minuten. Ihn stehen zu lassen,
        // hiesse: jeder Neustart scheitert an derselben alten Antwort.
        await ctx.setSecret('authResponse', null);
        await beginLogin();
        ctx.setError(message);
        return;
      }
    }

    if (!ctx.secret('refreshToken')) {
      await beginLogin();
      return;
    }

    ctx.setAction(null);
    await tick();
  },
});
