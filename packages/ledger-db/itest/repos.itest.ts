/**
 * The repositories and the migration runner against a real PostgreSQL 16,
 * through the app's non-superuser login and withClientTx, as the ingestion
 * uses them.
 */
import { clientIdForDirectoryRow } from '../src/clientScope';
import { LedgerDbError, sqlStateOf } from '../src/errors';
import { applyMigrations, loadMigrations, verifySchema } from '../src/migrate';
import * as clientsRepo from '../src/repos/clientsRepo';
import * as documentsRepo from '../src/repos/documentsRepo';
import type { DocumentRecord } from '../src/repos/documentsRepo';
import { createTestDatabase, sqlState, type TestDatabase } from './harness';

const LIST_ID = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const A = clientIdForDirectoryRow(LIST_ID, '7');
const B = clientIdForDirectoryRow(LIST_ID, '8');

const row = (listItemId: string, nip = '') => ({
  directoryListId: LIST_ID,
  listItemId,
  clientNo: `000${listItemId}`,
  nip,
  legalName: `Klient ${listItemId}`,
  active: true,
});

const invoice = {
  invoiceNumber: 'FV 1/09/2026',
  issueDate: '2026-09-12',
  saleDate: '2026-09-10',
  currency: 'PLN',
  netAmount: '1000.00',
  vatAmount: '230.00',
  grossAmount: '1230.00',
  sellerNip: '5260250274',
  sellerName: 'Dostawca S.A.',
  buyerNip: '1234567819',
  buyerName: 'Klient 7',
  ksefNumber: '5260250274-20260912-0123456789AB-CD',
};

let n = 0;
const record = (over: Partial<DocumentRecord> = {}): DocumentRecord => {
  n += 1;
  return {
    documentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    source: 'inbox',
    driveId: 'b!drive',
    driveItemId: `item-${n}`,
    category: 'faktury_zakupu',
    confidence: 0.934,
    classifier: 'claude',
    model: 'claude-opus-5',
    reviewReasons: [],
    documentMonth: '2026-09',
    folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
    uploadedByOid: '11111111-2222-4333-8444-555555555555',
    contentSha256: 'a'.repeat(64),
    sizeBytes: 1234,
    invoice,
    ...over,
  };
};

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.withClientTx(A, (tx) => clientsRepo.upsertFromDirectory(tx, row('7', '1234567819')));
  await t.db.withClientTx(B, (tx) => clientsRepo.upsertFromDirectory(tx, row('8')));
});

afterAll(async () => {
  await t?.drop();
});

describe('clientsRepo.upsertFromDirectory', () => {
  it('creates the client row under the derived id, and refreshes it', async () => {
    await t.db.withClientTx(A, (tx) =>
      clientsRepo.upsertFromDirectory(tx, { ...row('7', '1234567819'), legalName: 'Nowa nazwa' }),
    );
    const { rows } = await t.admin.query(
      'SELECT client_id::text, directory_list_item_id, client_no, nip, legal_name, status FROM ledger.clients WHERE client_id = $1',
      [A],
    );
    expect(rows).toEqual([
      {
        client_id: A,
        directory_list_item_id: '7',
        client_no: '0007',
        nip: '1234567819',
        legal_name: 'Nowa nazwa',
        status: 'active',
      },
    ]);
  });

  it('stores an invalid NIP as NULL', async () => {
    const C = clientIdForDirectoryRow(LIST_ID, '9');
    await t.db.withClientTx(C, (tx) => clientsRepo.upsertFromDirectory(tx, row('9', '1234567810')));
    const { rows } = await t.admin.query('SELECT nip FROM ledger.clients WHERE client_id = $1', [
      C,
    ]);
    expect(rows).toEqual([{ nip: null }]);
  });

  it("refuses another client's NIP (a Directory conflict), writing nothing", async () => {
    const D = clientIdForDirectoryRow(LIST_ID, '10');
    const state = await sqlState(
      t.db.withClientTx(D, (tx) => clientsRepo.upsertFromDirectory(tx, row('10', '1234567819'))),
    );
    expect(state).toBe('23505');
    // What the ingestion's index writer reads to tell a refused row from an outage.
    const err = await t.db
      .withClientTx(D, (tx) => clientsRepo.upsertFromDirectory(tx, row('10', '1234567819')))
      .catch((e: unknown) => e);
    expect(sqlStateOf(err)).toBe('23505');
    const { rows } = await t.admin.query('SELECT 1 FROM ledger.clients WHERE client_id = $1', [D]);
    expect(rows).toEqual([]);
  });

  it("refuses a row written in another client's scope", async () => {
    await expect(
      t.db.withClientTx(A, (tx) => clientsRepo.upsertFromDirectory(tx, row('8'))),
    ).rejects.toMatchObject({ reason: 'scope_mismatch' });
  });

  it("a recreated Directory list's item 7 cannot take over the old item 7", async () => {
    const otherList = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
    const newA = clientIdForDirectoryRow(otherList, '7');
    const state = await sqlState(
      t.db.withClientTx(newA, (tx) =>
        clientsRepo.upsertFromDirectory(tx, { ...row('7'), directoryListId: otherList }),
      ),
    );
    expect(state).toBe('42501');
  });
});

