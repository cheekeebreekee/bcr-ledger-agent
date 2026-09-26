import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMigrations,
  grantAppLogin,
  loadMigrations,
  MIGRATION_LOCK_ID,
  MIGRATIONS_DIR,
  VERIFY_SQL_FILE,
  verifySchema,
  type AdminClient,
  type Migration,
} from './migrate';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-migrations-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** A fake admin connection: records statements, answers from `answer`. */
function admin(answer: (text: string, values: unknown[]) => unknown[] | Error = () => []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const client: AdminClient = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const out = answer(text, values);
      if (out instanceof Error) throw out;
      return { rows: out };
    },
  };
  const texts = () => calls.map((c) => c.text.replace(/\s+/g, ' ').trim());
  return { client, calls, texts };
}

describe('loadMigrations', () => {
  it('reads the repository migrations in order, with checksums', () => {
    const migrations = loadMigrations();
    expect(migrations[0]).toMatchObject({ version: '0001', name: 'ledger_core' });
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]?.sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(MIGRATIONS_DIR.endsWith(join('ledger-db', 'migrations'))).toBe(true);
  });

  it('numbers from 0001 without gaps, and ignores dot files', () => {
    const dir = dirWith({ '0001_a.sql': 'SELECT 1', '0002_b.sql': 'SELECT 2', '.DS_Store': '' });
    expect(loadMigrations(dir).map((m) => `${m.version}_${m.name}`)).toEqual(['0001_a', '0002_b']);
  });

  it.each([
    [{ '0001_a.sql': '', '0003_c.sql': '' }, /expected migration 0002/],
    [{ '0001_a.sql': '', '0001_b.sql': '' }, /expected migration 0002/],
    [{ '0001_a.sql': '', 'README.md': '' }, /README\.md: not a NNNN_name\.sql/],
    [{ '1_a.sql': '' }, /not a NNNN_name\.sql/],
    [{ '0001_A.sql': '' }, /not a NNNN_name\.sql/],
  ])('refuses %j', (files, message) => {
    expect(() => loadMigrations(dirWith(files))).toThrow(message);
  });
});

describe('applyMigrations', () => {
  const m1: Migration = { version: '0001', name: 'a', sql: 'CREATE TABLE a ()', checksum: 'c1' };
  const m2: Migration = { version: '0002', name: 'b', sql: 'CREATE TABLE b ()', checksum: 'c2' };

  it('applies each pending migration in its own transaction, under the lock', async () => {
    const a = admin((text) =>
      text.startsWith('SELECT version') ? [{ version: '0001', checksum: 'c1' }] : [],
    );
    const lines: string[] = [];
    const run = await applyMigrations(a.client, [m1, m2], (l) => lines.push(l));
    expect(run).toEqual({ applied: ['0002_b'], alreadyApplied: ['0001_a'] });
    expect(lines).toEqual(['applying 0002_b']);
    const texts = a.texts();
    expect(texts[0]).toBe('SELECT pg_advisory_lock($1)');
    expect(a.calls[0]?.values).toEqual([MIGRATION_LOCK_ID]);
    expect(texts.slice(-6)).toEqual([
      'BEGIN',
      'CREATE TABLE b ()',
      'RESET ROLE',
      'INSERT INTO ledger_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      'COMMIT',
      'SELECT pg_advisory_unlock($1)',
    ]);
    expect(texts).not.toContain('CREATE TABLE a ()');
  });

  it('stops before applying anything when an applied migration changed', async () => {
    const a = admin((text) =>
      text.startsWith('SELECT version') ? [{ version: '0001', checksum: 'edited' }] : [],
    );
    await expect(applyMigrations(a.client, [m1, m2])).rejects.toMatchObject({
      reason: 'migration_changed',
    });
    expect(a.texts()).not.toContain('BEGIN');
    expect(a.texts().slice(-1)).toEqual(['SELECT pg_advisory_unlock($1)']);
  });

  it('rolls back a failing migration and releases the lock', async () => {
    const a = admin((text) => (text === 'CREATE TABLE a ()' ? new Error('syntax error') : []));
    await expect(applyMigrations(a.client, [m1, m2])).rejects.toThrow('syntax error');
    expect(a.texts().slice(-3)).toEqual([
      'CREATE TABLE a ()',
      'ROLLBACK',
      'SELECT pg_advisory_unlock($1)',
    ]);
  });
});

describe('verifySchema', () => {
  it('runs verify.sql and maps each row to a problem', async () => {
    const a = admin(() => [{ check_name: 'rls_not_forced', object: 'documents', detail: 'd' }]);
    expect(await verifySchema(a.client)).toEqual([
      { check: 'rls_not_forced', object: 'documents', detail: 'd' },
    ]);
    expect(a.calls[0]?.text).toBe(readFileSync(VERIFY_SQL_FILE, 'utf8'));
  });

  it('is a pass on no rows', async () => {
    expect(await verifySchema(admin().client, 'SELECT 1 WHERE false')).toEqual([]);
  });
});

describe('grantAppLogin', () => {
  const role = (over: Record<string, boolean> = {}) => [
    { rolcanlogin: true, rolsuper: false, rolbypassrls: false, ...over },
  ];

  it('grants ledger_app with INHERIT FALSE and SET TRUE to a plain login, quoted', async () => {
    const a = admin((text) => (text.startsWith('SELECT rolcanlogin') ? role() : []));
    await grantAppLogin(a.client, 'func-bcr-ingest-dev-abc123');
    expect(a.calls[0]?.values).toEqual(['func-bcr-ingest-dev-abc123']);
    expect(a.texts()[1]).toBe(
      'GRANT ledger_app TO "func-bcr-ingest-dev-abc123" WITH INHERIT FALSE, SET TRUE',
    );
  });

  it.each([[{ rolsuper: true }], [{ rolbypassrls: true }], [{ rolcanlogin: false }]])(
    'refuses a login that is %j',
    async (over) => {
      const a = admin((text) => (text.startsWith('SELECT rolcanlogin') ? role(over) : []));
      await expect(grantAppLogin(a.client, 'login')).rejects.toThrow(
        /neither SUPERUSER nor BYPASSRLS/,
      );
      expect(a.texts().some((t) => t.startsWith('GRANT'))).toBe(false);
    },
  );

  it('refuses a login that does not exist, or a name that is not one', async () => {
    await expect(grantAppLogin(admin().client, 'nobody')).rejects.toThrow(/no such login/);
    await expect(grantAppLogin(admin().client, 'x"; DROP ROLE ledger_app; --')).rejects.toThrow(
      /not a login name/,
    );
  });
});
