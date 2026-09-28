/**
 * The isolation matrix of the document index, against a real PostgreSQL 16,
 * as a NON-superuser login granted ledger_app the way the ingestion identity
 * is. For every table in schema `ledger` (the list is read from the catalog,
 * so a table added without an entry here fails this file):
 *
 *   - no scope: 0 rows, and every insert refused;
 *   - scope A: only A's rows; B's rows can be neither inserted, updated nor
 *     moved into; nothing can be deleted;
 *   - client_id is immutable, even for a superuser;
 *   - outside a transaction the login holds no privilege at all.
 *
 * Then verify.sql, and the pooled connection a transaction leaves behind.
 */
import { isValidNip } from '@bcr/shared';
import type { PoolClient } from 'pg';
import { clientIdForDirectoryRow } from '../src/clientScope';
import { verifySchema } from '../src/migrate';
import * as clientsRepo from '../src/repos/clientsRepo';
import * as documentsRepo from '../src/repos/documentsRepo';
import * as searchQueriesRepo from '../src/repos/searchQueriesRepo';
import { sql, type Sql } from '../src/sql';
import { createTestDatabase, sqlState, type TestDatabase } from './harness';

const LIST_ID = '0f0e0d0c-0b0a-4988-8776-655443322110';
const A = clientIdForDirectoryRow(LIST_ID, '101');
const B = clientIdForDirectoryRow(LIST_ID, '102');

/** How to read and write the rows of each table, for a client, in the current scope. */
interface TableCase {
  insertFor(clientId: string, n: number): Sql;
  /** Every row's client_id, as text. */
  select: Sql;
  touch: Sql;
  /** The nullable column `touch` sets. */
  touchedColumn: string;
  moveTo(clientId: string): Sql;
  deleteAll: Sql;
}

const USER = '11111111-2222-4333-8444-555555555555';

const TABLES: Readonly<Record<string, TableCase>> = {
  clients: {
    insertFor: (clientId, n) =>
      sql`INSERT INTO ledger.clients (client_id, directory_list_item_id)
          VALUES (${clientId}::uuid, ${String(900 + n)})`,
    select: sql`SELECT client_id::text FROM ledger.clients`,
    touch: sql`UPDATE ledger.clients SET legal_name = 'touched'`,
    touchedColumn: 'legal_name',
    moveTo: (clientId) => sql`UPDATE ledger.clients SET client_id = ${clientId}::uuid`,
    deleteAll: sql`DELETE FROM ledger.clients`,
  },
  documents: {
    insertFor: (clientId, n) =>
      sql`INSERT INTO ledger.documents
            (document_id, client_id, source, drive_id, drive_item_id, status, category)
          VALUES (gen_random_uuid(), ${clientId}::uuid, 'bot', 'drive-x', ${`item-x-${n}`},
                  'FILED', 'umowy')`,
    select: sql`SELECT client_id::text FROM ledger.documents`,
    touch: sql`UPDATE ledger.documents SET model = 'touched'`,
    touchedColumn: 'model',
    moveTo: (clientId) => sql`UPDATE ledger.documents SET client_id = ${clientId}::uuid`,
    deleteAll: sql`DELETE FROM ledger.documents`,
  },
  search_queries: {
    insertFor: (clientId) =>
      sql`INSERT INTO ledger.search_queries (query_id, client_id, user_oid, kind)
          VALUES (gen_random_uuid(), ${clientId}::uuid, ${USER}::uuid, 'question')`,
    select: sql`SELECT client_id::text FROM ledger.search_queries`,
    touch: sql`UPDATE ledger.search_queries SET model = 'touched'`,
    touchedColumn: 'model',
    moveTo: (clientId) => sql`UPDATE ledger.search_queries SET client_id = ${clientId}::uuid`,
    deleteAll: sql`DELETE FROM ledger.search_queries`,
  },
};

const directoryRow = (listItemId: string, nip: string) => ({
  directoryListId: LIST_ID,
  listItemId,
  clientNo: `00${listItemId}`,
  nip,
  legalName: `Klient ${listItemId}`,
  active: true,
});

const doc = (id: string, driveItemId: string) => ({
  documentId: id,
  source: 'bot' as const,
  driveId: 'drive-1',
  driveItemId,
  category: 'umowy',
  reviewReasons: [],
});

let t: TestDatabase;

