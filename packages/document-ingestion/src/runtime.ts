/**
 * Cold-start singletons shared by every HTTP function in this app. Kept in
 * one file so adding a new function is just "import from './runtime'" — no
 * duplicated config loading, Graph client construction, or Directory reader
 * setup.
 */
import { createLogger } from '@bcr/shared';
import { loadIngestionConfig } from './config';
import { AuthMiddleware } from './auth/authMiddleware';
import { createGraphClient } from './services/graphClient';
import { forbiddenSiteKeys } from './services/sharePointService';
import { createSharePointWiring } from './services/sharePointWiring';
import { ClientDirectoryReader } from './services/clientDirectoryReader';
import { ClientResolver } from './services/clientResolver';
import { membershipCheckFor, TeamMembershipReader } from './services/teamMembership';
import { ClassificationService, FallbackClassifier } from './services/classificationService';
import { ClaudeClassifier } from './services/claudeClassifier';
import { BatchIngestor } from './services/batchIngestor';

export const config = loadIngestionConfig();

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

export const classification = new ClassificationService([
  ...(config.anthropicEnabled && config.anthropicApiKey
    ? [
        new ClaudeClassifier({
          apiKey: config.anthropicApiKey,
          model: config.anthropicModel,
          maxContentBytes: config.anthropicMaxContentBytes,
          confidenceThreshold: config.anthropicConfidenceThreshold,
        }),
      ]
    : []),
  new FallbackClassifier(),
]);

export const batchIngestor = new BatchIngestor({
  resolver: clientResolver,
  classification,
  clientSharePointFactory,
  quarantineSharePointFactory,
});
