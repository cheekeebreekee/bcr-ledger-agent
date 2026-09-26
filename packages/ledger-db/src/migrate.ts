import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerDbError } from './errors';
import { LEDGER_APP_ROLE, type QueryResultLike } from './tx';

/** Where the numbered migrations are: `packages/ledger-db/migrations`. */
export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** The isolation check: `packages/ledger-db/sql/verify.sql`. */
export const VERIFY_SQL_FILE = join(__dirname, '..', 'sql', 'verify.sql');

/** One `NNNN_name.sql` file. */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  /** Hex SHA-256 of the file: an applied migration must never change. */
  readonly checksum: string;
}

/** A connection the operator (the Entra admin) or a test superuser holds. */
export interface AdminClient {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>;
}

const FILE = /^([0-9]{4})_([a-z0-9_]+)\.sql$/;

/** Any lock id, as long as it is always the same one: two runs never interleave. */
export const MIGRATION_LOCK_ID = 7_104_202_609;

/**
 * The migration files in order. Names are `NNNN_name.sql`, numbered from
 * 0001 without gaps or repeats; anything else in the folder is an error, so a
 * typo can never make a migration silently not run.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  return files.map((file, index) => {
    const match = FILE.exec(file);
    if (!match) {
      throw new LedgerDbError('migration_invalid', `${file}: not a NNNN_name.sql migration`);
    }
    const expected = String(index + 1).padStart(4, '0');
    if (match[1] !== expected) {
      throw new LedgerDbError('migration_invalid', `${file}: expected migration ${expected} here`);
    }
    const text = readFileSync(join(dir, file), 'utf8');
    return {
      version: match[1] as string,
      name: match[2] as string,
      sql: text,
      checksum: createHash('sha256').update(text).digest('hex'),
    };
  });
}

export interface MigrationRun {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Applies the migrations that have not run, each in its own transaction with
 * its row in `ledger_meta.schema_migrations`, under an advisory lock. Run as
 * the server's Entra administrator (a superuser in the DB tests). Re-running
 * is a no-op; a migration whose file changed after it was applied stops the
 * run before anything else happens: fix forward with a new migration.
 *
 * The migration files create the objects as `ledger_owner` (`SET LOCAL ROLE`
 * in the file); the bookkeeping row is written back as the admin.
 */
export async function applyMigrations(
  client: AdminClient,
  migrations: readonly Migration[],
  log: (line: string) => void = () => undefined,
): Promise<MigrationRun> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS ledger_meta');
    await client.query('REVOKE ALL ON SCHEMA ledger_meta FROM PUBLIC');
    await client.query(`CREATE TABLE IF NOT EXISTS ledger_meta.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query(
      'SELECT version, checksum FROM ledger_meta.schema_migrations',
    );
    const done = new Map(
      (rows as { version: string; checksum: string }[]).map((r) => [r.version, r.checksum]),
    );
    for (const m of migrations) {
      const checksum = done.get(m.version);
      if (checksum !== undefined && checksum !== m.checksum) {
        throw new LedgerDbError(
          'migration_changed',
          `migration ${m.version}_${m.name} changed after it was applied; add a new migration instead`,
        );
      }
    }
    const applied: string[] = [];
    const alreadyApplied: string[] = [];
    for (const m of migrations) {
      const label = `${m.version}_${m.name}`;
      if (done.has(m.version)) {
        alreadyApplied.push(label);
        continue;
      }
      log(`applying ${label}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('RESET ROLE');
        await client.query(
          'INSERT INTO ledger_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(label);
    }
    return { applied, alreadyApplied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  }
}

/** One broken isolation invariant, as `verify.sql` reports it. */
export interface VerifyProblem {
  readonly check: string;
  readonly object: string;
  readonly detail: string;
}

/**
 * Runs `verify.sql`: every row it returns is a broken invariant (RLS off or
 * not forced, a table without a policy or with one that is not the client
 * predicate, the app role able to bypass RLS or owning anything, …). An empty
 * list is a pass.
 */
export async function verifySchema(
  client: AdminClient,
  verifySql: string = readFileSync(VERIFY_SQL_FILE, 'utf8'),
): Promise<VerifyProblem[]> {
  const { rows } = await client.query(verifySql);
  return (rows as { check_name: string; object: string; detail: string }[]).map((r) => ({
    check: r.check_name,
    object: r.object,
    detail: r.detail,
  }));
}

/** A login name as PostgreSQL shows it; also what the Function App may be called. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,62}$/;

/**
 * Lets an app's login run client transactions: `GRANT ledger_app TO <login>
 * WITH INHERIT FALSE, SET TRUE` — it can `SET ROLE ledger_app` inside a
 * transaction and holds nothing outside one. The login must exist (for the
 * ingestion identity: `pgaadauth_create_principal`, as the runbook says),
 * log in, and be neither superuser nor BYPASSRLS; otherwise nothing is
 * granted. Idempotent.
 */
export async function grantAppLogin(client: AdminClient, login: string): Promise<void> {
  if (!LOGIN.test(login)) {
    throw new LedgerDbError('invalid_record', 'grant: not a login name');
  }
  const { rows } = await client.query(
    'SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [login],
  );
  const role = (rows as { rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[])[0];
  if (!role) throw new LedgerDbError('invalid_record', 'grant: no such login');
  if (!role.rolcanlogin || role.rolsuper || role.rolbypassrls) {
    throw new LedgerDbError(
      'invalid_record',
      'grant: the login must be able to log in and be neither SUPERUSER nor BYPASSRLS',
    );
  }
  const quoted = `"${login.replace(/"/g, '""')}"`;
  await client.query(`GRANT ${LEDGER_APP_ROLE} TO ${quoted} WITH INHERIT FALSE, SET TRUE`);
}
