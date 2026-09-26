/**
 * One fresh database per test file on the `test:db` server: migrated as the
 * superuser, with a NON-superuser login granted ledger_app exactly as the
 * ingestion identity is in Azure (`grantAppLogin`: INHERIT FALSE, SET TRUE),
 * and a pool that logs in as it. The pool has one connection, so a test can
 * look at the very connection a transaction used once it is back in the pool.
 */
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { applyMigrations, grantAppLogin, loadMigrations } from '../src/migrate';
import { LedgerDb } from '../src/tx';

export interface TestDatabase {
  readonly name: string;
  /** The superuser, connected to the test database. Bypasses RLS: for setup and checks only. */
  readonly admin: Client;
  /** The app's login: not a superuser, no BYPASSRLS, granted ledger_app. */
  readonly appLogin: string;
  /** A pool of one connection as the app's login. */
  readonly appPool: Pool;
  /** The index over `appPool`, as the ingestion builds it. */
  readonly db: LedgerDb;
  /** Opens another pool (one connection) as `login`. */
  pool(login: string, password?: string): Pool;
  /** Creates a login role on the server with the test password. */
  createLogin(login: string, attributes?: string): Promise<void>;
  drop(): Promise<void>;
}

const PASSWORD = randomBytes(12).toString('hex');

export function serverUrl(database?: string): URL {
  const raw = process.env['LEDGER_TEST_DATABASE_URL'];
  if (!raw) throw new Error('LEDGER_TEST_DATABASE_URL is not set: run through test:db');
  const url = new URL(raw);
  if (database) url.pathname = `/${database}`;
  return url;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const suffix = randomBytes(4).toString('hex');
  const name = `ledger_it_${suffix}`;
  const server = new Client({ connectionString: serverUrl().toString() });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();

  const admin = new Client({ connectionString: serverUrl(name).toString() });
  await admin.connect();
  await applyMigrations(admin, loadMigrations());

  const logins: string[] = [];
  const pools: Pool[] = [];
  const createLogin = async (login: string, attributes = ''): Promise<void> => {
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' ${attributes}`);
    logins.push(login);
  };
  const pool = (login: string, password = PASSWORD): Pool => {
    const url = serverUrl(name);
    url.username = login;
    url.password = password;
    const p = new Pool({ connectionString: url.toString(), max: 1 });
    pools.push(p);
    return p;
  };

  const appLogin = `ledger_it_app_${suffix}`;
  await createLogin(appLogin, 'NOSUPERUSER NOBYPASSRLS');
  await grantAppLogin(admin, appLogin);
  const appPool = pool(appLogin);

  return {
    name,
    admin,
    appLogin,
    appPool,
    db: new LedgerDb(appPool),
    pool,
    createLogin,
    async drop() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.end();
      const server2 = new Client({ connectionString: serverUrl().toString() });
      await server2.connect();
      await server2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const login of logins) await server2.query(`DROP ROLE IF EXISTS ${login}`);
      await server2.end();
    },
  };
}

/** The SQLSTATE of a failed statement, or undefined. */
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-sqlstate';
  }
}
