import type { TokenCredential } from '@azure/identity';
import type { Logger } from '@bcr/shared';
import {
  createLedgerCredential,
  createLedgerPool,
  entraPassword,
  LEDGER_POOL_MAX,
  ledgerPoolConfig,
  OSSRDBMS_SCOPE,
} from './pool';

const CONFIG = {
  host: 'psql-bcr-test-x.postgres.database.azure.com',
  database: 'ledger',
  user: 'func-bcr-ingest-test-x',
};

const credential = (token: string | null): TokenCredential & { scopes: string[] } => {
  const scopes: string[] = [];
  return {
    scopes,
    getToken: async (scope: string | string[]) => {
      scopes.push(String(scope));
      return token === null ? null : { token, expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  };
};

describe('entraPassword', () => {
  it('asks for a token for the PostgreSQL resource on every call', async () => {
    const c = credential('t0k3n');
    const password = entraPassword(c);
    expect(await password()).toBe('t0k3n');
    expect(await password()).toBe('t0k3n');
    expect(c.scopes).toEqual([OSSRDBMS_SCOPE, OSSRDBMS_SCOPE]);
    expect(OSSRDBMS_SCOPE).toBe('https://ossrdbms-aad.database.windows.net/.default');
  });

  it('fails the connection when there is no token', async () => {
    await expect(entraPassword(credential(null))()).rejects.toMatchObject({ reason: 'no_token' });
  });
});

describe('ledgerPoolConfig', () => {
  it('always verifies TLS, never holds a password, and bounds every wait', () => {
    const config = ledgerPoolConfig(CONFIG, credential('x'));
    expect(config).toMatchObject({
      host: CONFIG.host,
      port: 5432,
      database: 'ledger',
      user: CONFIG.user,
      ssl: { rejectUnauthorized: true, servername: CONFIG.host, minVersion: 'TLSv1.2' },
      max: LEDGER_POOL_MAX,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
      idle_in_transaction_session_timeout: 10_000,
    });
    expect(typeof config.password).toBe('function');
    expect(config.maxLifetimeSeconds).toBeLessThan(3600);
  });

  it('takes a pool size', () => {
    expect(ledgerPoolConfig({ ...CONFIG, max: 5 }, credential('x')).max).toBe(5);
  });

  it.each(['host', 'database', 'user'] as const)('refuses an empty %s', (field) => {
    expect(() => ledgerPoolConfig({ ...CONFIG, [field]: ' ' }, credential('x'))).toThrow(
      new RegExp(`no ${field}`),
    );
  });
});

describe('createLedgerCredential', () => {
  it('is the managed identity in Azure and the developer credential elsewhere', () => {
    expect(createLedgerCredential({ NODE_ENV: 'production' }).constructor.name).toBe(
      'ManagedIdentityCredential',
    );
    expect(createLedgerCredential({}).constructor.name).toBe('DefaultAzureCredential');
  });
});

describe('createLedgerPool', () => {
  it('logs an idle connection error by name and code, and never throws it', async () => {
    const lines: unknown[] = [];
    const log = { warn: (o: unknown) => lines.push(o) } as unknown as Logger;
    const pool = createLedgerPool(CONFIG, { credential: credential('x'), log });
    const err = Object.assign(
      new Error('terminating connection due to administrator command: secret'),
      {
        code: '57P01',
      },
    );
    expect(() => pool.emit('error', err)).not.toThrow();
    expect(lines).toEqual([{ event: 'index.pool_error', err: { name: 'Error', code: '57P01' } }]);
    pool.emit('error', new Error('no code'));
    expect(lines[1]).toEqual({ event: 'index.pool_error', err: { name: 'Error' } });
    await pool.end();
  });
});
