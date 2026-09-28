/**
 * A connection that dies while a client transaction holds it: a server
 * restart or maintenance, a gateway or network reset, the pool's own
 * idle_in_transaction_session_timeout, an operator's pg_terminate_backend.
 *
 * The ingestion writes the index AFTER the document is in SharePoint, so a
 * dead connection must fail that one transaction and nothing else: the
 * promise rejects (the caller logs `index.write_failed` and the filing
 * stands), nothing is committed, the worker process keeps running (node-postgres
 * emits `error` on a checked-out connection, and an `error` event nobody
 * listens to ends the process), and the pool hands out a working connection
 * next.
 */
import type { Logger } from '@bcr/shared';
import { clientIdForDirectoryRow } from '../src/clientScope';
import * as clientsRepo from '../src/repos/clientsRepo';
import * as documentsRepo from '../src/repos/documentsRepo';
import * as searchQueriesRepo from '../src/repos/searchQueriesRepo';
import { sql } from '../src/sql';
import { LedgerDb } from '../src/tx';
import { createTestDatabase, sqlState, type TestDatabase } from './harness';

const LIST_ID = '0f0e0d0c-0b0a-4988-8776-655443322110';
const A = clientIdForDirectoryRow(LIST_ID, '201');

const row = {
  directoryListId: LIST_ID,
  listItemId: '201',
  clientNo: '00201',
  nip: '1234567819',
  legalName: 'Klient 201',
  active: true,
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let t: TestDatabase;
/** The index over the app's pool of one connection, with its warnings recorded. */
let db: LedgerDb;
let warnings: unknown[];
/** What reached the process as an uncaught exception while a test ran. */
let uncaught: unknown[];
const onUncaught = (err: unknown) => uncaught.push(err);

beforeAll(async () => {
  t = await createTestDatabase();
  const log = { warn: (o: unknown) => warnings.push(o) } as unknown as Logger;
  db = new LedgerDb(t.appPool, { log });
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(() => {
  warnings = [];
  uncaught = [];
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.removeListener('uncaughtException', onUncaught);
});

/** The app login's backend that is running `pg_sleep`, once it is. */
async function sleepingBackend(): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await t.admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = $1 AND usename = $2 AND state = 'active'
          AND query LIKE 'SELECT pg_sleep%'`,
      [t.name, t.appLogin],
    );
    if (rows[0]) return rows[0].pid;
    await delay(25);
  }
  throw new Error('the transaction never reached pg_sleep');
}

/** The index is usable again: a fresh scoped transaction on the pool of one. */
async function poolServesTheNextTransaction(): Promise<void> {
  const rows = await db.withClientTx(A, (tx) =>
    tx.query<{ who: string; scope: string }>(
      sql`SELECT current_user::text AS who, current_setting('app.client_id', true) AS scope`,
    ),
  );
  expect(rows).toEqual([{ who: 'ledger_app', scope: A }]);
}

async function committedClientRows(): Promise<number> {
  const { rows } = await t.admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM ledger.clients WHERE client_id = $1',
    [A],
  );
  return rows[0]?.n ?? -1;
}

describe('a connection that dies inside a client transaction', () => {
  it('terminated mid-statement: the transaction rejects, the process lives, the pool recovers', async () => {
    const running = db.withClientTx(A, async (tx) => {
      await clientsRepo.upsertFromDirectory(tx, row);
      await tx.query(sql`SELECT pg_sleep(30)`);
    });
    const settled = running.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    const pid = await sleepingBackend();
    await t.admin.query('SELECT pg_terminate_backend($1)', [pid]);

    const outcome = await settled;
    expect(outcome).toMatchObject({ code: '57P01' });
    // Let the socket's close and any late `error` event arrive.
    await delay(200);
    expect(uncaught).toEqual([]);
    // One line, name and (socket or SQL) code only: which of the socket's
    // errors comes first depends on timing.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ event: 'index.connection_error' });
    expect(Object.keys((warnings[0] as { err: object }).err)).not.toContain('message');
    expect(await committedClientRows()).toBe(0);
    await poolServesTheNextTransaction();
  });

  it('killed while idle in the transaction: the next statement rejects, the process lives, the pool recovers', async () => {
    const running = db.withClientTx(A, async (tx) => {
      await tx.query(sql`SET LOCAL idle_in_transaction_session_timeout = 100`);
      await clientsRepo.upsertFromDirectory(tx, row);
      // The server ends the session while fn does something else.
      await delay(1_000);
      await tx.query(sql`SELECT 1`);
    });

    await expect(running).rejects.toBeInstanceOf(Error);
    await delay(200);
    expect(uncaught).toEqual([]);
    expect(warnings).toEqual([
      { event: 'index.connection_error', err: { name: 'error', code: '25P03' } },
    ]);
    expect(await committedClientRows()).toBe(0);
    await poolServesTheNextTransaction();
  });
});

describe('a read-only client transaction (search reads)', () => {
  const readOnly = { readOnly: true } as const;

  it('reads, scoped as usual, on one snapshot', async () => {
    const rows = await db.withClientTx(
      A,
      (tx) =>
        tx.query<{ who: string; scope: string; ro: string; iso: string }>(
          sql`SELECT current_user::text AS who, current_setting('app.client_id', true) AS scope,
                current_setting('transaction_read_only') AS ro,
                current_setting('transaction_isolation') AS iso`,
        ),
      readOnly,
    );
    expect(rows).toEqual([{ who: 'ledger_app', scope: A, ro: 'on', iso: 'repeatable read' }]);
    const page = await db.withClientTx(A, (tx) => documentsRepo.searchClientView(tx, {}), readOnly);
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('does not see a row committed between two of its statements (a page and its count agree)', async () => {
    const count = (tx: Parameters<Parameters<LedgerDb['withClientTx']>[1]>[0]) =>
      tx.query<{ n: number }>(sql`SELECT count(*)::int AS n FROM ledger.clients`);
    const seen = await db.withClientTx(
      A,
      async (tx) => {
        const before = await count(tx);
        // A filing commits for the same client, on another connection, mid-read.
        await t.admin.query(
          `INSERT INTO ledger.clients (client_id, directory_list_item_id) VALUES ($1, '201')`,
          [A],
        );
        const after = await count(tx);
        return [before[0]?.n, after[0]?.n];
      },
      readOnly,
    );
    await t.admin.query('DELETE FROM ledger.clients WHERE client_id = $1', [A]);
    expect(seen).toEqual([0, 0]);
    expect(await committedClientRows()).toBe(0);
  });

  it('fails any write with SQLSTATE 25006, commits nothing, and leaves the pool read-write', async () => {
    expect(
      await sqlState(
        db.withClientTx(A, (tx) => clientsRepo.upsertFromDirectory(tx, row), readOnly),
      ),
    ).toBe('25006');
    expect(
      await sqlState(
        db.withClientTx(
          A,
          (tx) =>
            searchQueriesRepo.reserve(tx, {
              queryId: '5e000000-0000-4000-8000-0000000000ff',
              userOid: '11111111-2222-4333-8444-555555555555',
              kind: 'question',
            }),
          readOnly,
        ),
      ),
    ).toBe('25006');
    expect(await committedClientRows()).toBe(0);
    expect(uncaught).toEqual([]);
    expect(warnings).toEqual([]);
    // The same pooled connection, next: an ordinary transaction, which may write.
    const ro = await db.withClientTx(A, (tx) =>
      tx.query<{ ro: string }>(sql`SELECT current_setting('transaction_read_only') AS ro`),
    );
    expect(ro).toEqual([{ ro: 'off' }]);
    await poolServesTheNextTransaction();
  });
});
