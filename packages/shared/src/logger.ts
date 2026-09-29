import pino from 'pino';

/**
 * Process-wide logger. Uses Pino for structured JSON output that
 * Application Insights ingests verbatim (the connector parses any JSON
 * line on stdout and maps recognised fields like `level` and `msg`).
 *
 * Each functional area should create a child logger with `.child({ area })`
 * so logs can be filtered without losing context.
 */
export function createRootLogger(destination?: pino.DestinationStream): pino.Logger {
  return pino(rootLoggerOptions(), destination ?? pino.destination(1));
}

function rootLoggerOptions(): pino.LoggerOptions {
  return {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    app: 'bcr-ledger-agent',
    env: process.env.NODE_ENV ?? 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Secrets, plus the client data that turned App Insights into a register of
  // every client's uploads: file names (KSeF names embed a NIP), SharePoint
  // locations, client titles, extracted parties, invoice fields. Logs carry ids instead
  // (documentId, clientId, listItemId, driveItemId). A user's UPN is redacted
  // too: a client account's is `{NIP}@bcr-group.pl`. Pino redacts one level
  // deep with `*.x`; top-level keys are listed explicitly.
  redact: {
    paths: [
      '*.password',
      '*.secret',
      '*.token',
      '*.authorization',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'filename',
      '*.filename',
      'fileName',
      '*.fileName',
      'originalFilename',
      '*.originalFilename',
      'webUrl',
      '*.webUrl',
      'fullPath',
      '*.fullPath',
      'sitePath',
      '*.sitePath',
      'title',
      '*.title',
      'parties',
      '*.parties',
      'nip',
      '*.nip',
      'extraction',
      '*.extraction',
      'userPrincipalName',
      '*.userPrincipalName',
      'upn',
      '*.upn',
    ],
    censor: '[REDACTED]',
  },
  };
}

export const rootLogger = createRootLogger();

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
