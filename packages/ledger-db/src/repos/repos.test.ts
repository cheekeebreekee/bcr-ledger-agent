import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientSearchFilter } from '@bcr/shared';
import { clientIdForDirectoryRow } from '../clientScope';
import { MIGRATIONS_DIR } from '../migrate';
import { LedgerDb, type ClientTx, type ConnectionLike } from '../tx';
import * as clientsRepo from './clientsRepo';
import * as documentsRepo from './documentsRepo';
import type { DocumentRecord } from './documentsRepo';
import { SEARCH_FILTER_FIELDS, parseSearchFilter } from './searchFilter';
import * as searchQueriesRepo from './searchQueriesRepo';

const LIST = 'c0ffee00-1234-4abc-9def-00112233aabb';
const A = clientIdForDirectoryRow(LIST, '7');

interface Call {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Runs `fn` in a real ClientTx over a fake connection. `rows` answers each
 * statement after the scoping ones; the calls are the statements `fn` ran.
 */
async function inTx<T>(
  fn: (tx: ClientTx) => Promise<T>,
  rows: (text: string, values: unknown[]) => unknown[] = () => [],
  clientId: string = A,
): Promise<{ result: T; calls: Call[] }> {
  const calls: Call[] = [];
  const conn: ConnectionLike = {
    async query(a: string | { text: string; values: unknown[] }, b?: unknown[]) {
      const call = typeof a === 'string' ? { text: a, values: b ?? [] } : a;
      calls.push(call);
      return { rows: rows(call.text, call.values) };
    },
    release() {},
    on() {},
    removeListener() {},
  };
  const db = new LedgerDb({ connect: async () => conn, end: async () => undefined });
  const result = await db.withClientTx(clientId, fn);
  // BEGIN, SET LOCAL ROLE, set_config … COMMIT are withClientTx's own.
  return { result, calls: calls.slice(3, -1) };
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('clientsRepo.upsertFromDirectory', () => {
  const row = {
    directoryListId: LIST,
    listItemId: '7',
    clientNo: ' 0007 ',
    nip: '123-456-78-19',
    legalName: 'Klient Testowy Sp. z o.o.',
    active: true,
  };

  it('upserts by list item id, with the scope as client_id and a normalised NIP', async () => {
    const { calls } = await inTx(
      (tx) => clientsRepo.upsertFromDirectory(tx, row),
      () => [{ client_id: A }],
    );
    expect(calls).toHaveLength(1);
    expect(flat(calls[0]!.text)).toContain(
      'INSERT INTO ledger.clients (client_id, directory_list_item_id, client_no, nip, legal_name, status)',
    );
    expect(flat(calls[0]!.text)).toContain('ON CONFLICT (directory_list_item_id) DO UPDATE SET');
    expect(calls[0]!.values).toEqual([A, '7', '0007', '1234567819', row.legalName, 'active']);
  });

  it('stores an invalid NIP and blank names as NULL, and an inactive row as such', async () => {
    const { calls } = await inTx(
      (tx) =>
        clientsRepo.upsertFromDirectory(tx, {
          ...row,
          nip: '1234567810',
          clientNo: '',
          legalName: '  ',
          active: false,
        }),
      () => [{ client_id: A }],
    );
    expect(calls[0]!.values).toEqual([A, '7', null, null, null, 'inactive']);
  });

  it("refuses a row that is not the transaction's scope, before any statement", async () => {
    const other = { ...row, listItemId: '8' };
    await expect(inTx((tx) => clientsRepo.upsertFromDirectory(tx, other))).rejects.toMatchObject({
      reason: 'scope_mismatch',
    });
  });

  it('refuses when the database hands back another client', async () => {
    await expect(
      inTx(
        (tx) => clientsRepo.upsertFromDirectory(tx, row),
        () => [{ client_id: '00000000-0000-4000-8000-000000000000' }],
      ),
    ).rejects.toMatchObject({ reason: 'scope_mismatch' });
  });

  it('refuses a transaction handle it did not get from withClientTx', async () => {
    await expect(
      clientsRepo.upsertFromDirectory({ clientId: A, query: async () => [] }, row),
    ).rejects.toMatchObject({ reason: 'tx_closed' });
  });
});

const record: DocumentRecord = {
  documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  source: 'bot',
  driveId: 'b!drive',
  driveItemId: 'item-1',
  category: 'nieposortowane',
  suggestedCategory: 'faktury_zakupu',
  confidence: 0.456,
  classifier: 'claude',
  model: 'claude-opus-5',
  reviewReasons: ['LOW_CONFIDENCE'],
  documentMonth: '2026-09',
  folderPath: '98_Nieposortowane/2026/09',
  uploadedByOid: '11111111-2222-4333-8444-555555555555',
  contentSha256: 'f'.repeat(64),
  sizeBytes: 2048,
  invoice: {
    invoiceNumber: 'FV 1/2026',
    issueDate: '2026-09-12',
    saleDate: null,
    currency: 'PLN',
    netAmount: '100.00',
    vatAmount: '23.00',
    grossAmount: '123.00',
    sellerNip: '5260250274',
    sellerName: 'Dostawca S.A.',
    buyerNip: '1234567819',
    buyerName: 'Klient',
    ksefNumber: null,
  },
};

describe('documentsRepo.recordFiled / recordReview', () => {
  it('writes every column in the scope, with the status, and reports a new row', async () => {
    const { result, calls } = await inTx(
      (tx) => documentsRepo.recordReview(tx, record),
      () => [{ document_id: record.documentId, created: true }],
    );
    expect(result).toEqual({ documentId: record.documentId, created: true });
    expect(flat(calls[0]!.text)).toContain('ON CONFLICT (client_id, drive_item_id) DO UPDATE SET');
    expect(calls[0]!.values).toEqual([
      record.documentId,
      A,
      'bot',
      'b!drive',
      'item-1',
      'NEEDS_REVIEW',
      'nieposortowane',
      'faktury_zakupu',
      0.46,
      'claude',
      'claude-opus-5',
      ['LOW_CONFIDENCE'],
      '2026-09-01',
      '98_Nieposortowane/2026/09',
      '11111111-2222-4333-8444-555555555555',
      'f'.repeat(64),
      2048,
      'FV 1/2026',
      '2026-09-12',
      null,
      'PLN',
      '100.00',
      '23.00',
      '123.00',
      '5260250274',
      'Dostawca S.A.',
      '1234567819',
      'Klient',
      null,
      null,
    ]);
  });

  it('writes the web link when there is one, and keeps an earlier one on a rewrite without', async () => {
    const url = 'https://tenant.sharepoint.com/sites/Klient/Dokumenty/f.pdf';
    const { calls } = await inTx(
      (tx) => documentsRepo.recordFiled(tx, { ...record, webUrl: url }),
      () => [{ document_id: record.documentId, created: true }],
    );
    expect(calls[0]!.values.at(-1)).toBe(url);
    expect(flat(calls[0]!.text)).toContain(
      'web_url = COALESCE(EXCLUDED.web_url, ledger.documents.web_url)',
    );
  });

  it('writes NULL for everything optional that is absent, with FILED', async () => {
    const minimal: DocumentRecord = {
      documentId: record.documentId,
      source: 'inbox',
      driveId: 'd',
      driveItemId: 'i',
      category: 'umowy',
      reviewReasons: [],
    };
    const { result, calls } = await inTx(
      (tx) => documentsRepo.recordFiled(tx, minimal),
      () => [{ document_id: 'first-id', created: false }],
    );
    expect(result).toEqual({ documentId: 'first-id', created: false });
    const values = calls[0]!.values;
    expect(values.slice(0, 7)).toEqual([record.documentId, A, 'inbox', 'd', 'i', 'FILED', 'umowy']);
    expect(
      values.slice(7).filter((v) => v !== null && !(Array.isArray(v) && v.length === 0)),
    ).toEqual([]);
  });

  it.each([
    [{ documentId: 'nope' }, 'documentId'],
    [{ source: 'mail' }, 'source'],
    [{ driveItemId: '' }, 'driveItemId'],
    [{ category: 'Faktury Zakupu' }, 'category'],
    [{ confidence: 1.5 }, 'confidence'],
    [{ reviewReasons: ['low confidence'] }, 'reviewReasons.0'],
    [{ documentMonth: '2026-13' }, 'documentMonth'],
    [{ uploadedByOid: 'someone' }, 'uploadedByOid'],
    [{ contentSha256: 'abc' }, 'contentSha256'],
    [{ webUrl: 'http://tenant.sharepoint.com/x' }, 'webUrl'],
    [{ webUrl: 'https://tenant.sharepoint.com/a b' }, 'webUrl'],
    [{ invoice: { ...record.invoice!, grossAmount: '1 230,00' } }, 'invoice.grossAmount'],
    [{ invoice: { ...record.invoice!, buyerNip: '1234567810' } }, 'invoice.buyerNip'],
    [{ unexpected: true }, ''],
  ])('refuses %j, naming the field only', async (over, field) => {
    await expect(
      inTx((tx) => documentsRepo.recordFiled(tx, { ...record, ...over } as DocumentRecord)),
    ).rejects.toThrow(`the document record is invalid: ${field}`);
  });

  it('fails when the database writes no row', async () => {
    await expect(inTx((tx) => documentsRepo.recordFiled(tx, record))).rejects.toMatchObject({
      reason: 'invalid_record',
    });
  });
});

describe('documentsRepo review notices', () => {
  it('reads the scope’s documents in review not yet notified, oldest first, bounded', async () => {
    const { result, calls } = await inTx(
      (tx) => documentsRepo.pendingReviewNotices(tx, 500),
      () => [{ documentId: record.documentId }],
    );
    expect(result).toEqual([{ documentId: record.documentId }]);
    const text = flat(calls[0]!.text);
    expect(text).toContain(
      "WHERE client_id = $1 AND status = 'NEEDS_REVIEW' AND review_notified_at IS NULL",
    );
    expect(text).toContain('ORDER BY created_at, document_id LIMIT $2');
    expect(calls[0]!.values).toEqual([A, documentsRepo.REVIEW_NOTICE_MAX_LIMIT]);
    const one = await inTx((tx) => documentsRepo.pendingReviewNotices(tx, 0));
    expect(one.calls[0]!.values).toEqual([A, 1]);
  });

  it('marks only the scope’s rows still pending, and says how many', async () => {
    const ids = [record.documentId, '11111111-2222-4333-8444-555555555555'];
    const { result, calls } = await inTx(
      (tx) => documentsRepo.markReviewNotified(tx, ids),
      () => [{ document_id: ids[0] }],
    );
    expect(result).toBe(1);
    const text = flat(calls[0]!.text);
    expect(text).toContain('UPDATE ledger.documents SET review_notified_at = now()');
    expect(text).toContain('WHERE client_id = $1 AND document_id = ANY($2::uuid[])');
    expect(text).toContain('AND review_notified_at IS NULL');
    expect(calls[0]!.values).toEqual([A, ids]);
  });

  it('runs no statement for no ids, and refuses an id that is not a UUID', async () => {
    const none = await inTx((tx) => documentsRepo.markReviewNotified(tx, []));
    expect(none).toEqual({ result: 0, calls: [] });
    await expect(
      inTx((tx) => documentsRepo.markReviewNotified(tx, ["x' OR 1=1 --"])),
    ).rejects.toMatchObject({ reason: 'invalid_record' });
  });
});

describe('documentsRepo reads', () => {
  it('finds a drive item within the scope, or null', async () => {
    const found = await inTx(
      (tx) => documentsRepo.findByDriveItem(tx, 'item-1'),
      () => [{ documentId: record.documentId }],
    );
    expect(found.result).toEqual({ documentId: record.documentId });
    expect(found.calls[0]!.values).toEqual([A, 'item-1']);
    expect(flat(found.calls[0]!.text)).toContain('WHERE client_id = $1 AND drive_item_id = $2');
    const none = await inTx((tx) => documentsRepo.findByDriveItem(tx, 'x'));
    expect(none.result).toBeNull();
  });

  it('counts per month and status, scoped', async () => {
    const counts = [{ month: '2026-09', status: 'FILED', documents: 3 }];
    const { result, calls } = await inTx(
      (tx) => documentsRepo.monthlyCounts(tx),
      () => counts,
    );
    expect(result).toEqual(counts);
    expect(calls[0]!.values).toEqual([A]);
  });
});

describe('documentsRepo.search', () => {
  const row = (i: number) => ({
    documentId: `00000000-0000-4000-8000-00000000000${i}`,
    createdAt: `2026-09-26T10:00:0${i}.000000Z`,
  });

  it('builds one parameterised statement from the filter, newest first', async () => {
    const { calls } = await inTx((tx) =>
      documentsRepo.search(tx, {
        category: 'faktury_zakupu',
        monthFrom: '2026-01',
        monthTo: '2026-06',
        grossMin: '1 000,5',
        grossMax: 2000,
        counterpartyNip: 'PL 526-025-02-74',
      }),
    );
    expect(flat(calls[0]!.text)).toContain(
      'WHERE client_id = $1 AND category = $2 AND document_month >= $3::date AND ' +
        'document_month <= $4::date AND gross_amount >= $5::numeric AND ' +
        'gross_amount <= $6::numeric AND (seller_nip = $7 OR buyer_nip = $8) ' +
        'ORDER BY created_at DESC, document_id DESC LIMIT $9',
    );
    expect(calls[0]!.values).toEqual([
      A,
      'faktury_zakupu',
      '2026-01-01',
      '2026-06-01',
      '1000.50',
      '2000.00',
      '5260250274',
      '5260250274',
      26,
    ]);
  });

  it('returns a cursor only when there is a next page, and follows it', async () => {
    const three = [row(3), row(2), row(1)];
    const first = await inTx(
      (tx) => documentsRepo.search(tx, {}, { limit: 2 }),
      () => three,
    );
    expect(first.result.items).toEqual([row(3), row(2)]);
    expect(first.result.nextCursor).toBe(documentsRepo.encodeCursor(row(2)));

    const second = await inTx(
      (tx) => documentsRepo.search(tx, {}, { limit: 2, after: first.result.nextCursor! }),
      () => [row(1)],
    );
    expect(second.result).toEqual({ items: [row(1)], nextCursor: null });
    expect(flat(second.calls[0]!.text)).toContain(
      '(created_at, document_id) < ($2::timestamptz, $3::uuid)',
    );
    expect(second.calls[0]!.values).toEqual([A, row(2).createdAt, row(2).documentId, 3]);
  });

  it.each([
    [{ client: 'x' }],
    [{ category: 'DROP TABLE' }],
    [{ monthFrom: '2026-1' }],
    [{ grossMin: '1.234,50' }],
    [{ counterpartyNip: '1234567810' }],
    [{ limit: 10 }],
  ])('refuses the filter %j', async (filter) => {
    await expect(
      inTx((tx) => documentsRepo.search(tx, filter as documentsRepo.DocumentSearchFilter)),
    ).rejects.toMatchObject({ reason: 'invalid_filter' });
  });

  it.each([0, 101, 2.5])('refuses a page size of %p', async (limit) => {
    await expect(inTx((tx) => documentsRepo.search(tx, {}, { limit }))).rejects.toMatchObject({
      reason: 'invalid_filter',
    });
  });

  it.each([
    'not base64 json',
    Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from(JSON.stringify(['2026-09-26', row(1).documentId])).toString('base64url'),
    Buffer.from(JSON.stringify([row(1).createdAt, "x' OR 1=1"])).toString('base64url'),
    // Shaped right, but no instant PostgreSQL takes (it would answer 22008, read as an outage).
    ...[
      '2026-02-30T00:00:00.000000Z',
      '2026-13-01T00:00:00.000000Z',
      '2026-09-28T24:00:00.000000Z',
      '2026-09-28T99:00:00.000000Z',
      '2026-09-28T23:59:60.000000Z',
      '0000-01-01T00:00:00.000000Z',
    ].map((time) => Buffer.from(JSON.stringify([time, row(1).documentId])).toString('base64url')),
  ])('refuses a cursor it did not issue: %j', async (after) => {
    await expect(inTx((tx) => documentsRepo.search(tx, {}, { after }))).rejects.toMatchObject({
      reason: 'invalid_cursor',
    });
  });
});

/** The part of a search statement after its select list: conditions, order, limit. */
const whereOf = (text: string) => flat(text).slice(flat(text).indexOf('WHERE'));

describe('documentsRepo search filters (client search)', () => {
  it('builds the client-search fields as fixed fragments, every value a parameter', async () => {
    const { calls } = await inTx((tx) =>
      documentsRepo.search(tx, {
        categories: ['umowy', 'faktury_zakupu', 'umowy'],
        status: 'in_review',
        currency: 'eur',
        counterpartyName: ' 50%_Off   Sp. ',
        invoiceNumber: ' FV 1/2026 ',
      }),
    );
    const text = flat(calls[0]!.text);
    expect(text).toContain(
      'WHERE client_id = $1 AND category = ANY($2::text[]) AND status = $3 AND currency = $4 AND ' +
        '(strpos(lower(seller_name), lower($5::text)) > 0 OR ' +
        'strpos(lower(buyer_name), lower($6::text)) > 0) AND ' +
        'lower(btrim(invoice_number)) = lower($7::text) ' +
        'ORDER BY created_at DESC, document_id DESC LIMIT $8',
    );
    // % and _ reach SQL as characters of a parameter: there is no LIKE to read them.
    expect(text).not.toMatch(/\bI?LIKE\b|SIMILAR TO|~/i);
    expect(calls[0]!.values).toEqual([
      A,
      ['umowy', 'faktury_zakupu'],
      'NEEDS_REVIEW',
      'EUR',
      '50%_Off Sp.',
      '50%_Off Sp.',
      'FV 1/2026',
      26,
    ]);
    const filed = await inTx((tx) => documentsRepo.search(tx, { status: 'filed' }));
    expect(filed.calls[0]!.values).toEqual([A, 'FILED', 26]);
  });

  it("takes @bcr/shared's ClientSearchFilter as it is", async () => {
    const filter: ClientSearchFilter = {
      categories: ['faktury_zakupu'],
      monthFrom: '2026-01',
      monthTo: '2026-09',
      grossMin: '100',
      grossMax: '2000.50',
      currency: 'PLN',
      counterpartyNip: '5260250274',
      counterpartyName: 'Dostawca',
      invoiceNumber: 'FV 1/2026',
      status: 'filed',
    };
    // A compile error, not a test failure, if the two filters ever drift apart.
    const asIndexFilter: documentsRepo.DocumentSearchFilter = filter;
    const { calls } = await inTx((tx) => documentsRepo.searchClientView(tx, asIndexFilter));
    expect(calls[0]!.values).toEqual([
      A,
      '2026-01-01',
      '2026-09-01',
      '100.00',
      '2000.50',
      '5260250274',
      '5260250274',
      ['faktury_zakupu'],
      'FILED',
      'PLN',
      'Dostawca',
      'Dostawca',
      'FV 1/2026',
      11,
    ]);
  });

  it.each([
    [{ categories: [] }, 'categories'],
    [{ categories: ['DROP TABLE'] }, 'categories.0'],
    [{ status: 'FILED' }, 'status'],
    [{ currency: 'XYZ' }, 'currency'],
    [{ counterpartyName: '   ' }, 'counterpartyName'],
    [{ counterpartyName: 'x'.repeat(61) }, 'counterpartyName'],
    [{ counterpartyName: 'a\u0000b' }, 'counterpartyName'],
    [{ invoiceNumber: 'x'.repeat(61) }, 'invoiceNumber'],
    [{ clientId: A }, ''],
  ])('refuses the filter %j, naming the field only', async (filter, field) => {
    await expect(
      inTx((tx) =>
        documentsRepo.searchClientView(tx, filter as documentsRepo.DocumentSearchFilter),
      ),
    ).rejects.toThrow(`the search filter is invalid: ${field}`);
  });
});

describe('documentsRepo.searchClientView', () => {
  /** The select list's output names, in order (commas inside parentheses are not separators). */
  const selected = (text: string) =>
    flat(text)
      .slice('SELECT '.length, flat(text).indexOf(' FROM ledger.documents'))
      .split(/,\s*(?![^()]*\))/)
      .map((item) => /\sAS "?(\w+)"?$/.exec(item.trim())?.[1] ?? item.trim());

  it('selects exactly the client-view columns, and nothing a client must not see', async () => {
    const { calls } = await inTx((tx) => documentsRepo.searchClientView(tx, {}));
    expect(selected(calls[0]!.text)).toEqual([...documentsRepo.CLIENT_VIEW_FIELDS]);
    const list = flat(calls[0]!.text).slice(0, flat(calls[0]!.text).indexOf(' FROM '));
    for (const hidden of [
      'client_id',
      'source',
      'drive_id',
      'drive_item_id',
      'suggested_category',
      'confidence',
      'classifier',
      'model',
      'review_reasons',
      'folder_path',
      'uploaded_by_oid',
      'content_sha256',
      'size_bytes',
      'review_notified_at',
    ]) {
      expect(list).not.toMatch(new RegExp(`\\b${hidden}\\b`));
    }
  });

  it('shares the conditions of search: the same WHERE for the same filter, 10 a page', async () => {
    const filter = { categories: ['umowy'], counterpartyName: 'Dostawca', grossMin: 5 };
    const full = await inTx((tx) => documentsRepo.search(tx, filter, { limit: 10 }));
    const view = await inTx((tx) => documentsRepo.searchClientView(tx, filter));
    expect(whereOf(view.calls[0]!.text)).toBe(whereOf(full.calls[0]!.text));
    expect(view.calls[0]!.values).toEqual(full.calls[0]!.values);
    expect(view.calls[0]!.values.at(-1)).toBe(11);
  });

  it('pages with the same keyset cursor', async () => {
    const row = (i: number) => ({
      documentId: `00000000-0000-4000-8000-00000000000${i}`,
      createdAt: `2026-09-26T10:00:0${i}.000000Z`,
    });
    const first = await inTx(
      (tx) => documentsRepo.searchClientView(tx, {}, { limit: 1 }),
      () => [row(2), row(1)],
    );
    expect(first.result).toEqual({
      items: [row(2)],
      nextCursor: documentsRepo.encodeCursor(row(2)),
    });
    const next = await inTx((tx) =>
      documentsRepo.searchClientView(tx, {}, { after: first.result.nextCursor! }),
    );
    expect(next.calls[0]!.values).toEqual([A, row(2).createdAt, row(2).documentId, 11]);
    await expect(
      inTx((tx) => documentsRepo.searchClientView(tx, {}, { after: 'x' })),
    ).rejects.toMatchObject({ reason: 'invalid_cursor' });
    await expect(
      inTx((tx) => documentsRepo.searchClientView(tx, {}, { limit: 101 })),
    ).rejects.toMatchObject({ reason: 'invalid_filter' });
  });

  it('refuses a transaction handle it did not get from withClientTx', async () => {
    await expect(
      documentsRepo.searchClientView({ clientId: A, query: async () => [] }, {}),
    ).rejects.toMatchObject({ reason: 'tx_closed' });
  });
});

describe('documentsRepo.countMatching', () => {
  it('counts no further than the cap, with the conditions of search', async () => {
    const filter = { status: 'in_review' as const, counterpartyNip: '526-025-02-74' };
    const { result, calls } = await inTx(
      (tx) => documentsRepo.countMatching(tx, filter),
      () => [{ n: 501 }],
    );
    expect(result).toEqual({ total: 500, capped: true });
    const text = flat(calls[0]!.text);
    expect(text).toMatch(/^SELECT count\(\*\)::int AS n FROM \( SELECT 1 FROM ledger\.documents /);
    expect(text).toContain('LIMIT $5 ) AS matching');
    expect(calls[0]!.values).toEqual([A, '5260250274', '5260250274', 'NEEDS_REVIEW', 501]);
    const full = await inTx((tx) => documentsRepo.search(tx, filter));
    expect(calls[0]!.values.slice(0, -1)).toEqual(full.calls[0]!.values.slice(0, -1));
    expect(whereOf(text).replace(/ LIMIT .*$/, '')).toBe(
      whereOf(full.calls[0]!.text).replace(/ ORDER BY .*$/, ''),
    );
  });

  it.each([
    [500, 500, { total: 500, capped: false }],
    [3, 4, { total: 3, capped: true }],
    [3, 0, { total: 0, capped: false }],
  ])('with cap %p and %p rows counted: %j', async (cap, n, expected) => {
    const { result, calls } = await inTx(
      (tx) => documentsRepo.countMatching(tx, {}, cap),
      () => [{ n }],
    );
    expect(result).toEqual(expected);
    expect(calls[0]!.values).toEqual([A, cap + 1]);
  });

  it('reads no row as none', async () => {
    const { result } = await inTx((tx) => documentsRepo.countMatching(tx, {}));
    expect(result).toEqual({ total: 0, capped: false });
  });

  it.each([0, 10_001, 2.5])('refuses a cap of %p', async (cap) => {
    await expect(inTx((tx) => documentsRepo.countMatching(tx, {}, cap))).rejects.toMatchObject({
      reason: 'invalid_filter',
    });
  });

  it('refuses a filter it cannot hold, and a forged handle', async () => {
    await expect(
      inTx((tx) => documentsRepo.countMatching(tx, { limit: 1 } as never)),
    ).rejects.toMatchObject({ reason: 'invalid_filter' });
    await expect(
      documentsRepo.countMatching({ clientId: A, query: async () => [] }, {}),
    ).rejects.toMatchObject({ reason: 'tx_closed' });
  });
});

describe('the search filter fields', () => {
  it('are every key the filter takes, and only those', () => {
    const every = {
      categories: ['umowy'],
      category: 'umowy',
      counterpartyName: 'a',
      counterpartyNip: '5260250274',
      currency: 'PLN',
      grossMax: '2',
      grossMin: '1',
      invoiceNumber: 'b',
      monthFrom: '2026-01',
      monthTo: '2026-02',
      status: 'filed' as const,
    };
    expect(Object.keys(parseSearchFilter(every)).sort()).toEqual(SEARCH_FILTER_FIELDS);
    expect(() => parseSearchFilter({ ...every, sellerName: 'x' } as never)).toThrow(
      'the search filter is invalid: ',
    );
  });

  it("are exactly the names migration 0003's CHECK allows in filter_fields", () => {
    const migration = readFileSync(join(MIGRATIONS_DIR, '0003_search_queries.sql'), 'utf8');
    const list = /filter_fields <@ ARRAY\[([^\]]*)\]::text\[\]/.exec(migration)?.[1] ?? '';
    const names = [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(SEARCH_FILTER_FIELDS);
  });
});

describe('searchQueriesRepo.reserve', () => {
  const queryId = '9d2f5a3c-1b4e-4f6a-8c7d-0e1f2a3b4c5d';
  const userOid = 'AABBCCDD-1111-4222-8333-444455556666';
  const oid = userOid.toLowerCase();

  /** Answers the lock, each window's count (`used[seconds|kinds]`) and its retry row. */
  const db =
    (used: Record<string, number> = {}, retry: Record<string, number | null> = {}) =>
    (text: string, values: unknown[]): unknown[] => {
      const t = flat(text);
      if (t.includes('pg_advisory_xact_lock')) return [{}];
      const key = (kinds: unknown, seconds: unknown, perUser: boolean) =>
        `${perUser ? 'user' : 'client'}:${(kinds as string[]).join('+')}:${String(seconds)}`;
      if (t.startsWith('SELECT count(*)::int AS n FROM ledger.search_queries')) {
        return [{ n: used[key(values[1], values[2], t.includes('user_oid'))] ?? 0 }];
      }
      if (t.includes('OFFSET')) {
        const seconds = retry[key(values[2], values[3], t.includes('user_oid'))];
        return seconds === null ? [] : [{ seconds: seconds ?? 1 }];
      }
      return [];
    };

  it('locks the client, counts the question windows, then records the search as started', async () => {
    const { result, calls } = await inTx(
      (tx) => searchQueriesRepo.reserve(tx, { queryId, userOid, kind: 'question' }),
      db({ 'user:question:300': 9, 'user:question:86400': 59, 'client:question:86400': 299 }),
    );
    expect(result).toEqual({ status: 'ok' });
    const texts = calls.map((c) => flat(c.text));
    expect(texts[0]).toBe('SELECT pg_advisory_xact_lock($1::int, $2::int)');
    expect(calls[0]!.values).toEqual([
      searchQueriesRepo.SEARCH_LOCK_CLASS,
      Number.parseInt(A.slice(0, 8), 16) | 0,
    ]);
    expect(texts[1]).toBe(
      'SELECT count(*)::int AS n FROM ledger.search_queries WHERE client_id = $1 AND ' +
        'kind = ANY($2::text[]) AND created_at > now() - make_interval(secs => $3) AND ' +
        'user_oid = $4::uuid',
    );
    expect(calls.slice(1, 4).map((c) => c.values)).toEqual([
      [A, ['question'], 300, oid],
      [A, ['question'], 86_400, oid],
      [A, ['question'], 86_400],
    ]);
    expect(texts[4]).toBe(
      'INSERT INTO ledger.search_queries (query_id, client_id, user_oid, kind) VALUES ($1, $2, $3, $4)',
    );
    expect(calls[4]!.values).toEqual([queryId, A, oid, 'question']);
    expect(calls).toHaveLength(5);
  });

  it('counts only the typed window for a typed request or a page', async () => {
    for (const kind of ['typed', 'page'] as const) {
      const { result, calls } = await inTx(
        (tx) => searchQueriesRepo.reserve(tx, { queryId, userOid, kind }),
        db({ 'user:typed+page:300': 29 }),
      );
      expect(result).toEqual({ status: 'ok' });
      expect(calls.map((c) => c.values)).toEqual([
        expect.any(Array),
        [A, ['typed', 'page'], 300, oid],
        [queryId, A, oid, kind],
      ]);
    }
  });

  it('over a limit: records nothing, and says when the oldest counted search leaves the window', async () => {
    const { result, calls } = await inTx(
      (tx) => searchQueriesRepo.reserve(tx, { queryId, userOid, kind: 'question' }),
      db({ 'user:question:300': 10 }, { 'user:question:300': 42 }),
    );
    expect(result).toEqual({
      status: 'rate_limited',
      retryAfterSeconds: 42,
      quota: 'user_questions_5m',
    });
    const texts = calls.map((c) => flat(c.text));
    expect(texts.some((t) => t.startsWith('INSERT'))).toBe(false);
    const retry = calls.find((c) => flat(c.text).includes('OFFSET'))!;
    expect(flat(retry.text)).toBe(
      'SELECT greatest(1, ceil(extract(epoch FROM created_at + make_interval(secs => $1) - now())))::int ' +
        'AS seconds FROM ledger.search_queries WHERE client_id = $2 AND kind = ANY($3::text[]) AND ' +
        'created_at > now() - make_interval(secs => $4) AND user_oid = $5::uuid ' +
        'ORDER BY created_at, query_id OFFSET $6 LIMIT 1',
    );
    expect(retry.values).toEqual([300, A, ['question'], 300, oid, 0]);
  });

  it('waits for the limit that frees last, skipping as many rows as are over it', async () => {
    const { result, calls } = await inTx(
      (tx) => searchQueriesRepo.reserve(tx, { queryId, userOid, kind: 'question' }),
      db(
        { 'user:question:300': 12, 'user:question:86400': 60, 'client:question:86400': 301 },
        { 'user:question:300': 40, 'user:question:86400': 3_000, 'client:question:86400': 900 },
      ),
    );
    expect(result).toEqual({
      status: 'rate_limited',
      retryAfterSeconds: 3_000,
      quota: 'user_questions_24h',
    });
    const offsets = calls
      .filter((c) => flat(c.text).includes('OFFSET'))
      .map((c) => c.values.at(-1));
    expect(offsets).toEqual([2, 0, 1]);
  });

  it('falls back to the whole window when the counted rows are gone by the second read', async () => {
    const { result } = await inTx(
      (tx) => searchQueriesRepo.reserve(tx, { queryId, userOid, kind: 'typed' }),
      db({ 'user:typed+page:300': 30 }, { 'user:typed+page:300': null }),
    );
    expect(result).toEqual({
      status: 'rate_limited',
      retryAfterSeconds: 300,
      quota: 'user_typed_5m',
    });
  });

  it('reads no count row as nothing used', async () => {
    const { result } = await inTx((tx) =>
      searchQueriesRepo.reserve(tx, { queryId, userOid, kind: 'page' }),
    );
    expect(result).toEqual({ status: 'ok' });
  });

  it.each([
    [{ queryId: 'q-1' }, 'queryId'],
    [{ queryId: queryId.toUpperCase() }, 'queryId'],
    [{ userOid: 'someone@example.com' }, 'userOid'],
    [{ kind: 'sql' }, 'kind'],
    [{ clientId: A }, ''],
  ])('refuses %j before any statement, naming the field only', async (over, field) => {
    const calls: unknown[] = [];
    await expect(
      inTx(
        (tx) =>
          searchQueriesRepo.reserve(tx, {
            queryId,
            userOid,
            kind: 'question',
            ...over,
          } as searchQueriesRepo.SearchReservation),
        (text) => (calls.push(text), []),
      ),
    ).rejects.toThrow(`the search reservation is invalid: ${field}`);
    // Only withClientTx's own BEGIN, scope and ROLLBACK ran.
    expect(calls.filter((t) => /search_queries|pg_advisory/.test(String(t)))).toEqual([]);
  });

  it('refuses a transaction handle it did not get from withClientTx', async () => {
    await expect(
      searchQueriesRepo.reserve(
        { clientId: A, query: async () => [] },
        { queryId, userOid, kind: 'question' },
      ),
    ).rejects.toMatchObject({ reason: 'tx_closed' });
  });

  it('holds the limits the design set', () => {
    expect(
      searchQueriesRepo.SEARCH_QUOTAS.map((q) => [q.name, q.per, q.kinds, q.max, q.windowSeconds]),
    ).toEqual([
      ['user_questions_5m', 'user', ['question'], 10, 300],
      ['user_questions_24h', 'user', ['question'], 60, 86_400],
      ['user_typed_5m', 'user', ['typed', 'page'], 30, 300],
      ['client_questions_24h', 'client', ['question'], 300, 86_400],
    ]);
  });
});

describe('searchQueriesRepo.finish', () => {
  const queryId = '9d2f5a3c-1b4e-4f6a-8c7d-0e1f2a3b4c5d';

  it('records the outcome once, on a started row of the scope, codes and counts only', async () => {
    const digest = searchQueriesRepo.filterDigest({ categories: ['umowy'], monthFrom: '2026-01' });
    const { result, calls } = await inTx(
      (tx) =>
        searchQueriesRepo.finish(tx, {
          queryId,
          outcome: 'ok',
          ...digest,
          resultCount: 7,
          model: 'claude-sonnet-5',
          tokens: {
            inputTokens: 100,
            outputTokens: 120,
            cacheReadTokens: 1300,
            cacheWriteTokens: 0,
          },
          latencyMs: 812,
        }),
      () => [{ query_id: queryId }],
    );
    expect(result).toBe(true);
    const text = flat(calls[0]!.text);
    expect(text).toMatch(/^UPDATE ledger\.search_queries SET outcome = \$1, /);
    expect(text).toContain("WHERE client_id = $11 AND query_id = $12 AND outcome = 'started'");
    expect(calls[0]!.values).toEqual([
      'ok',
      digest.filterSha256,
      ['categories', 'monthFrom'],
      7,
      'claude-sonnet-5',
      100,
      120,
      1300,
      0,
      812,
      A,
      queryId,
    ]);
  });

  it('writes NULL for what is absent, and says when no started row was there', async () => {
    const { result, calls } = await inTx((tx) =>
      searchQueriesRepo.finish(tx, { queryId, outcome: 'unavailable' }),
    );
    expect(result).toBe(false);
    expect(calls[0]!.values).toEqual([
      'unavailable',
      null,
      [],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      A,
      queryId,
    ]);
  });

  it.each([
    [{ outcome: 'started' }, 'outcome'],
    [{ filterSha256: 'abc' }, 'filterSha256'],
    [{ filterFields: ['sellerName'] }, 'filterFields.0'],
    [{ model: 'faktury od Dostawcy S.A.' }, 'model'],
    [{ resultCount: -1 }, 'resultCount'],
    [
      { tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 } },
      'tokens.cacheWriteTokens',
    ],
    [{ latencyMs: 1.5 }, 'latencyMs'],
    [{ question: 'pokaż faktury' }, ''],
  ])('refuses %j, naming the field only', async (over, field) => {
    await expect(
      inTx((tx) =>
        searchQueriesRepo.finish(tx, {
          queryId,
          outcome: 'ok',
          ...over,
        } as searchQueriesRepo.SearchQueryFinish),
      ),
    ).rejects.toThrow(`the search record is invalid: ${field}`);
  });

  it('refuses a transaction handle it did not get from withClientTx', async () => {
    await expect(
      searchQueriesRepo.finish({ clientId: A, query: async () => [] }, { queryId, outcome: 'ok' }),
    ).rejects.toMatchObject({ reason: 'tx_closed' });
  });
});

describe('searchQueriesRepo.filterDigest', () => {
  it('hashes the checked filter: two spellings of one filter are one digest', () => {
    const a = searchQueriesRepo.filterDigest({
      counterpartyNip: 'PL 526-025-02-74',
      categories: ['umowy', 'faktury_zakupu'],
      grossMin: '1 000,5',
      counterpartyName: '  Dostawca   S.A. ',
    });
    const b = searchQueriesRepo.filterDigest({
      grossMin: 1000.5,
      categories: ['faktury_zakupu', 'umowy', 'umowy'],
      counterpartyName: 'Dostawca S.A.',
      counterpartyNip: '5260250274',
    });
    expect(a).toEqual(b);
    expect(a.filterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.filterFields).toEqual([
      'categories',
      'counterpartyName',
      'counterpartyNip',
      'grossMin',
    ]);
  });

  it('keeps no value, and tells different filters apart', () => {
    const digest = searchQueriesRepo.filterDigest({
      counterpartyNip: '5260250274',
      counterpartyName: 'Dostawca',
      invoiceNumber: 'FV 1/2026',
    });
    expect(JSON.stringify(digest)).not.toMatch(/5260250274|Dostawca|FV 1/);
    expect(searchQueriesRepo.filterDigest({ counterpartyNip: '1234567819' }).filterSha256).not.toBe(
      searchQueriesRepo.filterDigest({ counterpartyNip: '5260250274' }).filterSha256,
    );
    expect(searchQueriesRepo.filterDigest({}).filterFields).toEqual([]);
  });

  it('refuses a filter the index would refuse', () => {
    expect(() => searchQueriesRepo.filterDigest({ counterpartyNip: '1234567810' })).toThrow(
      'the search filter is invalid: counterpartyNip',
    );
  });
});
