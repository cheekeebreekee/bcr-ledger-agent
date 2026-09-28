import { ValidationError } from '@bcr/shared';
import { validateBatchIngestionPayload, validateSearchPayload } from './validation';

const TENANT = '379013e4-0000-4000-8000-000000000001';
const OID = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';
const opts = { expectedTenantId: TENANT };

const validSource = {
  tenantId: TENANT,
  channelId: 'msteams',
  conversationId: 'conv-1',
  activityId: 'act-1',
  conversationType: 'personal',
  userAadObjectId: OID,
  userDisplayName: 'Alice',
};

const validDocument = {
  filename: 'Invoice_03_2026.pdf',
  contentType: 'application/pdf',
  contentBase64: Buffer.from('hello').toString('base64'),
};

const validBatch = { documents: [validDocument], source: validSource };

describe('validateBatchIngestionPayload', () => {
  it('accepts a well-formed 1:1 batch from the BCR tenant', () => {
    const payload = validateBatchIngestionPayload(validBatch, opts);
    expect(payload.documents).toHaveLength(1);
    expect(payload.source.conversationType).toBe('personal');
    expect(payload.source.teamsChannelId).toBeUndefined();
  });

  it('lower-cases the uploader id so routing lookups are stable', () => {
    const payload = validateBatchIngestionPayload(
      { ...validBatch, source: { ...validSource, userAadObjectId: OID.toUpperCase() } },
      opts,
    );
    expect(payload.source.userAadObjectId).toBe(OID);
  });

  it.each([
    ['a group chat', { conversationType: 'groupChat' }, /personal/],
    ['a channel', { conversationType: 'channel' }, /personal/],
    ['no conversation type (an old bot build)', { conversationType: undefined }, /conversationType/],
    ['no uploader id', { userAadObjectId: undefined }, /userAadObjectId/],
    ['a non-GUID uploader id', { userAadObjectId: 'user@example.com' }, /GUID/],
    ['another tenant', { tenantId: '11111111-1111-1111-1111-111111111111' }, /BCR tenant/],
  ])('refuses %s', (_label, sourceOverride, pattern) => {
    expect(() =>
      validateBatchIngestionPayload(
        { ...validBatch, source: { ...validSource, ...sourceOverride } },
        opts,
      ),
    ).toThrow(pattern);
  });

  it('compares the tenant case-insensitively', () => {
    expect(() =>
      validateBatchIngestionPayload(
        { ...validBatch, source: { ...validSource, tenantId: TENANT.toUpperCase() } },
        opts,
      ),
    ).not.toThrow();
  });

  it('rejects filenames with path separators', () => {
    expect(() =>
      validateBatchIngestionPayload(
        { ...validBatch, documents: [{ ...validDocument, filename: '../Invoice.pdf' }] },
        opts,
      ),
    ).toThrow(/path separators/);
  });

  it('rejects non-base64 content and empty filenames', () => {
    expect(() =>
      validateBatchIngestionPayload(
        { ...validBatch, documents: [{ ...validDocument, contentBase64: '###' }] },
        opts,
      ),
    ).toThrow(/base64/);
    expect(() =>
      validateBatchIngestionPayload(
        { ...validBatch, documents: [{ ...validDocument, filename: '' }] },
        opts,
      ),
    ).toThrow(/Invalid/);
  });

  it('rejects an empty batch and one over 25 documents', () => {
    expect(() => validateBatchIngestionPayload({ ...validBatch, documents: [] }, opts)).toThrow(
      /Invalid/,
    );
    expect(() =>
      validateBatchIngestionPayload(
        { ...validBatch, documents: Array.from({ length: 26 }, () => validDocument) },
        opts,
      ),
    ).toThrow(/Invalid/);
  });

  it('rejects a batch whose total decoded size exceeds 100 MiB', () => {
    const big = 'A'.repeat(Math.ceil((60 * 1024 * 1024 * 4) / 3));
    expect(() =>
      validateBatchIngestionPayload(
        {
          ...validBatch,
          documents: [
            { ...validDocument, contentBase64: big },
            { ...validDocument, contentBase64: big },
          ],
        },
        opts,
      ),
    ).toThrow(/maximum size/);
  });
});

