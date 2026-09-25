import { botConfigSchema, ingestionConfigSchema, loadConfig } from './config';

const botEnvMap = {
  microsoftAppId: 'MICROSOFT_APP_ID',
  microsoftAppPassword: 'MICROSOFT_APP_PASSWORD',
  microsoftAppTenantId: 'MICROSOFT_APP_TENANT_ID',
  microsoftAppType: 'MICROSOFT_APP_TYPE',
  ingestionBaseUrl: 'INGESTION_BASE_URL',
  ingestionScope: 'INGESTION_SCOPE',
  botGateMode: 'BOT_GATE_MODE',
  applicationInsightsConnectionString: 'APPLICATIONINSIGHTS_CONNECTION_STRING',
  logLevel: 'LOG_LEVEL',
} as const;

const ingestionEnvMap = {
  azureTenantId: 'AZURE_TENANT_ID',
  ingestionAppId: 'INGESTION_APP_ID',
  expectedAudience: 'EXPECTED_AUDIENCE',
  expectedRoles: 'EXPECTED_ROLES',
  botCallerAppIds: 'BOT_CALLER_APP_IDS',
  clientDirectorySiteId: 'CLIENT_DIRECTORY_SITE_ID',
  clientDirectoryListId: 'CLIENT_DIRECTORY_LIST_ID',
  clientDirectoryCacheTtlMs: 'CLIENT_DIRECTORY_CACHE_TTL_MS',
  clientDirectoryMaxStaleMs: 'CLIENT_DIRECTORY_MAX_STALE_MS',
  quarantineSiteHostname: 'QUARANTINE_SITE_HOSTNAME',
  quarantineSitePath: 'QUARANTINE_SITE_PATH',
  quarantineDriveName: 'QUARANTINE_DRIVE_NAME',
  quarantineRootFolder: 'QUARANTINE_ROOT_FOLDER',
  forbiddenTargetSitePaths: 'FORBIDDEN_TARGET_SITE_PATHS',
  anthropicEnabled: 'ANTHROPIC_ENABLED',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
  anthropicMaxContentBytes: 'ANTHROPIC_MAX_CONTENT_BYTES',
  anthropicConfidenceThreshold: 'ANTHROPIC_CONFIDENCE_THRESHOLD',
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
      MICROSOFT_APP_TYPE: 'SingleTenant',
    } as NodeJS.ProcessEnv;
    const cfg = loadConfig(botConfigSchema, botEnvMap, env);
    expect(cfg.microsoftAppId).toBe(validUuid);
    expect(cfg.microsoftAppType).toBe('SingleTenant');
    expect(cfg.botGateMode).toBe('enforce');
    expect(cfg.logLevel).toBe('info');
  });

  it('requires MICROSOFT_APP_TYPE rather than defaulting to MultiTenant', () => {
    const env = {
      MICROSOFT_APP_ID: validUuid,
      MICROSOFT_APP_PASSWORD: 'secret',
      MICROSOFT_APP_TENANT_ID: validUuid,
      INGESTION_BASE_URL: 'http://localhost:7071',
      INGESTION_SCOPE: 'api://app/.default',
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig(botConfigSchema, botEnvMap, env)).toThrow(/MICROSOFT_APP_TYPE/);
  });

  it('accepts BOT_GATE_MODE=log and rejects anything else', () => {
    const base = {
      MICROSOFT_APP_ID: validUuid,
      MICROSOFT_APP_PASSWORD: 'secret',
      MICROSOFT_APP_TENANT_ID: validUuid,
      INGESTION_BASE_URL: 'http://localhost:7071',
      INGESTION_SCOPE: 'api://app/.default',
      MICROSOFT_APP_TYPE: 'SingleTenant',
    } as NodeJS.ProcessEnv;
    expect(loadConfig(botConfigSchema, botEnvMap, { ...base, BOT_GATE_MODE: 'log' }).botGateMode).toBe(
      'log',
    );
    expect(() => loadConfig(botConfigSchema, botEnvMap, { ...base, BOT_GATE_MODE: 'off' })).toThrow(
      /BOT_GATE_MODE/,
    );
  });

  it('rejects a non-UUID app id with a helpful message', () => {
    const env = {
      MICROSOFT_APP_ID: 'not-a-uuid',
      MICROSOFT_APP_PASSWORD: 'secret',
      MICROSOFT_APP_TENANT_ID: validUuid,
      INGESTION_BASE_URL: 'http://localhost:7071',
      INGESTION_SCOPE: 'api://app/.default',
      MICROSOFT_APP_TYPE: 'SingleTenant',
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig(botConfigSchema, botEnvMap, env)).toThrow(/MICROSOFT_APP_ID/);
  });
});

