/**
 * Cold-start singletons shared by every HTTP function in this app. Kept in
 * one file so adding a new function is just "import from './runtime'" — no
 * duplicated config loading, Graph client construction, or Directory reader
 * setup.
 */
import { createLedgerPool, LedgerDb } from '@bcr/ledger-db';
import { createLogger } from '@bcr/shared';
import {
  claudeConfigured,
  loadIngestionConfig,
  RETIRED_SETTINGS,
  retiredSettingsIn,
  searchOffReason,
} from './config';
import { AuthMiddleware } from './auth/authMiddleware';
import { createGraphClient } from './services/graphClient';
import { forbiddenSiteKeys } from './services/sharePointService';
import { createSharePointWiring } from './services/sharePointWiring';
import { ClientDirectoryReader } from './services/clientDirectoryReader';
import { ClientResolver } from './services/clientResolver';
import { membershipCheckFor, TeamMembershipReader } from './services/teamMembership';
import { AcceptancePolicy } from './services/acceptancePolicy';
import { ClassificationService, FallbackClassifier } from './services/classificationService';
import { ClaudeClassifier, classifierFingerprint } from './services/claudeClassifier';
import { BatchIngestor } from './services/batchIngestor';
import { UserTypeReader } from './services/userDirectory';
import { ChannelInbox, MAX_INBOX_FILE_BYTES } from './services/channelInbox';
import { INDEX_OFF, LedgerDocumentIndex, type DocumentIndex } from './services/documentIndex';
import { TablePaidClassifications, TableShadowMemo } from './services/shadowMemo';
import { LedgerReviewNotices, ReviewNotifier, WorkflowsWebhook } from './services/reviewNotifier';
import { ClientSearchService } from './services/clientSearch';
import {
  SEARCH_MODEL,
  SearchInterpreter,
  searchInterpreterFingerprint,
} from './services/searchInterpreter';

export const config = loadIngestionConfig();

// A retired setting is never read. Named once per cold start so the operator
// removes it (its value is not logged).
for (const name of retiredSettingsIn()) {
  createLogger('ingestion/runtime').warn(
    { event: 'config.retired_setting', setting: name, replacedBy: RETIRED_SETTINGS[name] },
    'config.retired_setting',
  );
}

export const auth = new AuthMiddleware({
  tenantId: config.azureTenantId,
  expectedAudience: config.expectedAudience,
});

export const graph = createGraphClient();

/**
 * The staff-only quarantine and the two SharePoint factories: client targets
 * may never resolve to BCR GROUP or the quarantine; the quarantine may never
 * resolve to BCR GROUP. See services/sharePointWiring.ts.
 */
const sharePoint = createSharePointWiring(graph, config);
export const { quarantineTarget, clientSharePointFactory, quarantineSharePointFactory } =
  sharePoint;
const bcrGroupSiteIds = sharePoint.bcrGroupSiteIds;

// Once per cold start, so an operator can see the guard is on and which
// collection it holds (a GUID, not a name). The quarantine's collection is
// added for client targets when it is first looked up.
createLogger('ingestion/runtime').info(
  { event: 'sharepoint.guarded_sites', siteCollectionIds: [...forbiddenSiteKeys(bcrGroupSiteIds)] },
  'sharepoint.guarded_sites',
);

export const clientDirectory = new ClientDirectoryReader(graph, {
  siteId: config.clientDirectorySiteId,
  listId: config.clientDirectoryListId,
  cacheTtlMs: config.clientDirectoryCacheTtlMs,
  maxStaleMs: config.clientDirectoryMaxStaleMs,
  forbiddenSitePaths: [...config.forbiddenTargetSitePaths, config.quarantineSitePath],
  // Every client site lives on the tenant's one SharePoint host — the same
  // host as the quarantine site. A row naming any other host routes nobody.
  allowedSiteHostname: config.quarantineSiteHostname,
});

/**
 * The uploader's Teams, read from Entra as the managed identity (needs the
 * Graph application permission granted by
 * infrastructure/identity/grant-ingestion-membership-read.sh). `off` logs
 * `membership.check_off` here, once per cold start.
 */
export const teamMembership = new TeamMembershipReader(graph);

export const clientResolver = new ClientResolver(clientDirectory, {
  quarantineTarget,
  membership: membershipCheckFor(config.membershipCheckMode, teamMembership),
});

