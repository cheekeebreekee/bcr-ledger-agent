import { botConfigSchema, ingestionConfigSchema, loadConfig } from './config';

const botEnvMap = {
  microsoftAppId: 'MICROSOFT_APP_ID',
  microsoftAppPassword: 'MICROSOFT_APP_PASSWORD',
  microsoftAppTenantId: 'MICROSOFT_APP_TENANT_ID',
  microsoftAppType: 'MICROSOFT_APP_TYPE',
  ingestionBaseUrl: 'INGESTION_BASE_URL',
  ingestionScope: 'INGESTION_SCOPE',
  applicationInsightsConnectionString: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
  logLevel: 'LOG_LEVEL',
} as const;

const ingestionEnvMap = {
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
} as const;

const validUuid = '00000000-0000-0000-0000-000000000000';

describe('botConfigSchema', () => {
  it('loads a valid env', () => {
    const env = {
      MICROSOFT_APP_ID: validUuid,
      MICROSOFT_APP_PASSWORD: 'secret',
      MICROSOFT_APP_TENANT_ID: validUuid,
      INGESTION_BASE_URL: 'http://localhost:7071',
      INGESTION_SCOPE: 'api://app/.default',
    } as NodeJS.ProcessEnv;
    const cfg = loadConfig(botConfigSchema, botEnvMap, env);
    expect(cfg.microsoftAppId).toBe(validUuid);
    expect(cfg.microsoftAppType).toBe('MultiTenant');
    expect(cfg.logLevel).toBe('info');
  });

  it('rejects a non-UUID app id with a helpful message', () => {
    const env = {
      MICROSOFT_APP_ID: 'not-a-uuid',
      MICROSOFT_APP_PASSWORD: 'secret',
      MICROSOFT_APP_TENANT_ID: validUuid,
      INGESTION_BASE_URL: 'http://localhost:7071',
      INGESTION_SCOPE: 'api://app/.default',
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig(botConfigSchema, botEnvMap, env)).toThrow(/MICROSOFT_APP_ID/);
  });
});

describe('ingestionConfigSchema', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    AZURE_TENANT_ID: validUuid,
    INGESTION_APP_ID: validUuid,
    EXPECTED_AUDIENCE: 'api://ingestion-app',
    SHAREPOINT_SITE_HOSTNAME: 'contoso.sharepoint.com',
    SHAREPOINT_SITE_PATH: '/sites/BCR',
  };

  it('parses defaults correctly', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, baseEnv);
    expect(cfg.sharepointDriveName).toBe('Documents');
    expect(cfg.expectedRoles).toEqual(['Documents.Ingest']);
    expect(cfg.anthropicEnabled).toBe(false);
    expect(cfg.anthropicModel).toBe('claude-opus-4-5-20251101');
    expect(cfg.anthropicMaxContentBytes).toBe(10 * 1024 * 1024);
    expect(cfg.anthropicConfidenceThreshold).toBe(0.6);
  });

  it('parses a CSV roles list', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      EXPECTED_ROLES: 'Documents.Ingest, Documents.Admin , ',
    });
    expect(cfg.expectedRoles).toEqual(['Documents.Ingest', 'Documents.Admin']);
  });

  it('interprets boolean-ish flags', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      ANTHROPIC_ENABLED: 'true',
    });
    expect(cfg.anthropicEnabled).toBe(true);
  });

  it('parses numeric overrides', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      ANTHROPIC_MAX_CONTENT_BYTES: '2048',
      ANTHROPIC_CONFIDENCE_THRESHOLD: '0.8',
    });
    expect(cfg.anthropicMaxContentBytes).toBe(2048);
    expect(cfg.anthropicConfidenceThreshold).toBe(0.8);
  });

  it('rejects a non-numeric threshold', () => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        ANTHROPIC_CONFIDENCE_THRESHOLD: 'abc',
      }),
    ).toThrow(/ANTHROPIC_CONFIDENCE_THRESHOLD/);
  });

  it('rejects a site path that does not start with /', () => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        SHAREPOINT_SITE_PATH: 'sites/BCR',
      }),
    ).toThrow(/start with \//);
  });
});
