import { createHash } from 'node:crypto';
import {
  clientIdForDirectoryRow,
  LedgerDb,
  LedgerDbError,
  type ClientTx,
  type ConnectionLike,
} from '@bcr/ledger-db';
import type { Logger } from '@bcr/shared';
import { DatabaseError } from 'pg';
import { AcceptancePolicy, processingFailedDecision } from './acceptancePolicy';
import {
  INDEX_OFF,
  INDEX_UNAVAILABLE_COOLDOWN_MS,
  LedgerDocumentIndex,
  toRecord,
  type IndexedDocument,
} from './documentIndex';

const LIST_ID = 'c0ffee00-1234-4abc-9def-00112233aabb';
const NOW = new Date('2026-09-26T10:00:00Z');
const policy = new AcceptancePolicy(0.7);

const extraction = {
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
  buyerName: 'Klient Testowy',
  ksefNumber: null,
};

const filed = policy.decide(
  {
    documentType: 'Faktura zakupu',
    folderPath: '',
    confidence: 0.934,
    classifier: 'claude',
    model: 'claude-opus-5',
    fields: { category: 'faktury_zakupu', year: 2026, month: 9, direction: 'zakup' },
    extraction,
  },
  NOW,
);

const doc = (over: Partial<IndexedDocument> = {}): IndexedDocument => ({
  documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  source: 'bot',
  client: { listItemId: '11', clientNo: '0002', nip: '1234567819', legalName: 'Klient Testowy' },
  driveId: 'b!drive',
  driveItemId: 'item-1',
  decision: filed,
  uploadedByOid: 'AE3987D3-9A3A-4FF8-BCF7-713D24E79C48',
  content: Buffer.from('bytes'),
  sizeBytes: 5,
  ...over,
});

function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const write = (obj: unknown) => lines.push({ ...(obj as Record<string, unknown>) });
  return { log: { info: write, warn: write } as unknown as Logger, lines };
}

/** A real LedgerDb over a fake connection: `answer` sees each statement fn runs. */
function fakeDb(answer: (text: string) => unknown[] | Error) {
  const statements: { text: string; values: unknown[] }[] = [];
  const scopes: string[] = [];
  const conn: ConnectionLike = {
    async query(a: string | { text: string; values: unknown[] }, b?: unknown[]) {
      const call = typeof a === 'string' ? { text: a, values: b ?? [] } : a;
      if (call.text.startsWith('SELECT set_config')) scopes.push(String(call.values[0]));
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT set_config)/.test(call.text))
        return { rows: [] };
      statements.push(call);
      const out = answer(call.text);
      if (out instanceof Error) throw out;
      return { rows: out };
    },
    release() {},
    on() {},
    removeListener() {},
  };
  const connect = jest.fn(async () => conn);
  return { db: new LedgerDb({ connect, end: async () => undefined }), statements, scopes, connect };
}

const SCOPE = clientIdForDirectoryRow(LIST_ID, '11');

