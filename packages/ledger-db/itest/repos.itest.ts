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
import * as searchQueriesRepo from '../src/repos/searchQueriesRepo';
import { sql as sqlTag } from '../src/sql';
import { LedgerDb } from '../src/tx';
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

describe('review notices (0002)', () => {
  it("lists a client's documents in review not yet notified, marks them once, and never another client's", async () => {
    const url = 'https://tenant.sharepoint.com/sites/Klient7/Dokumenty/98/a.pdf';
    const inReview = record({
      category: 'nieposortowane',
      suggestedCategory: 'umowy',
      reviewReasons: ['LOW_CONFIDENCE'],
      webUrl: url,
    });
    const filed = record();
    const bReview = record({ category: 'nieposortowane', reviewReasons: ['NOT_CLASSIFIED'] });
    await t.db.withClientTx(A, (tx) => documentsRepo.recordReview(tx, inReview));
    await t.db.withClientTx(A, (tx) => documentsRepo.recordFiled(tx, filed));
    await t.db.withClientTx(B, (tx) => documentsRepo.recordReview(tx, bReview));

    const pendingA = await t.db.withClientTx(A, (tx) => documentsRepo.pendingReviewNotices(tx, 50));
    expect(pendingA.map((d) => d.documentId)).toContain(inReview.documentId);
    expect(pendingA.map((d) => d.documentId)).not.toContain(filed.documentId);
    expect(pendingA.map((d) => d.documentId)).not.toContain(bReview.documentId);
    expect(pendingA.find((d) => d.documentId === inReview.documentId)).toMatchObject({
      suggestedCategory: 'umowy',
      reviewReasons: ['LOW_CONFIDENCE'],
      webUrl: url,
    });

    // A cannot mark B's document: RLS hides it, so nothing is updated.
    expect(
      await t.db.withClientTx(A, (tx) =>
        documentsRepo.markReviewNotified(tx, [bReview.documentId]),
      ),
    ).toBe(0);
    expect(
      await t.db.withClientTx(A, (tx) =>
        documentsRepo.markReviewNotified(tx, [inReview.documentId]),
      ),
    ).toBe(1);
    // Marked once: a second mark touches nothing, and it is no longer pending.
    expect(
      await t.db.withClientTx(A, (tx) =>
        documentsRepo.markReviewNotified(tx, [inReview.documentId]),
      ),
    ).toBe(0);
    const after = await t.db.withClientTx(A, (tx) => documentsRepo.pendingReviewNotices(tx, 50));
    expect(after.map((d) => d.documentId)).not.toContain(inReview.documentId);
    const pendingB = await t.db.withClientTx(B, (tx) => documentsRepo.pendingReviewNotices(tx, 50));
    expect(pendingB.map((d) => d.documentId)).toContain(bReview.documentId);
  });

  it('announces a document sorted to review again after it was notified', async () => {
    const again = record({ category: 'nieposortowane', reviewReasons: ['LOW_CONFIDENCE'] });
    await t.db.withClientTx(A, (tx) => documentsRepo.recordReview(tx, again));
    await t.db.withClientTx(A, (tx) => documentsRepo.markReviewNotified(tx, [again.documentId]));
    const ids = async () =>
      (await t.db.withClientTx(A, (tx) => documentsRepo.pendingReviewNotices(tx, 50))).map(
        (d) => d.documentId,
      );
    expect(await ids()).not.toContain(again.documentId);
    // Filed meanwhile: stays notified. Sorted to review again: pending again.
    await t.db.withClientTx(A, (tx) =>
      documentsRepo.recordFiled(tx, { ...again, category: 'umowy', reviewReasons: [] }),
    );
    expect(await ids()).not.toContain(again.documentId);
    await t.db.withClientTx(A, (tx) => documentsRepo.recordReview(tx, again));
    expect(await ids()).toContain(again.documentId);
  });

  it('refuses a web link that is not https at the database too', async () => {
    const bad = record({ webUrl: 'https://ok.example/x' });
    await t.db.withClientTx(A, (tx) => documentsRepo.recordFiled(tx, bad));
    await expect(
      t.db.withClientTx(A, (tx) =>
        tx.query(
          // A statement the repository would never send: the CHECK is the last line.
          sqlTag`UPDATE ledger.documents SET web_url = 'http://x' WHERE document_id = ${bad.documentId}`,
        ),
      ),
    ).rejects.toThrow();
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
      // Shaped like ours but no instant PostgreSQL takes: refused before any SQL, not 22008.
      for (const time of ['2026-02-30T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z']) {
        const after = Buffer.from(
          JSON.stringify([time, '00000000-0000-4000-8000-000000000001']),
        ).toString('base64url');
        await expect(searchS({}, { after })).rejects.toMatchObject({ reason: 'invalid_cursor' });
      }
    });
  });
});

