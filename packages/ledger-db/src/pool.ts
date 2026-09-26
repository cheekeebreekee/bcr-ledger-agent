import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { createLogger, type Logger } from '@bcr/shared';
import { Pool, type PoolConfig } from 'pg';
import { LedgerDbError } from './errors';

/**
 * The Entra resource of Azure Database for PostgreSQL. A token for it is the
 * login's password; the server checks it against the principal created with
 * `pgaadauth_create_principal` (docs/operations/human-steps.md).
 */
export const OSSRDBMS_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/** Where the index is and who logs in. None of it is a secret. */
export interface LedgerPoolConfig {
  /** `<server>.postgres.database.azure.com` (`LEDGER_DB_HOST`). */
  readonly host: string;
  /** `LEDGER_DB_NAME`, `ledger`. */
  readonly database: string;
  /** The managed identity's login, named after the Function App (`LEDGER_DB_USER`). */
  readonly user: string;
  /**
   * Connections per worker. Default {@link LEDGER_POOL_MAX}: each Consumption
   * instance has its own pool, and a Burstable B1ms server allows about 50.
   */
  readonly max?: number;
}

export interface LedgerPoolOptions {
  /** Defaults to {@link createLedgerCredential}. Injected in tests. */
  readonly credential?: TokenCredential;
  /** Defaults to the `ledger-db/pool` logger. */
  readonly log?: Logger;
}

export const LEDGER_POOL_MAX = 2;

/**
 * The Function App's system-assigned managed identity in Azure
 * (`NODE_ENV=production`), `DefaultAzureCredential` elsewhere, e.g. an
 * operator's `az login` — the same rule as the Graph client.
 */
export function createLedgerCredential(env: NodeJS.ProcessEnv = process.env): TokenCredential {
  return env['NODE_ENV'] === 'production'
    ? new ManagedIdentityCredential()
    : new DefaultAzureCredential();
}

/**
 * The password callback node-postgres calls for every new connection: a fresh
 * Entra access token (the credential caches and renews it). No password is
 * stored anywhere.
 */
export function entraPassword(credential: TokenCredential): () => Promise<string> {
  return async () => {
    const token = await credential.getToken(OSSRDBMS_SCOPE);
    if (!token?.token) throw new LedgerDbError('no_token', 'no Entra token for the database');
    return token.token;
  };
}

/**
 * The pool's settings. TLS is always on and always verified — there is no
 * option to turn it off here; the DB integration tests build their own pool.
 * Every connection and statement is time-bounded so a slow or unreachable
 * server costs an upload seconds, never the batch's deadline.
 */
export function ledgerPoolConfig(
  config: LedgerPoolConfig,
  credential: TokenCredential,
): PoolConfig {
  for (const [name, value] of Object.entries({
    host: config.host,
    database: config.database,
    user: config.user,
  })) {
    if (value.trim() === '') throw new LedgerDbError('invalid_record', `ledger pool: no ${name}`);
  }
  return {
    host: config.host,
    port: 5432,
    database: config.database,
    user: config.user,
    password: entraPassword(credential),
    ssl: { rejectUnauthorized: true, servername: config.host, minVersion: 'TLSv1.2' },
    max: config.max ?? LEDGER_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Well inside the ~1 h an Entra token lives: a connection opened with a
    // token is never older than this.
    maxLifetimeSeconds: 30 * 60,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    idle_in_transaction_session_timeout: 10_000,
    application_name: 'bcr-ledger-index',
  };
}

/**
 * A pool for the index. An idle connection that fails (a server restart, a
 * network drop) emits `error` on the pool; unhandled, that would end the
 * worker, and every upload on it. It is logged by name and SQLSTATE only.
 */
export function createLedgerPool(config: LedgerPoolConfig, opts: LedgerPoolOptions = {}): Pool {
  const log = opts.log ?? createLogger('ledger-db/pool');
  const pool = new Pool(ledgerPoolConfig(config, opts.credential ?? createLedgerCredential()));
  pool.on('error', (err: Error & { code?: unknown }) => {
    log.warn(
      {
        event: 'index.pool_error',
        err: { name: err.name, ...(typeof err.code === 'string' ? { code: err.code } : {}) },
      },
      'index.pool_error',
    );
  });
  return pool;
}
