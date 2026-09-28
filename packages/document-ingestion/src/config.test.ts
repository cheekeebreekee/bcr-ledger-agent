import {
  _resetConfigCache,
  claudeConfigured,
  loadIngestionConfig,
  RETIRED_SETTINGS,
  retiredSettingsIn,
  searchOffReason,
} from './config';

const env: NodeJS.ProcessEnv = {
  AZURE_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  INGESTION_APP_ID: '00000000-0000-0000-0000-000000000000',
  EXPECTED_AUDIENCE: 'api://ingestion',
  BOT_CALLER_APP_IDS: '00000000-0000-0000-0000-000000000001',
  CLIENT_DIRECTORY_SITE_ID:
    'contoso.sharepoint.com,22222222-2222-2222-2222-222222222222,33333333-3333-3333-3333-333333333333',
  CLIENT_DIRECTORY_LIST_ID: '11111111-1111-1111-1111-111111111111',
  QUARANTINE_SITE_HOSTNAME: 'contoso.sharepoint.com',
  QUARANTINE_SITE_PATH: '/sites/Kwarantanna',
  FORBIDDEN_TARGET_SITE_PATHS: '/sites/BCRGROUP',
};

describe('loadIngestionConfig', () => {
  afterEach(() => _resetConfigCache());

  it('maps every env var and caches the result for the process', () => {
    const first = loadIngestionConfig(env);
    expect(first.botCallerAppIds).toEqual(['00000000-0000-0000-0000-000000000001']);
    expect(first.forbiddenTargetSitePaths).toEqual(['/sites/BCRGROUP']);
    expect(first.membershipCheckMode).toBe('enforce');
    expect(first.inboxSweepMode).toBe('off');
    expect(loadIngestionConfig({})).toBe(first);
  });

  it('reads MEMBERSHIP_CHECK_MODE=off, the emergency escape', () => {
    expect(loadIngestionConfig({ ...env, MEMBERSHIP_CHECK_MODE: 'off' }).membershipCheckMode).toBe(
      'off',
    );
  });

  it('reads the inbox sweep settings', () => {
    const cfg = loadIngestionConfig({
      ...env,
      INBOX_SWEEP_MODE: 'shadow',
      INBOX_MIN_AGE_MS: '60000',
      INBOX_MAX_FILES_PER_TICK: '3',
      INBOX_SWEEP_ROWS: '7',
      INBOX_CREATED_AFTER: '2026-10-01T00:00:00Z',
    });
    expect(cfg.inboxSweepMode).toBe('shadow');
    expect(cfg.inboxMinAgeMs).toBe(60000);
    expect(cfg.inboxMaxFilesPerTick).toBe(3);
    expect(cfg.inboxSweepRows).toEqual(['7']);
    expect(cfg.inboxCreatedAfter).toBe(Date.UTC(2026, 9, 1));
  });

  it('reads the document index settings: off by default, write with a server and a login', () => {
    expect(loadIngestionConfig(env).ledgerIndexMode).toBe('off');
    _resetConfigCache();
    const cfg = loadIngestionConfig({
      ...env,
      LEDGER_INDEX_MODE: 'write',
      LEDGER_DB_HOST: 'psql-bcr-test-x.postgres.database.azure.com',
      LEDGER_DB_USER: 'func-bcr-ingest-test-x',
    });
    expect(cfg.ledgerIndexMode).toBe('write');
    expect(cfg.ledgerDbName).toBe('ledger');
  });

  it('refuses to start in write mode without the server and the login, naming both', () => {
    expect(() => loadIngestionConfig({ ...env, LEDGER_INDEX_MODE: 'write' })).toThrow(
      /LEDGER_DB_HOST: required when LEDGER_INDEX_MODE=write; LEDGER_DB_USER: required/,
    );
  });

  it('refuses to start on an INBOX_SWEEP_MODE it does not know', () => {
    expect(() => loadIngestionConfig({ ...env, INBOX_SWEEP_MODE: 'on' })).toThrow(/INBOX_SWEEP_MODE/);
  });

  it('refuses to start on a MEMBERSHIP_CHECK_MODE it does not know', () => {
    expect(() => loadIngestionConfig({ ...env, MEMBERSHIP_CHECK_MODE: 'disabled' })).toThrow(
      /MEMBERSHIP_CHECK_MODE/,
    );
  });

  it('reads the classification settings, with claude-opus-5 and 0.70 by default', () => {
    const defaults = loadIngestionConfig(env);
    expect(defaults.anthropicModel).toBe('claude-opus-5');
    expect(defaults.classificationAcceptThreshold).toBe(0.7);
    _resetConfigCache();
    const set = loadIngestionConfig({
      ...env,
      ANTHROPIC_MODEL: 'claude-opus-4-5-20251101',
      CLASSIFICATION_ACCEPT_THRESHOLD: '0.8',
    });
    expect(set.anthropicModel).toBe('claude-opus-4-5-20251101');
    expect(set.classificationAcceptThreshold).toBe(0.8);
  });

  it('reads the effort and thinking settings, low and adaptive by default', () => {
    const defaults = loadIngestionConfig(env);
    expect([defaults.anthropicEffort, defaults.anthropicThinking]).toEqual(['low', 'adaptive']);
    _resetConfigCache();
    const set = loadIngestionConfig({
      ...env,
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_EFFORT: 'medium',
      ANTHROPIC_THINKING: 'disabled',
    });
    expect([set.anthropicModel, set.anthropicEffort, set.anthropicThinking]).toEqual([
      'claude-sonnet-5',
      'medium',
      'disabled',
    ]);
  });

  // Every call would be a 400, and every document would go to review unclassified.
  it('refuses to start with disabled thinking on a model that rejects it', () => {
    expect(() =>
      loadIngestionConfig({
        ...env,
        ANTHROPIC_MODEL: 'claude-opus-5-5',
        ANTHROPIC_THINKING: 'disabled',
      }),
    ).toThrow(/ANTHROPIC_THINKING: 'disabled' is not accepted by ANTHROPIC_MODEL claude-opus-5-5/);
  });

  it('refuses to start on a threshold of 0.69', () => {
    expect(() => loadIngestionConfig({ ...env, CLASSIFICATION_ACCEPT_THRESHOLD: '0.69' })).toThrow(
      /CLASSIFICATION_ACCEPT_THRESHOLD/,
    );
  });

  it('starts with the retired ANTHROPIC_CONFIDENCE_THRESHOLD still set, and names it', () => {
    const withOld = { ...env, ANTHROPIC_CONFIDENCE_THRESHOLD: '0.6' };
    expect(loadIngestionConfig(withOld).classificationAcceptThreshold).toBe(0.7);
    expect(retiredSettingsIn(withOld)).toEqual(['ANTHROPIC_CONFIDENCE_THRESHOLD']);
    expect(retiredSettingsIn({ ...env, ANTHROPIC_CONFIDENCE_THRESHOLD: ' ' })).toEqual([]);
    expect(retiredSettingsIn(env)).toEqual([]);
    expect(RETIRED_SETTINGS['ANTHROPIC_CONFIDENCE_THRESHOLD']).toMatch(/CLASSIFICATION_ACCEPT_THRESHOLD/);
  });

  it('fails fast, naming the variable, when a required setting is missing', () => {
    const missing: NodeJS.ProcessEnv = { ...env };
    delete missing['QUARANTINE_SITE_PATH'];
    expect(() => loadIngestionConfig(missing)).toThrow(/QUARANTINE_SITE_PATH/);
  });
});