const happy = (text: string) =>
  text.includes('INSERT INTO ledger.clients')
    ? [{ client_id: SCOPE }]
    : [{ document_id: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f', created: true }];

const pgError = (code: string) =>
  Object.assign(new DatabaseError('Key (nip)=(1234567819) already exists', 0, 'error'), { code });

describe('INDEX_OFF', () => {
  it('is off and does nothing', async () => {
    expect(INDEX_OFF.mode).toBe('off');
    await expect(INDEX_OFF.record(doc(), recordingLogger().log)).resolves.toBeUndefined();
  });
});

describe('LedgerDocumentIndex', () => {
  it("writes the client row and the document in the bound row's own scope", async () => {
    const f = fakeDb(happy);
    const { log, lines } = recordingLogger();
    await new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID }).record(doc(), log);

    expect(f.scopes).toEqual([SCOPE]);
    expect(f.statements.map((s) => s.text.match(/INSERT INTO ledger\.\w+/)?.[0])).toEqual([
      'INSERT INTO ledger.clients',
      'INSERT INTO ledger.documents',
    ]);
    // The client row is keyed by the Directory row; the document carries the scope.
    expect(f.statements[0]?.values.slice(0, 2)).toEqual([SCOPE, '11']);
    expect(f.statements[1]?.values.slice(0, 7)).toEqual([
      '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
      SCOPE,
      'bot',
      'b!drive',
      'item-1',
      'FILED',
      'faktury_zakupu',
    ]);
    expect(lines).toEqual([
      {
        event: 'index.written',
        documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
        clientId: '0002',
        listItemId: '11',
        driveItemId: 'item-1',
        ledgerClientId: SCOPE,
        source: 'bot',
        status: 'FILED',
        created: true,
        invoiceFields: 10,
      },
    ]);
  });

  it('records a review as NEEDS_REVIEW, and names the row it updated', async () => {
    const f = fakeDb((text) =>
      text.includes('INSERT INTO ledger.clients')
        ? [{ client_id: SCOPE }]
        : [{ document_id: 'first-id', created: false }],
    );
    const { log, lines } = recordingLogger();
    await new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID }).record(
      doc({ decision: processingFailedDecision(NOW), source: 'inbox' }),
      log,
    );
    expect(f.statements[1]?.values[5]).toBe('NEEDS_REVIEW');
    expect(lines[0]).toMatchObject({
      event: 'index.written',
      status: 'NEEDS_REVIEW',
      created: false,
      indexedDocumentId: 'first-id',
      invoiceFields: 0,
    });
  });

  it.each([
    ['23505', 'constraint'],
    ['42501', 'row_security'],
    ['XX000', 'error'],
  ])(
    'logs a refused write (SQLSTATE %s) as %s, by ids and codes only, and resolves',
    async (code, reason) => {
      const f = fakeDb((text) => (text.includes('ledger.clients') ? pgError(code) : []));
      const { log, lines } = recordingLogger();
      await expect(
        new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID }).record(doc(), log),
      ).resolves.toBeUndefined();
      expect(lines).toEqual([
        {
          event: 'index.write_failed',
          documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
          clientId: '0002',
          listItemId: '11',
          driveItemId: 'item-1',
          ledgerClientId: SCOPE,
          source: 'bot',
          status: 'FILED',
          reason,
          // pg names its errors by the message type: 'error'.
          err: { name: 'error', sqlState: code },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain('1234567819');
    },
  );

  it('logs a record the index refuses as invalid_record', async () => {
    const f = fakeDb(happy);
    const { log, lines } = recordingLogger();
    await new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID }).record(
      doc({ driveItemId: '' }),
      log,
    );
    expect(lines[0]).toMatchObject({
      event: 'index.write_failed',
      reason: 'invalid_record',
      err: { name: 'LedgerDbError', indexReason: 'invalid_record' },
    });
  });

  it('logs a Directory row it cannot derive a scope for as scope, opening no transaction', async () => {
    const f = fakeDb(happy);
    const { log, lines } = recordingLogger();
    await new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID }).record(
      doc({ client: { ...doc().client, listItemId: 'x' } }),
      log,
    );
    expect(f.connect).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ reason: 'scope' });
    expect(lines[0]).not.toHaveProperty('ledgerClientId');
  });

  it('skips writes for a cooldown after the database could not be reached', async () => {
    let now = 1_000;
    let fail = true;
    const f = fakeDb((text) =>
      fail
        ? Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        : happy(text),
    );
    const index = new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID, now: () => now });
    const { log, lines } = recordingLogger();

    await index.record(doc(), log);
    expect(lines[0]).toMatchObject({ reason: 'unavailable', err: { name: 'Error' } });
    fail = false;
    now += INDEX_UNAVAILABLE_COOLDOWN_MS - 1;
    await index.record(doc(), log);
    expect(lines[1]).toMatchObject({ reason: 'unavailable', skipped: true });
    expect(f.connect).toHaveBeenCalledTimes(1);
    now += 1;
    await index.record(doc(), log);
    expect(lines[2]).toMatchObject({ event: 'index.written' });
  });

  it.each([
    ['a connection error with a Node code', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })],
    ['a server shutting down', pgError('57P01')],
    ['a login the server refuses', pgError('28000')],
    ['no token', new LedgerDbError('no_token', 'no Entra token for the database')],
  ])('treats %s as unavailable', async (_label, err) => {
    const f = fakeDb(() => err);
    const { log, lines } = recordingLogger();
    await new LedgerDocumentIndex({ db: f.db, directoryListId: LIST_ID }).record(doc(), log);
    expect(lines[0]).toMatchObject({ reason: 'unavailable' });
  });

  it('logs any other index error as error', async () => {
    const db = {
      withClientTx: jest.fn(async (_id: string, _fn: (tx: ClientTx) => Promise<unknown>) => {
        throw new LedgerDbError('tx_closed', 'closed');
      }),
    };
    const { log, lines } = recordingLogger();
    await new LedgerDocumentIndex({ db, directoryListId: LIST_ID }).record(doc(), log);
    expect(lines[0]).toMatchObject({ reason: 'error' });
    const thrown = {
      withClientTx: jest.fn(async () => {
        throw 'not an error';
      }),
    };
    await new LedgerDocumentIndex({ db: thrown, directoryListId: LIST_ID }).record(doc(), log);
    expect(lines[1]).toMatchObject({ reason: 'unavailable', err: { type: 'string' } });
  });
});