describe('client search (0003)', () => {
  const P = clientIdForDirectoryRow(LIST_ID, '40');
  const url = (name: string) =>
    `https://tenant.sharepoint.com/sites/Klient40/Dokumenty/${name}.pdf`;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const docs: Record<string, DocumentRecord> = {
      purchase: record({
        driveItemId: 'p-purchase',
        documentMonth: '2026-08',
        webUrl: url('purchase'),
        invoice: {
          ...invoice,
          invoiceNumber: 'FV 10/08/2026',
          sellerName: 'Dostawca 50%_Off Sp. z o.o.',
          buyerName: 'Klient 40',
        },
      }),
      sale: record({
        driveItemId: 'p-sale',
        category: 'faktury_sprzedazy',
        invoice: {
          ...invoice,
          invoiceNumber: 'INV-7',
          currency: 'EUR',
          grossAmount: '500.00',
          sellerNip: '1234567819',
          sellerName: 'Klient 40',
          buyerNip: null,
          buyerName: 'Odbiorca GmbH',
        },
      }),
      review: record({
        driveItemId: 'p-review',
        category: 'nieposortowane',
        suggestedCategory: 'faktury_zakupu',
        reviewReasons: ['LOW_CONFIDENCE'],
        invoice: {
          ...invoice,
          invoiceNumber: ' fv 10/08/2026',
          sellerNip: '1000000006',
          sellerName: 'Dostawca 50 Off',
        },
      }),
      contract: record({ driveItemId: 'p-contract', category: 'umowy' }),
    };
    delete (docs['contract'] as { invoice?: unknown }).invoice;
    await t.db.withClientTx(P, async (tx) => {
      await clientsRepo.upsertFromDirectory(tx, row('40'));
      for (const [name, doc] of Object.entries(docs)) {
        ids[name] = doc.documentId;
        if (doc.category === 'nieposortowane') await documentsRepo.recordReview(tx, doc);
        else await documentsRepo.recordFiled(tx, doc);
      }
    });
  });

  /** The names of P's documents a client-view search returns, read-only as the service runs it. */
  const found = async (filter: documentsRepo.DocumentSearchFilter): Promise<string[]> => {
    const page = await t.db.withClientTx(
      P,
      (tx) => documentsRepo.searchClientView(tx, filter, { limit: 100 }),
      { readOnly: true },
    );
    const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
    return page.items.map((d) => names[d.documentId] ?? d.documentId).sort();
  };

  it('matches a counterparty name literally, case-insensitively, on either side', async () => {
    // Under LIKE, `%` and `_` would be wildcards and '50%_off' would match '50 Off' too.
    expect(await found({ counterpartyName: '50%_off' })).toEqual(['purchase']);
    expect(await found({ counterpartyName: 'DOSTAWCA' })).toEqual(['purchase', 'review']);
    expect(await found({ counterpartyName: 'odbiorca' })).toEqual(['sale']);
    expect(await found({ counterpartyName: '_' })).toEqual(['purchase']);
  });

  it('matches a whole invoice number, trimmed and case-insensitively', async () => {
    expect(await found({ invoiceNumber: 'FV 10/08/2026' })).toEqual(['purchase', 'review']);
    expect(await found({ invoiceNumber: 'FV 10/08' })).toEqual([]);
  });

  it('filters by status, categories and currency', async () => {
    expect(await found({ status: 'in_review' })).toEqual(['review']);
    expect(await found({ status: 'filed' })).toEqual(['contract', 'purchase', 'sale']);
    expect(await found({ categories: ['faktury_zakupu', 'umowy'] })).toEqual([
      'contract',
      'purchase',
    ]);
    expect(await found({ currency: 'eur' })).toEqual(['sale']);
    expect(
      await found({
        categories: ['faktury_zakupu'],
        monthFrom: '2026-08',
        monthTo: '2026-08',
        grossMin: '1000',
        currency: 'PLN',
        counterpartyNip: '5260250274',
        status: 'filed',
      }),
    ).toEqual(['purchase']);
  });

  it('reads the client-view columns only, as text', async () => {
    const page = await t.db.withClientTx(
      P,
      (tx) => documentsRepo.searchClientView(tx, { invoiceNumber: 'INV-7' }),
      { readOnly: true },
    );
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(Object.keys(item!).sort()).toEqual([...documentsRepo.CLIENT_VIEW_FIELDS].sort());
    expect(item).toEqual({
      documentId: ids['sale'],
      status: 'FILED',
      category: 'faktury_sprzedazy',
      documentMonth: '2026-09',
      invoiceNumber: 'INV-7',
      issueDate: '2026-09-12',
      currency: 'EUR',
      grossAmount: '500.00',
      sellerNip: '1234567819',
      sellerName: 'Klient 40',
      buyerNip: null,
      buyerName: 'Odbiorca GmbH',
      webUrl: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    });
    const withLink = await t.db.withClientTx(P, (tx) =>
      documentsRepo.searchClientView(tx, { invoiceNumber: 'FV 10/08/2026', status: 'filed' }),
    );
    expect(withLink.items.map((d) => d.webUrl)).toEqual([url('purchase')]);
  });

  it('pages the client view newest first, without gaps or repeats', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await t.db.withClientTx(P, (tx) =>
        documentsRepo.searchClientView(tx, {}, { limit: 3, ...(after ? { after } : {}) }),
      );
      seen.push(...page.items.map((d) => d.documentId));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    // Recorded in one transaction, so one created_at: the id breaks the tie.
    expect(seen).toEqual(['contract', 'review', 'sale', 'purchase'].map((name) => ids[name]));
  });

  it('counts the matches up to a cap', async () => {
    const count = (filter: documentsRepo.DocumentSearchFilter, cap?: number) =>
      t.db.withClientTx(P, (tx) => documentsRepo.countMatching(tx, filter, cap), {
        readOnly: true,
      });
    expect(await count({})).toEqual({ total: 4, capped: false });
    expect(await count({}, 4)).toEqual({ total: 4, capped: false });
    expect(await count({}, 3)).toEqual({ total: 3, capped: true });
    expect(await count({}, 1)).toEqual({ total: 1, capped: true });
    expect(await count({ counterpartyName: 'dostawca' })).toEqual({ total: 2, capped: false });
    expect(await count({ status: 'in_review' }, 1)).toEqual({ total: 1, capped: false });
  });

  describe('two clients with the same counterparty', () => {
    const X = clientIdForDirectoryRow(LIST_ID, '42');
    const Y = clientIdForDirectoryRow(LIST_ID, '43');
    const shared = {
      ...invoice,
      invoiceNumber: 'FV 1/WSP/2026',
      sellerNip: '5260250274',
      sellerName: 'Wspólny Dostawca Sp. z o.o.',
      buyerNip: null,
      buyerName: 'Wspólny Odbiorca',
    };
    const xIds: string[] = [];
    const yIds: string[] = [];

    beforeAll(async () => {
      for (const [scope, listItemId, out, count] of [
        [X, '42', xIds, 3],
        [Y, '43', yIds, 2],
      ] as const) {
        await t.db.withClientTx(scope, async (tx) => {
          await clientsRepo.upsertFromDirectory(tx, row(listItemId));
          for (let i = 0; i < count; i += 1) {
            const doc = record({ driveItemId: `shared-${listItemId}-${i}`, invoice: shared });
            await documentsRepo.recordFiled(tx, doc);
            out.push(doc.documentId);
          }
        });
      }
    });

    it.each([
      [{ counterpartyNip: '5260250274' }],
      [{ counterpartyName: 'wspólny dostawca' }],
      [{ counterpartyName: 'Wspólny Odbiorca' }],
      [{ invoiceNumber: 'FV 1/WSP/2026' }],
      [{}],
    ])("the other client's search by %j returns none of this client's rows", async (filter) => {
      const inY = await t.db.withClientTx(
        Y,
        (tx) => documentsRepo.searchClientView(tx, filter, { limit: 100 }),
        { readOnly: true },
      );
      expect(inY.items.map((d) => d.documentId).sort()).toEqual([...yIds].sort());
      expect(inY.items.filter((d) => xIds.includes(d.documentId))).toEqual([]);
      const countY = await t.db.withClientTx(Y, (tx) => documentsRepo.countMatching(tx, filter));
      expect(countY).toEqual({ total: yIds.length, capped: false });
      const fullY = await t.db.withClientTx(Y, (tx) =>
        documentsRepo.search(tx, filter, { limit: 100 }),
      );
      expect(fullY.items.every((d) => d.clientId === Y)).toBe(true);
      const inX = await t.db.withClientTx(X, (tx) =>
        documentsRepo.searchClientView(tx, filter, { limit: 100 }),
      );
      expect(inX.items.map((d) => d.documentId).sort()).toEqual([...xIds].sort());
    });
  });
});