/**
 * Claude (when enabled and keyed), then the fallback; every result then goes
 * through the acceptance policy, the one place `CLASSIFICATION_ACCEPT_THRESHOLD`
 * and the review reasons are applied. Said once per cold start: the model and
 * the threshold, never the key.
 */
const claudeOn = claudeConfigured(config);
export const classification = new ClassificationService(
  [
    ...(claudeOn
      ? [
          new ClaudeClassifier({
            apiKey: config.anthropicApiKey,
            model: config.anthropicModel,
            effort: config.anthropicEffort,
            thinking: config.anthropicThinking,
            maxContentBytes: config.anthropicMaxContentBytes,
          }),
        ]
      : []),
    new FallbackClassifier(),
  ],
  { policy: new AcceptancePolicy(config.classificationAcceptThreshold) },
);
/** What decides a classification besides the document: see `classifierFingerprint`. */
const classifierRelease = `${
  claudeOn
    ? classifierFingerprint(config.anthropicModel, config.anthropicEffort, config.anthropicThinking)
    : 'fallback'
}|${config.classificationAcceptThreshold}`;
createLogger('ingestion/runtime').info(
  {
    event: 'classification.config',
    release: classifierRelease,
    claude: claudeOn ? 'on' : 'off',
    model: claudeOn ? config.anthropicModel : '',
    ...(claudeOn ? { effort: config.anthropicEffort, thinking: config.anthropicThinking } : {}),
    acceptThreshold: config.classificationAcceptThreshold,
  },
  'classification.config',
);

/**
 * The document index (`LEDGER_INDEX_MODE`). `off`: no pool, no connection,
 * nothing written. `write`: a small pool that logs in as this app's managed
 * identity (an Entra token per connection, TLS verified), and every filed
 * document recorded in a transaction scoped to its client. Said once per
 * cold start: the mode, the server and the login, never a token.
 */
const ledgerDb =
  config.ledgerIndexMode === 'write'
    ? new LedgerDb(
        createLedgerPool({
          host: config.ledgerDbHost,
          database: config.ledgerDbName,
          user: config.ledgerDbUser,
        }),
      )
    : undefined;
export const documentIndex: DocumentIndex = ledgerDb
  ? new LedgerDocumentIndex({ db: ledgerDb, directoryListId: config.clientDirectoryListId })
  : INDEX_OFF;
createLogger('ingestion/runtime').info(
  {
    event: 'index.config',
    mode: config.ledgerIndexMode,
    ...(config.ledgerIndexMode === 'write'
      ? { host: config.ledgerDbHost, database: config.ledgerDbName, user: config.ledgerDbUser }
      : {}),
  },
  'index.config',
);

export const batchIngestor = new BatchIngestor({
  resolver: clientResolver,
  classification,
  clientSharePointFactory,
  quarantineSharePointFactory,
  index: documentIndex,
});

/**
 * The channel-inbox sweep (functions/inboxSweep.ts). It files client uploads
 * inside each bound row's channel folder through the CLIENT factory, whose
 * guard refuses BCR GROUP and the quarantine. `INBOX_SWEEP_MODE` is said once
 * per cold start when it is not `off`, with the row allow-list and cutoff.
 *
 * Its user and Team readers are its own, with the Graph SDK's retries off
 * (as are its SharePoint calls): a tick must end well inside the timer's
 * 5-minute limit, and the SDK would sleep through `Retry-After` for minutes.
 * The upload path keeps its reader, cache and retries as they were.
 *
 * In `shadow`, what was reported is kept in the host's storage account under
 * this classifier release, so a restart does not pay to classify it again; in
 * `enforce`, how many paid classifications each file version has had, at most
 * `MAX_PAID_CLASSIFICATIONS` across restarts.
 */
const shadowMemo =
  config.inboxSweepMode === 'shadow' && config.webJobsStorage !== ''
    ? TableShadowMemo.fromConnectionString(config.webJobsStorage, classifierRelease)
    : undefined;
const paidClassifications =
  config.inboxSweepMode === 'enforce' && config.webJobsStorage !== ''
    ? TablePaidClassifications.fromConnectionString(config.webJobsStorage, classifierRelease)
    : undefined;