describe('toRecord', () => {
  it('carries an https web link for staff, and never anything else', () => {
    const url = 'https://tenant.sharepoint.com/sites/Klient/Dokumenty/f.pdf';
    expect(toRecord(doc({ webUrl: url })).webUrl).toBe(url);
    expect(toRecord(doc({ webUrl: 'http://tenant.sharepoint.com/f.pdf' }))).not.toHaveProperty(
      'webUrl',
    );
    expect(toRecord(doc())).not.toHaveProperty('webUrl');
  });

  it('maps the decision, hashes the bytes, lower-cases the uploader and carries the fields', () => {
    expect(toRecord(doc())).toEqual({
      documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
      source: 'bot',
      driveId: 'b!drive',
      driveItemId: 'item-1',
      category: 'faktury_zakupu',
      confidence: 0.934,
      classifier: 'claude',
      model: 'claude-opus-5',
      reviewReasons: [],
      documentMonth: '2026-09',
      folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
      uploadedByOid: 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
      contentSha256: createHash('sha256').update('bytes').digest('hex'),
      sizeBytes: 5,
      invoice: extraction,
    });
  });

  it('prefers a hash the filer already has, and leaves out what an unclassified review lacks', () => {
    const record = toRecord({
      documentId: 'd',
      source: 'inbox',
      client: doc().client,
      driveId: 'b!drive',
      driveItemId: 'item-2',
      decision: processingFailedDecision(NOW),
      contentSha256: 'a'.repeat(64),
    });
    expect(record).toEqual({
      documentId: 'd',
      source: 'inbox',
      driveId: 'b!drive',
      driveItemId: 'item-2',
      category: 'nieposortowane',
      reviewReasons: ['PROCESSING_FAILED'],
      folderPath: '98_Nieposortowane/2026/09',
      contentSha256: 'a'.repeat(64),
    });
  });

  it('keeps the suggestion of a review', () => {
    const review = policy.decide(
      {
        documentType: '',
        folderPath: '',
        confidence: 0.4,
        classifier: 'claude',
        model: 'claude-opus-5',
        fields: { category: 'umowy' },
      },
      NOW,
    );
    expect(toRecord(doc({ decision: review }))).toMatchObject({
      category: 'nieposortowane',
      suggestedCategory: 'umowy',
      reviewReasons: ['LOW_CONFIDENCE'],
    });
  });
});