/** Runs `fn` on the app's own connection, in a transaction as ledger_app with NO scope. */
async function unscoped<T>(fn: (conn: PoolClient) => Promise<T>): Promise<T> {
  const conn = await t.appPool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('SET LOCAL ROLE ledger_app');
    return await fn(conn);
  } finally {
    await conn.query('ROLLBACK');
    conn.release();
  }
}

/** A statement in A's scope that must fail; the transaction is rolled back. */
async function failsInScope(clientId: string, statement: Sql): Promise<string | undefined> {
  return sqlState(t.db.withClientTx(clientId, (tx) => tx.query(statement)));
}

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.withClientTx(A, async (tx) => {
    await clientsRepo.upsertFromDirectory(tx, directoryRow('101', '1234567819'));
    await documentsRepo.recordFiled(tx, doc('a0000000-0000-4000-8000-000000000001', 'a-item-1'));
    await documentsRepo.recordReview(tx, doc('a0000000-0000-4000-8000-000000000002', 'a-item-2'));
    await searchQueriesRepo.reserve(tx, {
      queryId: 'a0000000-0000-4000-8000-0000000000a1',
      userOid: USER,
      kind: 'question',
    });
  });
  await t.db.withClientTx(B, async (tx) => {
    await clientsRepo.upsertFromDirectory(tx, directoryRow('102', '5260250274'));
    await documentsRepo.recordFiled(tx, doc('b0000000-0000-4000-8000-000000000001', 'b-item-1'));
    await searchQueriesRepo.reserve(tx, {
      queryId: 'b0000000-0000-4000-8000-0000000000b1',
      userOid: USER,
      kind: 'typed',
    });
  });
});

afterAll(async () => {
  await t?.drop();
});

describe('the matrix covers every table in schema ledger', () => {
  it('lists exactly the tables this file has cases for', async () => {
    const { rows } = await t.admin.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'ledger' ORDER BY 1",
    );
    expect(rows.map((r) => r.tablename)).toEqual(Object.keys(TABLES).sort());
  });

  it('has rows of both clients to hide (seen by the superuser, which bypasses RLS)', async () => {
    for (const table of Object.keys(TABLES)) {
      const { rows } = await t.admin.query<{ client_id: string; n: number }>(
        `SELECT client_id::text, count(*)::int AS n FROM ledger.${table} GROUP BY 1 ORDER BY 1`,
      );
      expect(rows.map((r) => r.client_id).sort()).toEqual([A, B].sort());
    }
  });
});

describe.each(Object.entries(TABLES))('ledger.%s', (table, cases) => {
  it('no scope: reads 0 rows', async () => {
    const counts = await unscoped(async (conn) => {
      const before = await conn.query(`SELECT count(*)::int AS n FROM ledger.${table}`);
      // Set and emptied, as a pooled session sees it after an earlier scope.
      await conn.query("SELECT set_config('app.client_id', '', true)");
      const after = await conn.query(`SELECT count(*)::int AS n FROM ledger.${table}`);
      return [before.rows[0].n, after.rows[0].n];
    });
    expect(counts).toEqual([0, 0]);
  });

  it('no scope: every insert is refused, for either client', async () => {
    for (const clientId of [A, B]) {
      const state = await unscoped(async (conn) =>
        sqlState(conn.query(cases.insertFor(clientId, 1).toQuery())),
      );
      expect(state).toBe('42501');
    }
  });

  it('no scope: updates touch nothing', async () => {
    const touched = await unscoped(
      async (conn) => (await conn.query(cases.touch.toQuery())).rowCount,
    );
    expect(touched).toBe(0);
  });

  it("scope A: reads A's rows only", async () => {
    // A fixed table name per case; the scope comes from the transaction only.
    const rows = await t.db.withClientTx(A, (tx) => tx.query<{ client_id: string }>(cases.select));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.client_id !== A)).toEqual([]);
  });

  it("scope A: B's row cannot be inserted", async () => {
    expect(await failsInScope(A, cases.insertFor(B, 2))).toBe('42501');
  });

  it("scope A: an update never reaches B's rows", async () => {
    const before = await t.admin.query(`SELECT * FROM ledger.${table} WHERE client_id = $1`, [B]);
    await t.db.withClientTx(A, (tx) => tx.query(cases.touch));
    const after = await t.admin.query(`SELECT * FROM ledger.${table} WHERE client_id = $1`, [B]);
    expect(after.rows).toEqual(before.rows);
    await t.admin.query(
      `UPDATE ledger.${table} SET ${cases.touchedColumn} = NULL WHERE client_id = $1`,
      [A],
    );
  });

  it("scope A: A's rows cannot be moved to B", async () => {
    const state = await failsInScope(A, cases.moveTo(B));
    expect(['23000', '42501']).toContain(state);
  });

  it('scope A: nothing can be deleted', async () => {
    expect(await failsInScope(A, cases.deleteAll)).toBe('42501');
  });

  it('client_id is immutable, even for a superuser that bypasses RLS', async () => {
    const other = '00000000-0000-4000-8000-00000000abcd';
    expect(
      await sqlState(
        t.admin.query(`UPDATE ledger.${table} SET client_id = $1 WHERE client_id = $2`, [other, A]),
      ),
    ).toBe('23000');
  });

  it('outside a client transaction the login holds no privilege at all', async () => {
    expect(await sqlState(t.appPool.query(`SELECT count(*) FROM ledger.${table}`))).toBe('42501');
  });
});

