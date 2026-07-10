import { type IngestionConfig, ingestionConfigSchema, loadConfig } from '@bcr/shared';

const envMap = {
  azureTenantId: 'AZURE_TENANT_ID',
  ingestionAppId: 'INGESTION_APP_ID',
  expectedAudience: 'EXPECTED_AUDIENCE',
  expectedRoles: 'EXPECTED_ROLES',
  sharepointSiteHostname: 'SHAREPOINT_SITE_HOSTNAME',
  sharepointSitePath: 'SHAREPOINT_SITE_PATH',
  sharepointDriveName: 'SHAREPOINT_DRIVE_NAME',
  sharepointRootFolder: 'SHAREPOINT_ROOT_FOLDER',
  anthropicEnabled: 'ANTHROPIC_ENABLED',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
  anthropicMaxContentBytes: 'ANTHROPIC_MAX_CONTENT_BYTES',
  anthropicConfidenceThreshold: 'ANTHROPIC_CONFIDENCE_THRESHOLD',
  clientCompanyName: 'CLIENT_COMPANY_NAME',
  clientNip: 'CLIENT_NIP',
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
