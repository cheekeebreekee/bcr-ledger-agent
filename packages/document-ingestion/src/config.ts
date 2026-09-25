import { type IngestionConfig, ingestionConfigSchema, loadConfig } from '@bcr/shared';

const envMap = {
  azureTenantId: 'AZURE_TENANT_ID',
  ingestionAppId: 'INGESTION_APP_ID',
  expectedAudience: 'EXPECTED_AUDIENCE',
  expectedRoles: 'EXPECTED_ROLES',
  clientDirectorySiteId: 'CLIENT_DIRECTORY_SITE_ID',
  clientDirectoryListId: 'CLIENT_DIRECTORY_LIST_ID',
  clientDirectoryCacheTtlMs: 'CLIENT_DIRECTORY_CACHE_TTL_MS',
  fallbackClientId: 'FALLBACK_CLIENT_ID',
  fallbackSiteHostname: 'FALLBACK_SITE_HOSTNAME',
  fallbackSitePath: 'FALLBACK_SITE_PATH',
  fallbackDriveName: 'FALLBACK_DRIVE_NAME',
  fallbackRootFolder: 'FALLBACK_ROOT_FOLDER',
  anthropicEnabled: 'ANTHROPIC_ENABLED',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
  anthropicMaxContentBytes: 'ANTHROPIC_MAX_CONTENT_BYTES',
  anthropicConfidenceThreshold: 'ANTHROPIC_CONFIDENCE_THRESHOLD',
  applicationInsightsConnectionString: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
  logLevel: 'LOG_LEVEL',
} as const satisfies Record<keyof IngestionConfig, string>;

let cached: IngestionConfig | undefined;

export function loadIngestionConfig(env: NodeJS.ProcessEnv = process.env): IngestionConfig {
  if (!cached) {
    cached = loadConfig(ingestionConfigSchema, envMap, env);
  }
  return cached;
}

/** For tests only. */
export function _resetConfigCache(): void {
  cached = undefined;
}