describe('validateSearchPayload', () => {
  const searchSource = {
    tenantId: TENANT,
    conversationId: 'conv-1',
    activityId: 'act-1',
    conversationType: 'personal',
    userAadObjectId: OID,
  };
  const question = { source: searchSource, query: { kind: 'question', text: 'faktury z marca' } };
  const typed = {
    source: searchSource,
    query: {
      kind: 'typed',
      filter: { categories: ['faktury_zakupu'], monthFrom: '2026-03', grossMin: '100.00' },
      after: 'WyIyMDI2LTA5LTI4VDEwOjAwOjAwLjAwMDAwMFoiXQ',
    },
  };

  it('accepts a question and a typed filter with a cursor', () => {
    expect(validateSearchPayload(question, opts)).toEqual(question);
    expect(validateSearchPayload(typed, opts)).toEqual(typed);
  });

  it('accepts a typed filter without a cursor, and an empty one (the newest documents)', () => {
    const first = { source: searchSource, query: { kind: 'typed', filter: {} } };
    const payload = validateSearchPayload(first, opts);
    expect(payload.query).toEqual({ kind: 'typed', filter: {} });
    expect('after' in payload.query).toBe(false);
  });

  it('lower-cases the asker id, as uploads do', () => {
    const payload = validateSearchPayload(
      { ...question, source: { ...searchSource, userAadObjectId: OID.toUpperCase() } },
      opts,
    );
    expect(payload.source.userAadObjectId).toBe(OID);
  });

  // Nothing in a request may name a client, a row, a scope or a limit: such a
  // key is refused, never ignored.
  it.each([
    ['a clientId at the top', { ...question, clientId: '0002' }],
    ['a scope in the source', { ...question, source: { ...searchSource, scope: 'x' } }],
    ['a listItemId in the query', { ...question, query: { ...question.query, listItemId: '2' } }],
    ['a limit next to the filter', { ...typed, query: { ...typed.query, limit: 100 } }],
    [
      'a clientId inside the filter',
      { ...typed, query: { ...typed.query, filter: { clientId: '0002' } } },
    ],
    ['a display name', { ...question, source: { ...searchSource, userDisplayName: 'A' } }],
  ])('refuses %s', (_label, raw) => {
    expect(() => validateSearchPayload(raw, opts)).toThrow(/Unrecognized key/);
  });

  it.each([
    [
      'a group chat',
      { source: { ...searchSource, conversationType: 'groupChat' } },
      /conversationType/,
    ],
    ['a channel', { source: { ...searchSource, conversationType: 'channel' } }, /conversationType/],
    ['no asker', { source: { ...searchSource, userAadObjectId: undefined } }, /userAadObjectId/],
    ['a non-GUID asker', { source: { ...searchSource, userAadObjectId: 'a@b.pl' } }, /GUID/],
    [
      'another tenant',
      { source: { ...searchSource, tenantId: '11111111-1111-1111-1111-111111111111' } },
      /BCR tenant/,
    ],
    ['an empty question', { query: { kind: 'question', text: '' } }, /query\.text/],
    [
      'a question over 300 characters',
      { query: { kind: 'question', text: 'a'.repeat(301) } },
      /query\.text/,
    ],
    ['an unknown kind', { query: { kind: 'sql', text: 'x' } }, /query\.kind/],
    ['no query', { query: undefined }, /query/],
  ])('refuses %s', (_label, over, pattern) => {
    expect(() => validateSearchPayload({ ...question, ...over }, opts)).toThrow(pattern);
  });

  it('accepts a question of exactly 300 characters', () => {
    const raw = { ...question, query: { kind: 'question', text: 'a'.repeat(300) } };
    expect(validateSearchPayload(raw, opts).query).toEqual(raw.query);
  });

  it.each([
    ['a cursor over 256 characters', 'a'.repeat(257), /after/],
    ['a cursor that is not base64url', 'abc+/=', /not a search cursor/],
    ['an empty cursor', '', /after/],
  ])('refuses %s', (_label, after, pattern) => {
    const raw = { ...typed, query: { ...typed.query, after } };
    expect(() => validateSearchPayload(raw, opts)).toThrow(pattern);
  });

  it.each([
    ['an unknown category', { categories: ['wszystko'] }],
    ['an empty category list', { categories: [] }],
    ['a month that is not YYYY-MM', { monthFrom: '2026-13' }],
    ['months the wrong way round', { monthFrom: '2026-05', monthTo: '2026-01' }],
    ['a negative amount', { grossMin: '-5.00' }],
    ['an amount with three decimals', { grossMax: '1.234' }],
    ['amounts the wrong way round', { grossMin: '500', grossMax: '100' }],
    ['a lower-case currency', { currency: 'pln' }],
    ['a NIP of nine digits', { counterpartyNip: '123456781' }],
    ['a name over 60 characters', { counterpartyName: 'x'.repeat(61) }],
    ['a blank invoice number', { invoiceNumber: '   ' }],
    ['an unknown status', { status: 'deleted' }],
  ])('refuses a filter with %s', (_label, filter) => {
    const raw = { ...typed, query: { kind: 'typed', filter } };
    expect(() => validateSearchPayload(raw, opts)).toThrow(ValidationError);
  });

  it('names fields in its message, never the question', () => {
    const raw = { ...question, query: { kind: 'question', text: 'Kowalski '.repeat(40) } };
    let message = '';
    try {
      validateSearchPayload(raw, opts);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/query\.text/);
    expect(message).not.toMatch(/Kowalski/);
  });

  it('compares the tenant case-insensitively', () => {
    const raw = { ...question, source: { ...searchSource, tenantId: TENANT.toUpperCase() } };
    expect(() => validateSearchPayload(raw, opts)).not.toThrow();
  });
});
