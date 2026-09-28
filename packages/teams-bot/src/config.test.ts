import { ValidationError } from '@bcr/shared';
import { loadBotConfig } from './config';

// Placeholder values — not real app registrations.
const env = {
  MICROSOFT_APP_ID: '44444444-4444-4444-8444-444444444444',
  MICROSOFT_APP_PASSWORD: 'placeholder-secret',
  MICROSOFT_APP_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  MICROSOFT_APP_TYPE: 'SingleTenant',
  INGESTION_BASE_URL: 'https://ingestion.example.test',
  INGESTION_SCOPE: 'api://placeholder/.default',
};

describe('loadBotConfig', () => {
  it('maps every env var and defaults the gate to enforce', () => {
    const config = loadBotConfig(env);
    expect(config).toMatchObject({
      microsoftAppId: env.MICROSOFT_APP_ID,
      microsoftAppTenantId: env.MICROSOFT_APP_TENANT_ID,
      microsoftAppType: 'SingleTenant',
      ingestionBaseUrl: env.INGESTION_BASE_URL,
      ingestionScope: env.INGESTION_SCOPE,
      botGateMode: 'enforce',
    });
  });

  it('reads BOT_GATE_MODE=log for the rollout window', () => {
    expect(loadBotConfig({ ...env, BOT_GATE_MODE: 'log' }).botGateMode).toBe('log');
  });

  it('rejects an unknown gate mode', () => {
    expect(() => loadBotConfig({ ...env, BOT_GATE_MODE: 'off' })).toThrow(ValidationError);
  });

  it('keeps search off unless SEARCH_MODE=on', () => {
    expect(loadBotConfig(env).searchMode).toBe('off');
    expect(loadBotConfig({ ...env, SEARCH_MODE: ' ' }).searchMode).toBe('off');
    expect(loadBotConfig({ ...env, SEARCH_MODE: 'off' }).searchMode).toBe('off');
    expect(loadBotConfig({ ...env, SEARCH_MODE: 'on' }).searchMode).toBe('on');
  });

  it('rejects an unknown search mode, naming SEARCH_MODE', () => {
    expect(() => loadBotConfig({ ...env, SEARCH_MODE: 'true' })).toThrow(/SEARCH_MODE/);
  });

  it('fails fast without MICROSOFT_APP_TYPE', () => {
    const withoutType: Record<string, string> = { ...env };
    delete withoutType.MICROSOFT_APP_TYPE;
    expect(() => loadBotConfig(withoutType)).toThrow(/MICROSOFT_APP_TYPE/);
  });
});
