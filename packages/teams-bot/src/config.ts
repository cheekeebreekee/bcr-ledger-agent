import { type BotConfig, botConfigSchema, loadConfig } from '@bcr/shared';

/**
 * Map environment variables → config keys. Centralised here so any rename
 * (env or schema) happens in exactly one place.
 */
const envMap = {
  microsoftAppId: 'MICROSOFT_APP_ID',
  microsoftAppPassword: 'MICROSOFT_APP_PASSWORD',
  microsoftAppTenantId: 'MICROSOFT_APP_TENANT_ID',
  microsoftAppType: 'MICROSOFT_APP_TYPE',
  ingestionBaseUrl: 'INGESTION_BASE_URL',
  ingestionScope: 'INGESTION_SCOPE',
  botGateMode: 'BOT_GATE_MODE',
  applicationInsightsConnectionString: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
  logLevel: 'LOG_LEVEL',
} as const satisfies Record<keyof BotConfig, string>;

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return loadConfig(botConfigSchema, envMap, env);
}
