/**
 * Cold-start singletons shared by every HTTP function in this app. Kept in
 * one file so adding a new function is just "import from './runtime'" — no
 * duplicated config loading, Graph client construction, or Directory reader
 * setup.
 */
import { loadIngestionConfig } from './config';
import { AuthMiddleware } from './auth/authMiddleware';
import { createGraphClient } from './services/graphClient';
import { SharePointServiceFactory } from './services/sharePointServiceFactory';
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

// The Client Directory lives on the BCR GROUP site, so its site id is BCR
// GROUP's: whatever a Directory row's path says, nothing is ever written there.
export const sharePointFactory = new SharePointServiceFactory(graph, {
  forbiddenSiteIds: [config.clientDirectorySiteId],
});

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
  sharePointFactory,
});