describe('the scope', () => {
  it('refuses a setting that is not a UUID, failing the statement', async () => {
    const state = await unscoped(async (conn) => {
      await conn.query("SELECT set_config('app.client_id', 'not-a-uuid', true)");
      return sqlState(conn.query('SELECT count(*) FROM ledger.documents'));
    });
    expect(state).toBe('22P02');
  });

  it('cannot be widened by the login: it cannot turn off row security', async () => {
    const state = await unscoped(async (conn) =>
      sqlState(conn.query('ALTER TABLE ledger.documents NO FORCE ROW LEVEL SECURITY')),
    );
    expect(state).toBe('42501');
  });

  it('cannot be escaped by the login: it cannot become the owner', async () => {
    const state = await unscoped(async (conn) => sqlState(conn.query('SET ROLE ledger_owner')));
    expect(state).toBe('42501');
  });
});

describe('the pooled connection a client transaction leaves behind', () => {
  const identity = async () =>
    (
      await t.appPool.query<{ who: string; scope: string | null }>(
        "SELECT current_user::text AS who, current_setting('app.client_id', true) AS scope",
      )
    ).rows[0];

  it('after a commit: the login again, with no scope', async () => {
    await t.db.withClientTx(A, (tx) => documentsRepo.monthlyCounts(tx));
    const who = await identity();
    expect(who?.who).toBe(t.appLogin);
    expect(who?.scope ?? '').toBe('');
  });

  it('after fn throws: rolled back, the login again, with no scope', async () => {
    await expect(
      t.db.withClientTx(A, async (tx) => {
        await documentsRepo.recordFiled(
          tx,
          doc('a0000000-0000-4000-8000-0000000000ff', 'a-rolled-back'),
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const who = await identity();
    expect(who?.who).toBe(t.appLogin);
    expect(who?.scope ?? '').toBe('');
    const { rows } = await t.admin.query(
      "SELECT 1 FROM ledger.documents WHERE drive_item_id = 'a-rolled-back'",
    );
    expect(rows).toEqual([]);
  });

  it('after a failed statement: the login again, with no scope, and usable', async () => {
    expect(await failsInScope(A, TABLES['documents']!.insertFor(B, 9))).toBe('42501');
    const who = await identity();
    expect(who?.who).toBe(t.appLogin);
    expect(who?.scope ?? '').toBe('');
    const counts = await t.db.withClientTx(B, (tx) => documentsRepo.monthlyCounts(tx));
    expect(counts.reduce((n, c) => n + c.documents, 0)).toBe(1);
  });
});

describe('verify.sql', () => {
  it('finds no problem in the migrated schema', async () => {
    expect(await verifySchema(t.admin)).toEqual([]);
  });

  /** Breaks one invariant in a transaction that is rolled back, and reports what verify.sql saw. */
  async function brokenBy(...statements: string[]): Promise<string[]> {
    await t.admin.query('BEGIN');
    try {
      for (const s of statements) await t.admin.query(s);
      return [...new Set((await verifySchema(t.admin)).map((p) => `${p.check} ${p.object}`))];
    } finally {
      await t.admin.query('ROLLBACK');
    }
  }

  it('sees RLS not forced, and not enabled', async () => {
    expect(await brokenBy('ALTER TABLE ledger.documents NO FORCE ROW LEVEL SECURITY')).toEqual([
      'rls_not_forced documents',
    ]);
    expect(await brokenBy('ALTER TABLE ledger.clients DISABLE ROW LEVEL SECURITY')).toEqual([
      'rls_not_enabled clients',
    ]);
  });

  it('sees a new table with no RLS, no policy, no client_id and the wrong owner', async () => {
    expect(await brokenBy('CREATE TABLE ledger.notes (id int)')).toEqual([
      'client_id_missing notes',
      'guard_trigger_missing notes',
      'owner_not_ledger_owner notes',
      'policy_missing notes',
      'rls_not_enabled notes',
      'rls_not_forced notes',
    ]);
  });

  it('sees a table whose client_id guard is gone or disabled', async () => {
    expect(
      await brokenBy('DROP TRIGGER search_queries_guard_row_update ON ledger.search_queries'),
    ).toEqual(['guard_trigger_missing search_queries']);
    expect(
      await brokenBy('ALTER TABLE ledger.documents DISABLE TRIGGER documents_guard_row_update'),
    ).toEqual(['guard_trigger_missing documents']);
  });

  it('sees the app role granted DELETE or TRUNCATE', async () => {
    expect(await brokenBy('GRANT DELETE ON ledger.search_queries TO ledger_app')).toEqual([
      'app_role_can_delete search_queries',
    ]);
    expect(await brokenBy('GRANT TRUNCATE ON ledger.clients TO ledger_app')).toEqual([
      'app_role_can_delete clients',
    ]);
  });

  it('sees a policy that is not the client predicate, or bound to a role', async () => {
    expect(
      await brokenBy('CREATE POLICY open_read ON ledger.documents FOR SELECT USING (true)'),
    ).toEqual(['policy_not_client_scoped documents.open_read']);
    expect(
      await brokenBy(
        `CREATE POLICY app_only ON ledger.clients TO ledger_app
           USING (client_id = ledger.current_client_id())
           WITH CHECK (client_id = ledger.current_client_id())`,
      ),
    ).toEqual(['policy_restrictive_or_role_bound clients.app_only']);
  });

  it('sees the app role given BYPASSRLS, a table, or CREATE', async () => {
    expect(await brokenBy('ALTER ROLE ledger_app BYPASSRLS')).toEqual([
      'role_privileged ledger_app',
    ]);
    // An owner holds every privilege on its table, DELETE and TRUNCATE included.
    expect(await brokenBy('ALTER TABLE ledger.clients OWNER TO ledger_app')).toEqual([
      'app_role_can_delete clients',
      'app_role_owns ledger_app',
      'owner_not_ledger_owner clients',
    ]);
    expect(await brokenBy('GRANT CREATE ON SCHEMA ledger TO ledger_app')).toEqual([
      'app_role_can_create ledger_app',
    ]);
  });

  it('sees a login that could use ledger_app while privileged, or that inherits it', async () => {
    expect(await brokenBy(`ALTER ROLE ${t.appLogin} BYPASSRLS`)).toEqual([
      `app_member_privileged ${t.appLogin}`,
    ]);
    expect(await brokenBy(`GRANT ledger_app TO ${t.appLogin} WITH INHERIT TRUE`)).toEqual([
      `app_member_inherits ${t.appLogin}`,
    ]);
  });

  it('sees PUBLIC granted a table, and the scope function replaced', async () => {
    expect(await brokenBy('GRANT SELECT ON ledger.documents TO PUBLIC')).toEqual([
      'public_privilege documents',
    ]);
    expect(
      await brokenBy(
        `CREATE OR REPLACE FUNCTION ledger.current_client_id() RETURNS uuid
           LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$`,
      ),
    ).toEqual(['scope_function_changed ledger.current_client_id()']);
  });
});

describe('ledger.nip_is_valid agrees with isValidNip', () => {
  it('on fixed cases and on 2000 generated ones', async () => {
    const values = [
      '1234567819',
      '5260250274',
      '1000000006',
      '0000000000',
      '1234567810',
      '123456781',
      '12345678190',
      'abcdefghij',
      '',
    ];
    let seed = 42;
    for (let i = 0; i < 2000; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      values.push(String(seed % 10_000_000_000).padStart(10, '0'));
    }
    const { rows } = await t.admin.query<{ nip: string; valid: boolean }>(
      'SELECT nip, ledger.nip_is_valid(nip) AS valid FROM unnest($1::text[]) AS nip',
      [values],
    );
    const disagree = rows.filter((r) => r.valid !== isValidNip(r.nip)).map((r) => r.nip);
    expect(disagree).toEqual([]);
    expect(rows.filter((r) => r.valid).length).toBeGreaterThan(100);
  });
});