describe('client search settings', () => {
  afterEach(() => _resetConfigCache());

  const MI_APP = '7d0c3f6a-5b1e-4c2d-9e8f-0a1b2c3d4e5f';
  const BOT_APP = '00000000-0000-0000-0000-000000000001';

  it('is off, open to every row and callable by nobody unless set', () => {
    const cfg = loadIngestionConfig(env);
    expect([cfg.searchMode, cfg.searchRows, cfg.searchCallerAppIds]).toEqual(['off', [], []]);
  });

  it('reads SEARCH_MODE, SEARCH_ROWS and SEARCH_CALLER_APP_IDS', () => {
    const cfg = loadIngestionConfig({
      ...env,
      SEARCH_MODE: 'on',
      SEARCH_ROWS: '10, 2',
      SEARCH_CALLER_APP_IDS: MI_APP,
    });
    expect([cfg.searchMode, cfg.searchRows, cfg.searchCallerAppIds]).toEqual([
      'on',
      ['10', '2'],
      [MI_APP],
    ]);
  });

  it('refuses to start only on a SEARCH_MODE outside off|on, naming it', () => {
    expect(() => loadIngestionConfig({ ...env, SEARCH_MODE: 'enforce' })).toThrow(/SEARCH_MODE/);
  });

  it.each([
    ['SEARCH_ROWS', 'PESKOVOI', 'bad_rows'],
    ['SEARCH_ROWS', '10;2', 'bad_rows'],
    ['SEARCH_ROWS', '10,0002', 'bad_rows'],
    ['SEARCH_CALLER_APP_IDS', 'bot-app', 'bad_callers'],
    ['SEARCH_CALLER_APP_IDS', `{${MI_APP}}`, 'bad_callers'],
  ])('starts on a %s of %p, keeping every entry and search off (%s)', (name, value, reason) => {
    // A typo must never stop filing, nor be dropped: an emptied SEARCH_ROWS opens every row.
    const cfg = loadIngestionConfig({
      ...env,
      SEARCH_MODE: 'on',
      SEARCH_CALLER_APP_IDS: MI_APP,
      [name]: value,
    });
    const read = name === 'SEARCH_ROWS' ? cfg.searchRows : cfg.searchCallerAppIds;
    expect(read).toEqual(value.split(','));
    expect(searchOffReason(cfg)).toBe(reason);
  });

  const on = {
    searchMode: 'on',
    searchRows: ['10', '2'],
    ledgerIndexMode: 'write',
    anthropicEnabled: true,
    anthropicApiKey: 'key',
    searchCallerAppIds: [MI_APP],
    botCallerAppIds: [BOT_APP],
    membershipCheckMode: 'enforce',
  } as const;

  it('runs only when every condition holds', () => {
    expect(searchOffReason(on)).toBeUndefined();
  });

  it.each([
    ['mode_off', { searchMode: 'off' }],
    ['bad_rows', { searchRows: ['10', ' '] }],
    ['bad_callers', { searchCallerAppIds: [MI_APP, 'bot-app'] }],
    ['index_off', { ledgerIndexMode: 'off' }],
    ['claude_off', { anthropicEnabled: false }],
    ['claude_off', { anthropicApiKey: '' }],
    ['no_callers', { searchCallerAppIds: [] }],
    // The bot registration's secret files documents; it must never read them.
    ['caller_overlap', { searchCallerAppIds: [MI_APP, BOT_APP.toUpperCase()] }],
    ['membership_off', { membershipCheckMode: 'off' }],
  ] as const)('is off (%s) when %p', (reason, over) => {
    expect(searchOffReason({ ...on, ...over })).toBe(reason);
  });

  it('names the first reason when several hold, SEARCH_MODE first', () => {
    expect(searchOffReason({ ...on, searchMode: 'off', ledgerIndexMode: 'off' })).toBe('mode_off');
  });

  it('calls Claude configured only when it is enabled and keyed', () => {
    expect(claudeConfigured({ anthropicEnabled: true, anthropicApiKey: 'k' })).toBe(true);
    expect(claudeConfigured({ anthropicEnabled: true, anthropicApiKey: '' })).toBe(false);
    expect(claudeConfigured({ anthropicEnabled: false, anthropicApiKey: 'k' })).toBe(false);
  });
});