describe('documentsRepo', () => {
  it('records a filed document with its invoice fields, and reads it back as text', async () => {
    const r = record({ driveItemId: 'filed-1' });
    const outcome = await t.db.withClientTx(A, (tx) => documentsRepo.recordFiled(tx, r));
    expect(outcome).toEqual({ documentId: r.documentId, created: true });
    const found = await t.db.withClientTx(A, (tx) => documentsRepo.findByDriveItem(tx, 'filed-1'));
    expect(found).toMatchObject({
      documentId: r.documentId,
      clientId: A,
      source: 'inbox',
      status: 'FILED',
      category: 'faktury_zakupu',
      confidence: '0.93',
      reviewReasons: [],
      documentMonth: '2026-09',
      sizeBytes: '1234',
      ...invoice,
    });
    expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('is idempotent on the drive item: the second write updates, keeping the first id', async () => {
    const first = record({ driveItemId: 'twice' });
    await t.db.withClientTx(A, (tx) => documentsRepo.recordFiled(tx, first));
    // A later write without the bytes' hash keeps the one recorded first.
    const again = record({
      driveItemId: 'twice',
      category: 'nieposortowane',
      suggestedCategory: 'faktury_zakupu',
      reviewReasons: ['LOW_CONFIDENCE'],
    });
    delete (again as { contentSha256?: string }).contentSha256;
    const outcome = await t.db.withClientTx(A, (tx) => documentsRepo.recordReview(tx, again));
    expect(outcome).toEqual({ documentId: first.documentId, created: false });
    const found = await t.db.withClientTx(A, (tx) => documentsRepo.findByDriveItem(tx, 'twice'));
    expect(found).toMatchObject({
      documentId: first.documentId,
      status: 'NEEDS_REVIEW',
      category: 'nieposortowane',
      suggestedCategory: 'faktury_zakupu',
      reviewReasons: ['LOW_CONFIDENCE'],
      contentSha256: 'a'.repeat(64),
    });
  });

  it("does not see another client's drive item", async () => {
    await t.db.withClientTx(B, (tx) =>
      documentsRepo.recordFiled(tx, record({ driveItemId: 'b-only' })),
    );
    expect(
      await t.db.withClientTx(A, (tx) => documentsRepo.findByDriveItem(tx, 'b-only')),
    ).toBeNull();
  });

  it('refuses a record the index cannot hold, naming the field only', async () => {
    await expect(
      t.db.withClientTx(A, (tx) =>
        documentsRepo.recordFiled(tx, record({ invoice: { ...invoice, sellerNip: '5260250275' } })),
      ),
    ).rejects.toThrow(
      new LedgerDbError('invalid_record', 'the document record is invalid: invoice.sellerNip'),
    );
  });

  it("counts the client's documents per month and status", async () => {
    const X = clientIdForDirectoryRow(LIST_ID, '20');
    await t.db.withClientTx(X, async (tx) => {
      await clientsRepo.upsertFromDirectory(tx, row('20'));
      await documentsRepo.recordFiled(tx, record({ documentMonth: '2026-08' }));
      await documentsRepo.recordFiled(tx, record({ documentMonth: '2026-09' }));
      await documentsRepo.recordFiled(tx, record({ documentMonth: '2026-09' }));
      await documentsRepo.recordReview(
        tx,
        record({ documentMonth: '2026-09', category: 'nieposortowane' }),
      );
      const unmonthed = record({ category: 'umowy' });
      delete (unmonthed as { documentMonth?: string }).documentMonth;
      await documentsRepo.recordFiled(tx, unmonthed);
    });
    expect(await t.db.withClientTx(X, (tx) => documentsRepo.monthlyCounts(tx))).toEqual([
      { month: '2026-09', status: 'FILED', documents: 2 },
      { month: '2026-09', status: 'NEEDS_REVIEW', documents: 1 },
      { month: '2026-08', status: 'FILED', documents: 1 },
      { month: null, status: 'FILED', documents: 1 },
    ]);
  });

  describe('search', () => {
    const S = clientIdForDirectoryRow(LIST_ID, '30');
    const T = clientIdForDirectoryRow(LIST_ID, '31');

    beforeAll(async () => {
      await t.db.withClientTx(S, async (tx) => {
        await clientsRepo.upsertFromDirectory(tx, row('30'));
        for (let i = 1; i <= 7; i += 1) {
          await documentsRepo.recordFiled(
            tx,
            record({
              driveItemId: `s-${i}`,
              documentMonth: `2026-0${i}`,
              invoice: {
                ...invoice,
                grossAmount: `${i * 100}.00`,
                sellerNip: i % 2 ? '5260250274' : '1000000006',
              },
            }),
          );
        }
      });
      await t.db.withClientTx(T, async (tx) => {
        await clientsRepo.upsertFromDirectory(tx, row('31'));
        await documentsRepo.recordFiled(
          tx,
          record({ driveItemId: 't-1', documentMonth: '2026-03' }),
        );
      });
    });

    const searchS = (filter: documentsRepo.DocumentSearchFilter, page?: documentsRepo.SearchPage) =>
      t.db.withClientTx(S, (tx) => documentsRepo.search(tx, filter, page));

    it('filters by month range, gross range and counterparty NIP, within the client only', async () => {
      const result = await searchS({
        monthFrom: '2026-02',
        monthTo: '2026-06',
        grossMin: '300',
        grossMax: 600,
        counterpartyNip: '526-025-02-74',
      });
      expect(result.items.map((d) => d.driveItemId).sort()).toEqual(['s-3', 's-5']);
      expect(result.items.every((d) => d.clientId === S)).toBe(true);
      expect(result.nextCursor).toBeNull();
    });

    it('filters by category', async () => {
      expect((await searchS({ category: 'umowy' })).items).toEqual([]);
      expect((await searchS({ category: 'faktury_zakupu' })).items).toHaveLength(7);
    });

    it('pages newest first with a keyset cursor, without gaps or repeats', async () => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await searchS({}, { limit: 3, ...(after ? { after } : {}) });
        seen.push(...page.items.map((d) => d.driveItemId));
        if (!page.nextCursor) break;
        after = page.nextCursor;
      }
      expect(seen).toEqual(['s-7', 's-6', 's-5', 's-4', 's-3', 's-2', 's-1']);
    });

    it("never returns another client's documents, whatever the filter", async () => {
      const all = await searchS({ monthFrom: '2026-01', monthTo: '2026-12' }, { limit: 100 });
      expect(all.items.map((d) => d.driveItemId)).not.toContain('t-1');
    });

    it('refuses a filter or cursor it did not issue', async () => {
      await expect(searchS({ counterpartyNip: '1234567810' })).rejects.toMatchObject({
        reason: 'invalid_filter',
      });
      await expect(searchS({}, { after: 'bm90LWEtY3Vyc29y' })).rejects.toMatchObject({
        reason: 'invalid_cursor',
      });
    });
  });
});

describe('the migration runner', () => {
  it('is a no-op the second time, and verify.sql still passes', async () => {
    const run = await applyMigrations(t.admin, loadMigrations());
    expect(run).toEqual({ applied: [], alreadyApplied: ['0001_ledger_core'] });
    expect(await verifySchema(t.admin)).toEqual([]);
  });

  it('stops when an applied migration was edited', async () => {
    const [first] = loadMigrations();
    await expect(
      applyMigrations(t.admin, [{ ...first!, checksum: '0'.repeat(64) }]),
    ).rejects.toMatchObject({ reason: 'migration_changed' });
  });

  it('records what it applied', async () => {
    const { rows } = await t.admin.query(
      'SELECT version, name FROM ledger_meta.schema_migrations ORDER BY version',
    );
    expect(rows).toEqual([{ version: '0001', name: 'ledger_core' }]);
  });

  it("gives the app's login nothing on ledger_meta", async () => {
    expect(await sqlState(t.appPool.query('SELECT * FROM ledger_meta.schema_migrations'))).toBe(
      '42501',
    );
  });
});
