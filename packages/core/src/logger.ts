import type { Logger } from '@mirror/sdk';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.MIRROR_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

/**
 * Schreibt nach stdout/stderr – auf dem Pi landet das ueber systemd im Journal
 * (`journalctl -u mirror-core`). Kein eigenes Logfile, keine Rotation noetig.
 */
function emit(level: Level, scope: string, message: string, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (args.length > 0) stream(line, ...args);
  else stream(line);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, ...args) => emit('debug', scope, message, args),
    info: (message, ...args) => emit('info', scope, message, args),
    warn: (message, ...args) => emit('warn', scope, message, args),
    error: (message, ...args) => emit('error', scope, message, args),
  };
}