describe('searchQueriesRepo (0003)', () => {
  let q = 0;
  /** A fresh query id. */
  const queryId = () => {
    q += 1;
    return `5e000000-0000-4000-8000-${String(q).padStart(12, '0')}`;
  };
  /** A fresh asker. */
  let u = 0;
  const newOid = () => {
    u += 1;
    return `0e000000-0000-4000-8000-${String(u).padStart(12, '0')}`;
  };

  /** Searches recorded `ageSeconds` ago, as the superuser (setup only). */
  async function seed(
    clientId: string,
    userOid: string,
    kind: searchQueriesRepo.SearchQueryKind,
    count: number,
    ageSeconds: number,
  ): Promise<void> {
    await t.admin.query(
      `INSERT INTO ledger.search_queries (query_id, client_id, user_oid, kind, outcome, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'ok', now() - make_interval(secs => $4)
       FROM generate_series(1, $5)`,
      [clientId, userOid, kind, ageSeconds, count],
    );
  }

  async function rowsOf(clientId: string, userOid?: string): Promise<number> {
    const { rows } = await t.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger.search_queries
       WHERE client_id = $1 AND ($2::uuid IS NULL OR user_oid = $2::uuid)`,
      [clientId, userOid ?? null],
    );
    return rows[0]?.n ?? -1;
  }

  const reserveIn = (
    clientId: string,
    userOid: string,
    kind: searchQueriesRepo.SearchQueryKind,
    db: LedgerDb = t.db,
  ) =>
    db.withClientTx(clientId, (tx) =>
      searchQueriesRepo.reserve(tx, { queryId: queryId(), userOid, kind }),
    );

  const R = clientIdForDirectoryRow(LIST_ID, '44');
  const C = clientIdForDirectoryRow(LIST_ID, '45');
  const U = clientIdForDirectoryRow(LIST_ID, '46');

  beforeAll(async () => {
    for (const [scope, listItemId] of [
      [R, '44'],
      [C, '45'],
      [U, '46'],
    ] as const) {
      await t.db.withClientTx(scope, (tx) => clientsRepo.upsertFromDirectory(tx, row(listItemId)));
    }
  });

  it('takes the 10th question in 5 minutes and refuses the 11th until the oldest leaves', async () => {
    const oid = newOid();
    await seed(R, oid, 'question', 9, 60);
    expect(await reserveIn(R, oid, 'question')).toEqual({ status: 'ok' });
    expect(await rowsOf(R, oid)).toBe(10);
    const limited = await reserveIn(R, oid, 'question');
    expect(limited).toMatchObject({ status: 'rate_limited', quota: 'user_questions_5m' });
    // The oldest counted question was 60 s ago: room again in about 240 s.
    const seconds = (limited as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(seconds).toBeGreaterThanOrEqual(230);
    expect(seconds).toBeLessThanOrEqual(241);
    // Refused: nothing recorded. A typed request is another window.
    expect(await rowsOf(R, oid)).toBe(10);
    expect(await reserveIn(R, oid, 'typed')).toEqual({ status: 'ok' });
  });

  it('forgets questions older than the window', async () => {
    const oid = newOid();
    await seed(R, oid, 'question', 10, 301);
    expect(await reserveIn(R, oid, 'question')).toEqual({ status: 'ok' });
  });

  it('allows 60 questions a day per asker', async () => {
    const oid = newOid();
    await seed(R, oid, 'question', 60, 2 * 3600);
    await seed(R, oid, 'question', 5, 86_400 + 60);
    const limited = await reserveIn(R, oid, 'question');
    expect(limited).toMatchObject({ status: 'rate_limited', quota: 'user_questions_24h' });
    const seconds = (limited as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(Math.abs(seconds - 22 * 3600)).toBeLessThanOrEqual(10);
    expect(await reserveIn(R, oid, 'page')).toEqual({ status: 'ok' });
    // Another asker of the same client is not held back.
    expect(await reserveIn(R, newOid(), 'question')).toEqual({ status: 'ok' });
  });

  it('allows 30 typed or page requests in 5 minutes per asker', async () => {
    const oid = newOid();
    await seed(R, oid, 'typed', 20, 10);
    await seed(R, oid, 'page', 10, 10);
    for (const kind of ['typed', 'page'] as const) {
      expect(await reserveIn(R, oid, kind)).toMatchObject({
        status: 'rate_limited',
        quota: 'user_typed_5m',
      });
    }
    expect(await reserveIn(R, oid, 'question')).toEqual({ status: 'ok' });
  });

  it('allows 300 questions a day per client, whoever asks them', async () => {
    for (let i = 0; i < 30; i += 1) await seed(C, newOid(), 'question', 10, 3600);
    await seed(C, newOid(), 'question', 50, 86_400 + 60);
    const limited = await reserveIn(C, newOid(), 'question');
    expect(limited).toMatchObject({ status: 'rate_limited', quota: 'client_questions_24h' });
    const seconds = (limited as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(Math.abs(seconds - 23 * 3600)).toBeLessThanOrEqual(10);
    expect(await reserveIn(C, newOid(), 'typed')).toEqual({ status: 'ok' });
    // Another client's questions are its own.
    expect(await reserveIn(R, newOid(), 'question')).toEqual({ status: 'ok' });
  });

  it('lets exactly one of two concurrent reservations take the last slot', async () => {
    const oid = newOid();
    await seed(U, oid, 'question', 9, 10);
    // A second app connection, as a second worker has.
    const other = new LedgerDb(t.pool(t.appLogin));
    const advisory = async (granted: boolean) =>
      (
        await t.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND objsubid = 2 AND granted = $1`,
          [granted],
        )
      ).rows[0]?.n ?? 0;
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 400 && !(await check()); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await check()).toBe(true);
    };

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The first reserves (its row not yet committed) and keeps its transaction open…
    const first = t.db.withClientTx(U, async (tx) => {
      const result = await searchQueriesRepo.reserve(tx, {
        queryId: queryId(),
        userOid: oid,
        kind: 'question',
      });
      await held;
      return result;
    });
    await until(async () => (await advisory(true)) === 1);
    // …while the second, on the other connection, waits for the lock…
    const second = reserveIn(U, oid, 'question', other);
    await until(async () => (await advisory(false)) === 1);
    // …and counts after the first committed: 10 of 10.
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'rate_limited']);
    expect(await rowsOf(U, oid)).toBe(10);

    // Both at once, with no help: still exactly one.
    const oid2 = newOid();
    await seed(U, oid2, 'question', 9, 10);
    const both = await Promise.all([
      reserveIn(U, oid2, 'question'),
      reserveIn(U, oid2, 'question', other),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(['ok', 'rate_limited']);
    expect(await rowsOf(U, oid2)).toBe(10);
  });

  it('records how a search ended, once, with codes and counts only', async () => {
    const oid = newOid();
    const id = queryId();
    await t.db.withClientTx(R, (tx) =>
      searchQueriesRepo.reserve(tx, { queryId: id, userOid: oid, kind: 'question' }),
    );
    const digest = searchQueriesRepo.filterDigest({
      counterpartyNip: '5260250274',
      counterpartyName: 'Dostawca',
    });
    const finished = await t.db.withClientTx(R, (tx) =>
      searchQueriesRepo.finish(tx, {
        queryId: id,
        outcome: 'ok',
        ...digest,
        resultCount: 3,
        model: 'claude-sonnet-5',
        tokens: { inputTokens: 90, outputTokens: 110, cacheReadTokens: 1300, cacheWriteTokens: 0 },
        latencyMs: 640,
      }),
    );
    expect(finished).toBe(true);
    // Not twice; not from another client's scope.
    expect(
      await t.db.withClientTx(R, (tx) =>
        searchQueriesRepo.finish(tx, { queryId: id, outcome: 'unavailable' }),
      ),
    ).toBe(false);
    expect(
      await t.db.withClientTx(C, (tx) =>
        searchQueriesRepo.finish(tx, { queryId: id, outcome: 'unavailable' }),
      ),
    ).toBe(false);
    const { rows } = await t.admin.query(
      `SELECT client_id::text, user_oid::text, kind, outcome, filter_sha256, filter_fields,
              result_count, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, latency_ms, updated_at >= created_at AS stamped
       FROM ledger.search_queries WHERE query_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        client_id: R,
        user_oid: oid,
        kind: 'question',
        outcome: 'ok',
        filter_sha256: digest.filterSha256,
        filter_fields: ['counterpartyName', 'counterpartyNip'],
        result_count: 3,
        model: 'claude-sonnet-5',
        input_tokens: 90,
        output_tokens: 110,
        cache_read_tokens: 1300,
        cache_write_tokens: 0,
        latency_ms: 640,
        stamped: true,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/5260250274|Dostawca/);
  });

  it('refuses a value where only a field name may go, at the database too', async () => {
    const id = queryId();
    await t.db.withClientTx(R, (tx) =>
      searchQueriesRepo.reserve(tx, { queryId: id, userOid: newOid(), kind: 'typed' }),
    );
    const state = await sqlState(
      t.db.withClientTx(R, (tx) =>
        tx.query(
          // A statement the repository would never send: the CHECK is the last line.
          sqlTag`UPDATE ledger.search_queries SET filter_fields = ${['5260250274']}::text[]
                 WHERE query_id = ${id}`,
        ),
      ),
    );
    expect(state).toBe('23514');
  });
});

describe('the migration runner', () => {
  it('is a no-op the second time, and verify.sql still passes', async () => {
    const run = await applyMigrations(t.admin, loadMigrations());
    expect(run).toEqual({
      applied: [],
      alreadyApplied: ['0001_ledger_core', '0002_review_notices', '0003_search_queries'],
    });
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
    expect(rows).toEqual([
      { version: '0001', name: 'ledger_core' },
      { version: '0002', name: 'review_notices' },
      { version: '0003', name: 'search_queries' },
    ]);
  });

  it("gives the app's login nothing on ledger_meta", async () => {
    expect(await sqlState(t.appPool.query('SELECT * FROM ledger_meta.schema_migrations'))).toBe(
      '42501',
    );
  });
});