describe('ingestionConfigSchema', () => {
  const validListUuid = '11111111-1111-1111-1111-111111111111';
  const baseEnv: NodeJS.ProcessEnv = {
    AZURE_TENANT_ID: validUuid,
    INGESTION_APP_ID: validUuid,
    EXPECTED_AUDIENCE: 'api://ingestion-app',
    CLIENT_DIRECTORY_SITE_ID: 'contoso.sharepoint.com,site-guid,web-guid',
    CLIENT_DIRECTORY_LIST_ID: validListUuid,
    BOT_CALLER_APP_IDS: validUuid,
    QUARANTINE_SITE_HOSTNAME: 'contoso.sharepoint.com',
    QUARANTINE_SITE_PATH: '/sites/BCRLedgerKwarantanna',
    FORBIDDEN_TARGET_SITE_PATHS: '/sites/BCRGROUP',
  };

  it('parses defaults correctly', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, baseEnv);
    expect(cfg.quarantineDriveName).toBe('Documents');
    expect(cfg.quarantineRootFolder).toBe('Kwarantanna');
    expect(cfg.botCallerAppIds).toEqual([validUuid]);
    expect(cfg.forbiddenTargetSitePaths).toEqual(['/sites/BCRGROUP']);
    expect(cfg.clientDirectoryCacheTtlMs).toBe(5 * 60 * 1000);
    expect(cfg.clientDirectoryMaxStaleMs).toBe(15 * 60 * 1000);
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
      CLIENT_DIRECTORY_CACHE_TTL_MS: '60000',
    });
    expect(cfg.anthropicMaxContentBytes).toBe(2048);
    expect(cfg.anthropicConfidenceThreshold).toBe(0.8);
    expect(cfg.clientDirectoryCacheTtlMs).toBe(60000);
  });

  it('rejects a non-numeric threshold', () => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        ANTHROPIC_CONFIDENCE_THRESHOLD: 'abc',
      }),
    ).toThrow(/ANTHROPIC_CONFIDENCE_THRESHOLD/);
  });

  it('rejects a quarantine site path that does not start with /', () => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        QUARANTINE_SITE_PATH: 'sites/BCR',
      }),
    ).toThrow(/QUARANTINE_SITE_PATH/);
  });

  it.each([
    ['BOT_CALLER_APP_IDS', /BOT_CALLER_APP_IDS/],
    ['FORBIDDEN_TARGET_SITE_PATHS', /FORBIDDEN_TARGET_SITE_PATHS/],
  ])('fails at cold start when the %s allow-list is missing or empty', (name, pattern) => {
    const missing: NodeJS.ProcessEnv = { ...baseEnv };
    delete missing[name];
    expect(() => loadConfig(ingestionConfigSchema, ingestionEnvMap, missing)).toThrow(pattern);
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, [name]: ' , ' }),
    ).toThrow(pattern);
  });

  it.each([
    'https://contoso.sharepoint.com/sites/BCRGROUP',
    'sites/BCRGROUP',
    '/sites/BCRGROUP/Shared Documents',
    '/personal/someone',
  ])('rejects the FORBIDDEN_TARGET_SITE_PATHS entry %j, which would never match a row', (entry) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        FORBIDDEN_TARGET_SITE_PATHS: `/sites/Kwarantanna,${entry}`,
      }),
    ).toThrow(/FORBIDDEN_TARGET_SITE_PATHS/);
  });

  it('accepts /sites and /teams paths, with or without a trailing slash', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      FORBIDDEN_TARGET_SITE_PATHS: '/sites/BCRGROUP/, /teams/Other',
    });
    expect(cfg.forbiddenTargetSitePaths).toEqual(['/sites/BCRGROUP/', '/teams/Other']);
  });

  it('uses the default for an optional setting left empty or blank in app settings', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      QUARANTINE_DRIVE_NAME: '',
      QUARANTINE_ROOT_FOLDER: '   ',
    });
    expect(cfg.quarantineDriveName).toBe('Documents');
    expect(cfg.quarantineRootFolder).toBe('Kwarantanna');
  });

  it('rejects a non-UUID Client Directory list id', () => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        CLIENT_DIRECTORY_LIST_ID: 'not-a-uuid',
      }),
    ).toThrow(/CLIENT_DIRECTORY_LIST_ID/);
  });
});
