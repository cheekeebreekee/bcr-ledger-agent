import { _resetConfigCache, loadIngestionConfig } from './config';

const env: NodeJS.ProcessEnv = {
  AZURE_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  INGESTION_APP_ID: '00000000-0000-0000-0000-000000000000',
  EXPECTED_AUDIENCE: 'api://ingestion',
  BOT_CALLER_APP_IDS: '00000000-0000-0000-0000-000000000001',
  CLIENT_DIRECTORY_SITE_ID: 'contoso.sharepoint.com,a,b',
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
    expect(loadIngestionConfig({})).toBe(first);
  });

  it('fails fast, naming the variable, when a required setting is missing', () => {
    const missing: NodeJS.ProcessEnv = { ...env };
    delete missing['QUARANTINE_SITE_PATH'];
    expect(() => loadIngestionConfig(missing)).toThrow(/QUARANTINE_SITE_PATH/);
  });
});
