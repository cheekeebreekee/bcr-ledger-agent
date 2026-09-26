import { clientIdForDirectoryRow } from '../clientScope';
import { LedgerDb, type ClientTx, type ConnectionLike } from '../tx';
import * as clientsRepo from './clientsRepo';
import * as documentsRepo from './documentsRepo';
import type { DocumentRecord } from './documentsRepo';

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
  rows: (text: string) => unknown[] = () => [],
  clientId: string = A,
): Promise<{ result: T; calls: Call[] }> {
  const calls: Call[] = [];
  const conn: ConnectionLike = {
    async query(a: string | { text: string; values: unknown[] }, b?: unknown[]) {
      const call = typeof a === 'string' ? { text: a, values: b ?? [] } : a;
      calls.push(call);
      return { rows: rows(call.text) };
    },
    release() {},
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
    ]);
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
  ])('refuses a cursor it did not issue: %j', async (after) => {
    await expect(inTx((tx) => documentsRepo.search(tx, {}, { after }))).rejects.toMatchObject({
      reason: 'invalid_cursor',
    });
  });
});
