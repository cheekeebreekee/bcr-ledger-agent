import { validateBatchIngestionPayload } from './validation';

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
