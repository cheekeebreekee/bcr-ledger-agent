/**
 * Cold-start singletons shared by every HTTP function in this app. Kept in
 * one file so adding a new function is just "import from './runtime'" — no
 * duplicated config loading, Graph client construction, or Directory reader
 * setup.
 */
import { createLedgerPool, LedgerDb } from '@bcr/ledger-db';
import { createLogger } from '@bcr/shared';
import { loadIngestionConfig, RETIRED_SETTINGS, retiredSettingsIn } from './config';
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
import { TableShadowMemo } from './services/shadowMemo';

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
const claudeOn = config.anthropicEnabled && config.anthropicApiKey !== '';
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
export const documentIndex: DocumentIndex =
  config.ledgerIndexMode === 'write'
    ? new LedgerDocumentIndex({
        db: new LedgerDb(
          createLedgerPool({
            host: config.ledgerDbHost,
            database: config.ledgerDbName,
            user: config.ledgerDbUser,
          }),
        ),
        directoryListId: config.clientDirectoryListId,
      })
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
 * this classifier release, so a restart does not pay to classify it again.
 */
const shadowMemo =
  config.inboxSweepMode === 'shadow' && config.webJobsStorage !== ''
    ? TableShadowMemo.fromConnectionString(config.webJobsStorage, classifierRelease)
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
});
if (config.inboxSweepMode !== 'off') {
  createLogger('ingestion/runtime').info(
    {
      event: 'inbox.sweep_mode',
      mode: config.inboxSweepMode,
      ...(config.inboxSweepMode === 'shadow'
        ? { shadowMemo: shadowMemo ? 'table' : 'worker_memory' }
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
