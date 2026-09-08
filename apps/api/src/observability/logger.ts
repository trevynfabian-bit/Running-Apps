/**
 * Structured logger with mandatory redaction.
 *
 * Health and auth data make logging a liability rather than just a
 * convenience. This logger redacts anything whose key looks secret, at every
 * nesting level, so an access token cannot reach stdout because someone
 * spread a provider response into a log call.
 */

const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|api[_-]?key|refresh|bearer|signature|cookie)/i;

const REDACTED = '[redacted]';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'test' ? 'error' : 'info';
}

/**
 * Deep-redact a value. Handles cycles, which are common in error objects and
 * HTTP client responses.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redact(nested, seen);
  }
  return out;
}

function emit(level: LogLevel, event: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

  const record = {
    level,
    event,
    time: new Date().toISOString(),
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.warn(line);
}

export const logger = {
  debug: (event: string, context?: Record<string, unknown>) => emit('debug', event, context),
  info: (event: string, context?: Record<string, unknown>) => emit('info', event, context),
  warn: (event: string, context?: Record<string, unknown>) => emit('warn', event, context),
  error: (event: string, context?: Record<string, unknown>) => emit('error', event, context),
};
