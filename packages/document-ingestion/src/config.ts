import {
  type IngestionConfig,
  ingestionConfigSchema,
  loadConfig,
  missingLedgerIndexSettings,
  ValidationError,
} from '@bcr/shared';

const envMap = {
  azureTenantId: 'AZURE_TENANT_ID',
  ingestionAppId: 'INGESTION_APP_ID',
  expectedAudience: 'EXPECTED_AUDIENCE',
  expectedRoles: 'EXPECTED_ROLES',
  botCallerAppIds: 'BOT_CALLER_APP_IDS',
  clientDirectorySiteId: 'CLIENT_DIRECTORY_SITE_ID',
  clientDirectoryListId: 'CLIENT_DIRECTORY_LIST_ID',
  clientDirectoryCacheTtlMs: 'CLIENT_DIRECTORY_CACHE_TTL_MS',
  clientDirectoryMaxStaleMs: 'CLIENT_DIRECTORY_MAX_STALE_MS',
  quarantineSiteHostname: 'QUARANTINE_SITE_HOSTNAME',
  quarantineSitePath: 'QUARANTINE_SITE_PATH',
  quarantineDriveName: 'QUARANTINE_DRIVE_NAME',
  quarantineRootFolder: 'QUARANTINE_ROOT_FOLDER',
  forbiddenTargetSitePaths: 'FORBIDDEN_TARGET_SITE_PATHS',
  membershipCheckMode: 'MEMBERSHIP_CHECK_MODE',
  inboxSweepMode: 'INBOX_SWEEP_MODE',
  inboxMinAgeMs: 'INBOX_MIN_AGE_MS',
  inboxMaxFilesPerTick: 'INBOX_MAX_FILES_PER_TICK',
  inboxSweepRows: 'INBOX_SWEEP_ROWS',
  inboxCreatedAfter: 'INBOX_CREATED_AFTER',
  anthropicEnabled: 'ANTHROPIC_ENABLED',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
  anthropicMaxContentBytes: 'ANTHROPIC_MAX_CONTENT_BYTES',
  classificationAcceptThreshold: 'CLASSIFICATION_ACCEPT_THRESHOLD',
  ledgerIndexMode: 'LEDGER_INDEX_MODE',
  ledgerDbHost: 'LEDGER_DB_HOST',
  ledgerDbName: 'LEDGER_DB_NAME',
  ledgerDbUser: 'LEDGER_DB_USER',
  applicationInsightsConnectionString: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
  logLevel: 'LOG_LEVEL',
} as const satisfies Record<keyof IngestionConfig, string>;

/**
 * Settings this build no longer reads, with what replaced them. Still set on
 * a running app, each is named in a warning at cold start so the operator
 * removes it; none is ever read, so none can change behaviour.
 */
export const RETIRED_SETTINGS: Readonly<Record<string, string>> = {
  // Not an alias: the live app carries 0.6 there, below the new minimum of
  // 0.70, and reading it would stop ingestion at cold start.
  ANTHROPIC_CONFIDENCE_THRESHOLD: 'CLASSIFICATION_ACCEPT_THRESHOLD (0.70-0.95, default 0.70)',
};

/** The retired settings that are still set (non-empty) in `env`, by name only. */
export function retiredSettingsIn(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(RETIRED_SETTINGS).filter((name) => (env[name] ?? '').trim() !== '');
}

let cached: IngestionConfig | undefined;

export function loadIngestionConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
  if (!cached) {
    const config = loadConfig(ingestionConfigSchema, envMap, env);
    // `write` without a server or a login would fail at the first filing,
    // every filing: it fails here, at cold start, naming what is missing.
    const missing = missingLedgerIndexSettings(config);
    if (missing.length > 0) {
      throw new ValidationError(
        `Invalid configuration: ${missing
          .map((name) => `${name}: required when LEDGER_INDEX_MODE=write`)
          .join('; ')}`,
      );
    }
    cached = config;
  }
  return cached;
}

/** For tests only. */
export function _resetConfigCache(): void {
  cached = undefined;
}
