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

export const config = loadIngestionConfig();

export const auth = new AuthMiddleware({
  tenantId: config.azureTenantId,
  expectedAudience: config.expectedAudience,
  expectedRoles: config.expectedRoles,
});

export const graph = createGraphClient();

export const sharePointFactory = new SharePointServiceFactory(graph);

export const clientDirectory = new ClientDirectoryReader(graph, {
  siteId: config.clientDirectorySiteId,
  listId: config.clientDirectoryListId,
  cacheTtlMs: config.clientDirectoryCacheTtlMs,
});

export const quarantineTarget = {
  siteHostname: config.quarantineSiteHostname,
  sitePath: config.quarantineSitePath,
  driveName: config.quarantineDriveName,
  ...(config.quarantineRootFolder ? { rootFolder: config.quarantineRootFolder } : {}),
};

export const clientResolver = new ClientResolver(clientDirectory, {
  fallbackTarget: quarantineTarget,
  fallbackClientId: 'quarantine',
  fallbackTitle: 'BCR quarantine',
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
