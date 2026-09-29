import {
  type IngestionConfig,
  ingestionConfigSchema,
  loadConfig,
  missingLedgerIndexSettings,
  thinkingDisabledProblem,
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
  anthropicEffort: 'ANTHROPIC_EFFORT',
  anthropicThinking: 'ANTHROPIC_THINKING',
  anthropicMaxContentBytes: 'ANTHROPIC_MAX_CONTENT_BYTES',
  classificationAcceptThreshold: 'CLASSIFICATION_ACCEPT_THRESHOLD',
  ledgerIndexMode: 'LEDGER_INDEX_MODE',
  ledgerDbHost: 'LEDGER_DB_HOST',
  ledgerDbName: 'LEDGER_DB_NAME',
  ledgerDbUser: 'LEDGER_DB_USER',
  webJobsStorage: 'AzureWebJobsStorage',
  reviewWebhookUrl: 'REVIEW_WEBHOOK_URL',
  searchMode: 'SEARCH_MODE',
  searchRows: 'SEARCH_ROWS',
  searchCallerAppIds: 'SEARCH_CALLER_APP_IDS',
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

/** Whether classification may call Claude: enabled, and a key to call it with. */
export function claudeConfigured(
  config: Pick<IngestionConfig, 'anthropicEnabled' | 'anthropicApiKey'>,
): boolean {
  return config.anthropicEnabled && config.anthropicApiKey !== '';
}

/**
 * Why client search (`POST /api/search`) is off, or `undefined` when it may
 * run. Said once at cold start (`search.config`), shown in `/api/health`
 * (`build.search`), and every search answers `disabled` while it holds:
 *
 *  - `mode_off`: `SEARCH_MODE=off` (the default);
 *  - `bad_rows`: a `SEARCH_ROWS` entry is not a list item id (a whole number):
 *    a typo keeps search off, never opens it wider;
 *  - `bad_callers`: a `SEARCH_CALLER_APP_IDS` entry is not an app id (a GUID);
 *  - `index_off`: `LEDGER_INDEX_MODE` is not `write`, so there is nothing to search;
 *  - `claude_off`: no model to read a question with (`ANTHROPIC_ENABLED`, the key);
 *  - `no_callers`: `SEARCH_CALLER_APP_IDS` is empty, so nobody may call the route;
 *  - `caller_overlap`: an app id is on both `SEARCH_CALLER_APP_IDS` and
 *    `BOT_CALLER_APP_IDS`: the bot registration's secret, which files documents,
 *    must never also read them;
 *  - `membership_off`: `MEMBERSHIP_CHECK_MODE` is not `enforce`: search has no
 *    way round the check that keeps an account in two clients' Teams out.
 *
 * None of these stops ingestion's cold start: filing does not depend on search.
 */
const LIST_ITEM_ID = /^[1-9][0-9]*$/;
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchOffReason =
  | 'mode_off'
  | 'bad_rows'
  | 'bad_callers'
  | 'index_off'
  | 'claude_off'
  | 'no_callers'
  | 'caller_overlap'
  | 'membership_off';

export function searchOffReason(
  config: Pick<
    IngestionConfig,
    | 'searchMode'
    | 'searchRows'
    | 'ledgerIndexMode'
    | 'anthropicEnabled'
    | 'anthropicApiKey'
    | 'searchCallerAppIds'
    | 'botCallerAppIds'
    | 'membershipCheckMode'
  >,
): SearchOffReason | undefined {
  if (config.searchMode !== 'on') return 'mode_off';
  if (!config.searchRows.every((id) => LIST_ITEM_ID.test(id))) return 'bad_rows';
  if (!config.searchCallerAppIds.every((id) => APP_ID.test(id))) return 'bad_callers';
  if (config.ledgerIndexMode !== 'write') return 'index_off';
  if (!claudeConfigured(config)) return 'claude_off';
  if (config.searchCallerAppIds.length === 0) return 'no_callers';
  const botCallers = new Set(config.botCallerAppIds.map((id) => id.trim().toLowerCase()));
  if (config.searchCallerAppIds.some((id) => botCallers.has(id.trim().toLowerCase()))) {
    return 'caller_overlap';
  }
  if (config.membershipCheckMode !== 'enforce') return 'membership_off';
  return undefined;
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
    // A model that refuses disabled thinking would answer every call with a
    // 400, and every document would go to review unclassified.
    const thinking = thinkingDisabledProblem(config);
    if (thinking) throw new ValidationError(`Invalid configuration: ${thinking}`);
    cached = config;
  }
  return cached;
}

/** For tests only. */
export function _resetConfigCache(): void {
  cached = undefined;
}
