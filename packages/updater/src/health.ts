const CORE_URL = process.env.MIRROR_CORE_URL ?? 'http://127.0.0.1:8080';

export interface HealthResult {
  healthy: boolean;
  reason: string;
  version?: string;
}

interface HealthResponse {
  ok: boolean;
  version: string;
  shellReady?: boolean;
  modules?: number;
}

/**
 * Entscheidet, ob ein frisch installiertes Release als funktionierend gilt.
 *
 * Die Latte liegt bewusst hoeher als "Prozess laeuft": der Core muss antworten,
 * die erwartete Version melden UND die Anzeige muss sich gemeldet haben. Sonst
 * wuerde ein Update durchgehen, bei dem der Server zwar startet, der Spiegel
 * aber schwarz bleibt – und genau das kann niemand aus der Ferne reparieren.
 */
export async function waitForHealthy(
  expectedVersion: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'Keine Antwort vom Core';

  while (Date.now() < deadline) {
    await sleep(2_000);
    try {
      const response = await fetch(`${CORE_URL}/healthz`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) {
        lastReason = `Core antwortete mit HTTP ${response.status}`;
        continue;
      }
      const body = (await response.json()) as HealthResponse;

      if (!body.ok) {
        lastReason = 'Core meldet sich als nicht bereit';
        continue;
      }
      if (body.version !== expectedVersion) {
        lastReason = `Core laeuft noch mit Version ${body.version}, erwartet ${expectedVersion}`;
        continue;
      }
      if (body.shellReady === false) {
        lastReason = 'Anzeige hat sich noch nicht gemeldet';
        continue;
      }

      log(`Healthcheck bestanden: Version ${body.version}, Anzeige bereit.`);
      return { healthy: true, reason: 'ok', version: body.version };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  return { healthy: false, reason: lastReason };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
