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
import { SharePointServiceFactory } from './services/sharePointServiceFactory';
import { cachedSiteIdLookup, forbiddenSiteKeys } from './services/sharePointService';
import { ClientDirectoryReader } from './services/clientDirectoryReader';
import { ClientResolver } from './services/clientResolver';
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
 * The staff-only quarantine. Its own site path is always forbidden as a
 * client target, whatever FORBIDDEN_TARGET_SITE_PATHS says.
 */
export const quarantineTarget = {
  siteHostname: config.quarantineSiteHostname,
  sitePath: config.quarantineSitePath,
  driveName: config.quarantineDriveName,
  ...(config.quarantineRootFolder ? { rootFolder: config.quarantineRootFolder } : {}),
};

// The Client Directory lives on the BCR GROUP site, so its site id is BCR
// GROUP's: whatever a Directory row's path says, nothing is ever written there.
const bcrGroupSiteIds = [config.clientDirectorySiteId];

/**
 * Client targets: refused when the RESOLVED site is BCR GROUP's collection or
 * the quarantine's, whatever spelling the row's path used. The quarantine's
 * id is looked up on first use and kept; while it can't be looked up, client
 * targets are refused (their documents go to quarantine).
 */
export const clientSharePointFactory = new SharePointServiceFactory(graph, {
  forbiddenSiteIds: bcrGroupSiteIds,
  forbiddenSiteLookups: [cachedSiteIdLookup(graph, quarantineTarget)],
});

/** The quarantine target alone: guarded against BCR GROUP, not against itself. */
export const quarantineSharePointFactory = new SharePointServiceFactory(graph, {
  forbiddenSiteIds: bcrGroupSiteIds,
});

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

export const clientResolver = new ClientResolver(clientDirectory, { quarantineTarget });

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