export const channelInbox = new ChannelInbox({
  mode: config.inboxSweepMode,
  directory: clientDirectory,
  sharePointFactory: clientSharePointFactory,
  users: new UserTypeReader(graph, { sdkRetries: false }),
  membership: new TeamMembershipReader(graph, { sdkRetries: false }),
  classification,
  minAgeMs: config.inboxMinAgeMs,
  maxFilesPerTick: config.inboxMaxFilesPerTick,
  // Only the classifier reads the bytes, and it reads no more than this.
  maxDownloadBytes: Math.min(config.anthropicMaxContentBytes, MAX_INBOX_FILE_BYTES),
  onlyRows: config.inboxSweepRows,
  ...(config.inboxCreatedAfter !== undefined ? { createdAfterMs: config.inboxCreatedAfter } : {}),
  // Written only after a move, so never in shadow.
  index: documentIndex,
  ...(shadowMemo ? { shadowMemo } : {}),
  ...(paidClassifications ? { paidClassifications } : {}),
});
if (config.inboxSweepMode !== 'off') {
  createLogger('ingestion/runtime').info(
    {
      event: 'inbox.sweep_mode',
      mode: config.inboxSweepMode,
      ...(config.inboxSweepMode === 'shadow'
        ? { shadowMemo: shadowMemo ? 'table' : 'worker_memory' }
        : {}),
      ...(config.inboxSweepMode === 'enforce'
        ? { paidClassifications: paidClassifications ? 'table' : 'worker_memory' }
        : {}),
      rows: config.inboxSweepRows.length ? config.inboxSweepRows : 'all',
      createdAfter:
        config.inboxCreatedAfter !== undefined
          ? new Date(config.inboxCreatedAfter).toISOString()
          : 'none',
    },
    'inbox.sweep_mode',
  );
}

/**
 * Review notices to the staff chat (functions/reviewNotify.ts), read from the
 * document index: on only when the index writes and `REVIEW_WEBHOOK_URL`
 * resolved to an https URL (a Key Vault reference that did not resolve stays
 * the literal reference: off). Said once per cold start, with the reason when
 * off; the URL is never logged.
 */
const reviewNoticesOff = !ledgerDb
  ? 'index_off'
  : config.reviewWebhookUrl === ''
    ? 'no_webhook'
    : !config.reviewWebhookUrl.startsWith('https://')
      ? 'webhook_unresolved'
      : undefined;
export const reviewNotifier: ReviewNotifier | undefined =
  ledgerDb && !reviewNoticesOff
    ? new ReviewNotifier({
        directory: clientDirectory,
        source: new LedgerReviewNotices({
          db: ledgerDb,
          directoryListId: config.clientDirectoryListId,
        }),
        poster: new WorkflowsWebhook(config.reviewWebhookUrl),
      })
    : undefined;
createLogger('ingestion/runtime').info(
  {
    event: 'review_notice.config',
    mode: reviewNotifier ? 'on' : 'off',
    ...(reviewNoticesOff ? { reason: reviewNoticesOff } : {}),
  },
  'review_notice.config',
);

/**
 * Client search (functions/clientSearch.ts, `POST /api/search`), for the bot
 * Function App's managed identity only. On only when `SEARCH_MODE=on`, the
 * index writes, Claude is configured, `SEARCH_CALLER_APP_IDS` is set and
 * shares no id with `BOT_CALLER_APP_IDS`, and the membership check enforces;
 * otherwise every search answers `disabled`, and nothing here stops
 * ingestion. The client is resolved by the uploads' own `clientResolver`.
 * Said once per cold start: on or off with the reason, the rows, the model
 * and the prompt's fingerprint; never a key.
 *
 * Its user-type reader is its own, with the Graph SDK's retries off (bounded
 * retries of ours): the guest waits in the chat, and the bot gives up after 20 s.
 */
const searchOff = searchOffReason(config);
export const clientSearch = new ClientSearchService({
  ...(searchOff ? { offReason: searchOff } : {}),
  resolver: clientResolver,
  userTypes: new UserTypeReader(graph, { sdkRetries: false }),
  ...(ledgerDb && !searchOff ? { db: ledgerDb } : {}),
  ...(claudeOn && !searchOff
    ? { interpreter: new SearchInterpreter({ apiKey: config.anthropicApiKey }) }
    : {}),
  directoryListId: config.clientDirectoryListId,
  searchRows: config.searchRows,
});
createLogger('ingestion/runtime').info(
  {
    event: 'search.config',
    mode: clientSearch.enabled ? 'on' : 'off',
    ...(searchOff ? { reason: searchOff } : {}),
    ...(clientSearch.enabled
      ? {
          rows: config.searchRows.length ? config.searchRows : 'all',
          model: SEARCH_MODEL,
          prompt: searchInterpreterFingerprint(),
        }
      : {}),
  },
  'search.config',
);
