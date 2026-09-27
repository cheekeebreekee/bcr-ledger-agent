import {
  botConfigSchema,
  CLASSIFICATION_ACCEPT_THRESHOLD_MAX,
  CLASSIFICATION_ACCEPT_THRESHOLD_MIN,
  ingestionConfigSchema,
  loadConfig,
  missingLedgerIndexSettings,
  thinkingDisabledProblem,
} from './config';

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
  membershipCheckMode: 'MEMBERSHIP_CHECK_MODE',
  inboxSweepMode: 'INBOX_SWEEP_MODE',
  inboxMinAgeMs: 'INBOX_MIN_AGE_MS',
  inboxMaxFilesPerTick: 'INBOX_MAX_FILES_PER_TICK',
  inboxSweepRows: 'INBOX_SWEEP_ROWS',
  inboxCreatedAfter: 'INBOX_CREATED_AFTER',
  anthropicEnabled: 'ANTHROPIC_ENABLED',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
  anthropicEffort: 'ANTHROPIC_EFFORT',
  anthropicThinking: 'ANTHROPIC_THINKING',
  anthropicMaxContentBytes: 'ANTHROPIC_MAX_CONTENT_BYTES',
  classificationAcceptThreshold: 'CLASSIFICATION_ACCEPT_THRESHOLD',
  ledgerIndexMode: 'LEDGER_INDEX_MODE',
  ledgerDbHost: 'LEDGER_DB_HOST',
  ledgerDbName: 'LEDGER_DB_NAME',
  ledgerDbUser: 'LEDGER_DB_USER',
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
    CLIENT_DIRECTORY_SITE_ID: `contoso.sharepoint.com,${validListUuid},${validUuid}`,
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
    expect(cfg.anthropicModel).toBe('claude-opus-5');
    expect(cfg.anthropicEffort).toBe('low');
    expect(cfg.anthropicThinking).toBe('adaptive');
    expect(cfg.anthropicMaxContentBytes).toBe(10 * 1024 * 1024);
    expect(cfg.classificationAcceptThreshold).toBe(0.7);
    expect(cfg.membershipCheckMode).toBe('enforce');
    expect(cfg.inboxSweepMode).toBe('off');
    expect(cfg.inboxMinAgeMs).toBe(2 * 60 * 1000);
    expect(cfg.inboxMaxFilesPerTick).toBe(20);
    expect(cfg.inboxSweepRows).toEqual([]);
    expect(cfg.inboxCreatedAfter).toBeUndefined();
    expect(cfg.ledgerIndexMode).toBe('off');
    expect(cfg.ledgerDbHost).toBe('');
    expect(cfg.ledgerDbName).toBe('ledger');
    expect(cfg.ledgerDbUser).toBe('');
  });

  describe('effort and thinking', () => {
    it('reads ANTHROPIC_EFFORT and ANTHROPIC_THINKING, empty as the defaults', () => {
      const set = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        ANTHROPIC_EFFORT: 'medium',
        ANTHROPIC_THINKING: 'disabled',
      });
      expect([set.anthropicEffort, set.anthropicThinking]).toEqual(['medium', 'disabled']);
      const empty = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        ANTHROPIC_EFFORT: ' ',
        ANTHROPIC_THINKING: '',
      });
      expect([empty.anthropicEffort, empty.anthropicThinking]).toEqual(['low', 'adaptive']);
    });

    // xhigh and max cost more and, with disabled thinking, are a 400 on Opus 5.
    it.each([
      ['ANTHROPIC_EFFORT', 'xhigh'],
      ['ANTHROPIC_EFFORT', 'max'],
      ['ANTHROPIC_EFFORT', 'LOW'],
      ['ANTHROPIC_THINKING', 'off'],
      ['ANTHROPIC_THINKING', 'enabled'],
    ])('fails at cold start on %s=%j', (name, value) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, [name]: value }),
      ).toThrow(new RegExp(name));
    });

    it('accepts disabled thinking only with a model that takes it', () => {
      const problem = (anthropicThinking: 'adaptive' | 'disabled', anthropicModel: string) =>
        thinkingDisabledProblem({ anthropicThinking, anthropicModel });
      expect(problem('disabled', 'claude-sonnet-5')).toBeUndefined();
      expect(problem('disabled', 'claude-opus-5')).toBeUndefined();
      expect(problem('adaptive', 'claude-opus-5-5')).toBeUndefined();
      expect(problem('disabled', 'claude-opus-5-5')).toMatch(
        /ANTHROPIC_THINKING: 'disabled' is not accepted by ANTHROPIC_MODEL claude-opus-5-5/,
      );
    });
  });

  describe('the document index settings', () => {
    it('reads LEDGER_INDEX_MODE=write with the host, database and login', () => {
      const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        LEDGER_INDEX_MODE: 'write',
        LEDGER_DB_HOST: 'psql-bcr-dev-abc.postgres.database.azure.com',
        LEDGER_DB_NAME: 'ledger_test',
        LEDGER_DB_USER: 'func-bcr-ingest-dev-abc',
      });
      expect(cfg.ledgerIndexMode).toBe('write');
      expect(cfg.ledgerDbHost).toBe('psql-bcr-dev-abc.postgres.database.azure.com');
      expect(cfg.ledgerDbName).toBe('ledger_test');
      expect(cfg.ledgerDbUser).toBe('func-bcr-ingest-dev-abc');
      expect(missingLedgerIndexSettings(cfg)).toEqual([]);
    });

    it('treats an empty LEDGER_INDEX_MODE as off', () => {
      const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        LEDGER_INDEX_MODE: ' ',
      });
      expect(cfg.ledgerIndexMode).toBe('off');
    });

    it.each(['on', 'enforce', 'WRITE', 'shadow'])(
      'fails at cold start on LEDGER_INDEX_MODE=%j: a typo never switches writes on',
      (value) => {
        expect(() =>
          loadConfig(ingestionConfigSchema, ingestionEnvMap, {
            ...baseEnv,
            LEDGER_INDEX_MODE: value,
          }),
        ).toThrow(/LEDGER_INDEX_MODE/);
      },
    );

    it.each([
      ['LEDGER_DB_HOST', 'https://psql.postgres.database.azure.com'],
      ['LEDGER_DB_HOST', 'psql.postgres.database.azure.com:5432'],
      ['LEDGER_DB_NAME', 'Ledger'],
      ['LEDGER_DB_NAME', 'ledger;drop'],
      ['LEDGER_DB_USER', 'func bcr'],
      ['LEDGER_DB_USER', '"func"'],
    ])('rejects %s=%j', (name, value) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, [name]: value }),
      ).toThrow(new RegExp(name));
    });

    it('names what write mode still needs, and nothing with off', () => {
      const off = loadConfig(ingestionConfigSchema, ingestionEnvMap, baseEnv);
      expect(missingLedgerIndexSettings(off)).toEqual([]);
      expect(missingLedgerIndexSettings({ ...off, ledgerIndexMode: 'write' })).toEqual([
        'LEDGER_DB_HOST',
        'LEDGER_DB_USER',
      ]);
    });
  });

  // A first `shadow`/`enforce` can be limited to a canary row. Only list item
  // ids are accepted: a ClientId or a name would match no row, silently.
  it('reads INBOX_SWEEP_ROWS as list item ids', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      INBOX_SWEEP_ROWS: ' 7, 12 ,',
    });
    expect(cfg.inboxSweepRows).toEqual(['7', '12']);
  });

  it.each(['0002', 'PESKOVOI', '7;12', '-1', '1.5'])(
    'rejects INBOX_SWEEP_ROWS=%j, naming the variable',
    (value) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, INBOX_SWEEP_ROWS: value }),
      ).toThrow(/INBOX_SWEEP_ROWS: must be Client Directory list item ids/);
    },
  );

  it.each([
    ['2026-10-01T00:00:00Z', Date.UTC(2026, 9, 1)],
    ['2026-10-01T08:30Z', Date.UTC(2026, 9, 1, 8, 30)],
    ['2026-10-01T08:30:15.250Z', Date.UTC(2026, 9, 1, 8, 30, 15, 250)],
    ['  ', undefined],
  ])('reads INBOX_CREATED_AFTER=%j', (value, expected) => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      INBOX_CREATED_AFTER: value,
    });
    expect(cfg.inboxCreatedAfter).toBe(expected);
  });

  // An offset or a bare date could be read in another zone than meant.
  it.each(['2026-10-01', '2026-10-01T00:00:00+02:00', '01.10.2026', 'yesterday', '2026-13-01T00:00Z'])(
    'rejects INBOX_CREATED_AFTER=%j, naming the variable',
    (value) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, {
          ...baseEnv,
          INBOX_CREATED_AFTER: value,
        }),
      ).toThrow(/INBOX_CREATED_AFTER: must be an ISO 8601 UTC time/);
    },
  );

  // The inbox sweep moves files in client channels. It is off unless set,
  // and only an exact mode switches it on: a typo stops cold start instead.
  it.each([
    [undefined, 'off'],
    ['', 'off'],
    [' ', 'off'],
    ['off', 'off'],
    ['shadow', 'shadow'],
    ['enforce', 'enforce'],
  ])('reads INBOX_SWEEP_MODE=%j as %s', (value, expected) => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      INBOX_SWEEP_MODE: value,
    });
    expect(cfg.inboxSweepMode).toBe(expected);
  });

  it.each(['ENFORCE', 'on', 'true', 'log', 'dry-run'])(
    'rejects INBOX_SWEEP_MODE=%j, naming the variable',
    (value) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, INBOX_SWEEP_MODE: value }),
      ).toThrow(/INBOX_SWEEP_MODE: must be 'off', 'shadow' or 'enforce'/);
    },
  );

  it('reads the inbox age and budget overrides', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      INBOX_MIN_AGE_MS: '300000',
      INBOX_MAX_FILES_PER_TICK: '5',
    });
    expect(cfg.inboxMinAgeMs).toBe(300000);
    expect(cfg.inboxMaxFilesPerTick).toBe(5);
  });

  it.each([
    ['INBOX_MIN_AGE_MS', '-1'],
    ['INBOX_MIN_AGE_MS', '1.5'],
    ['INBOX_MIN_AGE_MS', 'soon'],
    ['INBOX_MAX_FILES_PER_TICK', '0'],
    ['INBOX_MAX_FILES_PER_TICK', '2.5'],
  ])('rejects %s=%j, naming the variable', (name, value) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, [name]: value }),
    ).toThrow(new RegExp(name));
  });

  // The runtime Team-membership check closes R46; only an exact `off` may
  // switch it off. Empty is the default, and anything else stops cold start.
  it.each([
    [undefined, 'enforce'],
    ['', 'enforce'],
    ['  ', 'enforce'],
    ['enforce', 'enforce'],
    ['off', 'off'],
  ])('reads MEMBERSHIP_CHECK_MODE=%j as %s', (value, expected) => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      MEMBERSHIP_CHECK_MODE: value,
    });
    expect(cfg.membershipCheckMode).toBe(expected);
  });

  it.each(['OFF', 'of', 'false', '0', 'log', 'disabled'])(
    'rejects MEMBERSHIP_CHECK_MODE=%j, naming the variable',
    (value) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, MEMBERSHIP_CHECK_MODE: value }),
      ).toThrow(/MEMBERSHIP_CHECK_MODE: must be 'enforce' or 'off'/);
    },
  );

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
      CLASSIFICATION_ACCEPT_THRESHOLD: '0.8',
      CLIENT_DIRECTORY_CACHE_TTL_MS: '60000',
    });
    expect(cfg.anthropicMaxContentBytes).toBe(2048);
    expect(cfg.classificationAcceptThreshold).toBe(0.8);
    expect(cfg.clientDirectoryCacheTtlMs).toBe(60000);
  });

  it.each(['0.70', '0.7', '0.85', '0.95'])('accepts CLASSIFICATION_ACCEPT_THRESHOLD=%s', (v) => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      CLASSIFICATION_ACCEPT_THRESHOLD: v,
    });
    expect(cfg.classificationAcceptThreshold).toBe(Number(v));
  });

  // A threshold of 0.69 would file a 0.69 guess under its category. Outside
  // the range the app refuses to start, naming the variable.
  it.each(['0.69', '0.6', '0', '0.96', '1', 'abc'])(
    'refuses to start on CLASSIFICATION_ACCEPT_THRESHOLD=%s',
    (v) => {
      expect(() =>
        loadConfig(ingestionConfigSchema, ingestionEnvMap, {
          ...baseEnv,
          CLASSIFICATION_ACCEPT_THRESHOLD: v,
        }),
      ).toThrow(/CLASSIFICATION_ACCEPT_THRESHOLD/);
    },
  );

  it('keeps the range at 0.70–0.95', () => {
    expect([CLASSIFICATION_ACCEPT_THRESHOLD_MIN, CLASSIFICATION_ACCEPT_THRESHOLD_MAX]).toEqual([
      0.7, 0.95,
    ]);
  });

  // The old name is not read: the running app still carries 0.6 there, and
  // reading it would now stop ingestion at cold start.
  it('ignores the retired ANTHROPIC_CONFIDENCE_THRESHOLD', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      ANTHROPIC_CONFIDENCE_THRESHOLD: '0.6',
    });
    expect(cfg.classificationAcceptThreshold).toBe(0.7);
  });

  it.each([
    'https://contoso.sharepoint.com/sites/BCRLedgerKwarantanna',
    '/sites/BCRLedgerKwarantanna/sub',
    '/sites/x/../BCRLedgerKwarantanna',
    '/sites/BCRLedgerKwarantanna.',
    '/sites',
  ])('rejects the quarantine site path %j', (path) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, QUARANTINE_SITE_PATH: path }),
    ).toThrow(/QUARANTINE_SITE_PATH/);
  });

  it('stores the quarantine site path in its canonical spelling', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      QUARANTINE_SITE_PATH: ' sites//BCRLedgerKwarantanna/ ',
    });
    expect(cfg.quarantineSitePath).toBe('/sites/BCRLedgerKwarantanna');
  });

  // A value that starts but guards nothing is worse than one that fails:
  // these would read the Directory, then never match a resolved site.
  it.each([
    ['the path form', 'contoso.sharepoint.com:/sites/BCRGROUP:'],
    ['a two-part id', `contoso.sharepoint.com,${validUuid}`],
    ['placeholder GUIDs', 'contoso.sharepoint.com,site-guid,web-guid'],
    ['a bare GUID', validUuid],
  ])('rejects CLIENT_DIRECTORY_SITE_ID in %s', (_label, value) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, CLIENT_DIRECTORY_SITE_ID: value }),
    ).toThrow(/CLIENT_DIRECTORY_SITE_ID/);
  });

  it('accepts a three-part CLIENT_DIRECTORY_SITE_ID in any case, trimmed', () => {
    const id = `Contoso.SharePoint.com,${validListUuid.toUpperCase()},${validUuid}`;
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      CLIENT_DIRECTORY_SITE_ID: ` ${id} `,
    });
    expect(cfg.clientDirectorySiteId).toBe(id);
  });

  it.each([
    '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/x)',
    `"${validUuid}"`,
    `${validUuid},not-an-app-id`,
  ])('rejects the BOT_CALLER_APP_IDS value %j', (value) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, BOT_CALLER_APP_IDS: value }),
    ).toThrow(/BOT_CALLER_APP_IDS/);
  });

  it('accepts several caller app ids', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      BOT_CALLER_APP_IDS: `${validUuid}, ${validListUuid.toUpperCase()}`,
    });
    expect(cfg.botCallerAppIds).toEqual([validUuid, validListUuid.toUpperCase()]);
  });

  it.each([
    'https://contoso.sharepoint.com',
    'contoso.sharepoint.com/sites/x',
    'contoso.example.com',
    'contoso',
  ])('rejects the QUARANTINE_SITE_HOSTNAME %j', (value) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, { ...baseEnv, QUARANTINE_SITE_HOSTNAME: value }),
    ).toThrow(/QUARANTINE_SITE_HOSTNAME/);
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
    '/sites/BCRGROUP/Shared Documents',
    '/sites/BCRGROUP/sub',
    '/sites/BCRGROUP.',
    '/sites/%42CRGROUP',
    '/sites/./BCRGROUP',
    '/personal/someone',
  ])('rejects the FORBIDDEN_TARGET_SITE_PATHS entry %j, which would never match a row', (entry) => {
    expect(() =>
      loadConfig(ingestionConfigSchema, ingestionEnvMap, {
        ...baseEnv,
        FORBIDDEN_TARGET_SITE_PATHS: `/sites/Kwarantanna,${entry}`,
      }),
    ).toThrow(/FORBIDDEN_TARGET_SITE_PATHS/);
  });

  it('accepts /sites and /teams paths in any spelling C1 allows, stored canonical', () => {
    const cfg = loadConfig(ingestionConfigSchema, ingestionEnvMap, {
      ...baseEnv,
      FORBIDDEN_TARGET_SITE_PATHS: '/sites/BCRGROUP/, /teams/Other, sites//BCRGROUPSp.zo.o',
    });
    expect(cfg.forbiddenTargetSitePaths).toEqual([
      '/sites/BCRGROUP',
      '/teams/Other',
      '/sites/BCRGROUPSp.zo.o',
    ]);
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
