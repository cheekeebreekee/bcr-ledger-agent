import pino from 'pino';

/**
 * Process-wide logger. Uses Pino for structured JSON output that
 * Application Insights ingests verbatim (the connector parses any JSON
 * line on stdout and maps recognised fields like `level` and `msg`).
 *
 * Each functional area should create a child logger with `.child({ area })`
 * so logs can be filtered without losing context.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    app: 'bcr-ledger-agent',
    env: process.env.NODE_ENV ?? 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      '*.password',
      '*.secret',
      '*.token',
      '*.authorization',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
});

export type Logger = pino.Logger;

/**
 * Convenience wrapper to mint a logger bound to a specific area + correlation id.
 *
 * @example
 *   const log = createLogger('ingestion', { activityId, conversationId });
 *   log.info({ filename }, 'received document');
 */
export function createLogger(
  area: string,
  context: Readonly<Record<string, unknown>> = {},
): Logger {
  return rootLogger.child({ area, ...context });
}
