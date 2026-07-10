import { validateBatchIngestionPayload, validateIngestionPayload } from './validation';

const validSource = {
  tenantId: 'tenant-1',
  channelId: 'msteams',
  conversationId: 'conv-1',
  activityId: 'act-1',
  userDisplayName: 'Alice',
};

const validPayload = {
  filename: 'Invoice_03_2026.pdf',
  contentType: 'application/pdf',
  contentBase64: Buffer.from('hello').toString('base64'),
  source: validSource,
};

const validDocument = {
  filename: 'Invoice_03_2026.pdf',
  contentType: 'application/pdf',
  contentBase64: Buffer.from('hello').toString('base64'),
};

describe('validateIngestionPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(() => validateIngestionPayload(validPayload)).not.toThrow();
  });

  it('rejects filenames with path separators', () => {
    expect(() =>
      validateIngestionPayload({ ...validPayload, filename: '../Invoice.pdf' }),
    ).toThrow(/path separators/);
  });

  it('rejects empty filename', () => {
    expect(() => validateIngestionPayload({ ...validPayload, filename: '' })).toThrow(/Invalid/);
  });

  it('rejects non-base64 content', () => {
    expect(() =>
      validateIngestionPayload({ ...validPayload, contentBase64: 'not!base64@@' }),
    ).toThrow(/base64-encoded/);
  });

  it('requires a source block', () => {
    const { source: _src, ...rest } = validPayload;
    expect(() => validateIngestionPayload(rest as unknown)).toThrow(/Invalid/);
  });

  it('rejects payloads larger than the configured maximum', () => {
    // Approx 200 MiB of base64 = ~150 MiB decoded → exceeds 100 MiB cap.
    const bigBase64 = 'A'.repeat(200 * 1024 * 1024);
    expect(() =>
      validateIngestionPayload({ ...validPayload, contentBase64: bigBase64 }),
    ).toThrow(/maximum size/);
  });
});

describe('validateBatchIngestionPayload', () => {
  const validBatch = {
    documents: [validDocument, { ...validDocument, filename: 'Paragon_2026-03-15.png' }],
    source: validSource,
  };

  it('accepts a well-formed batch', () => {
    const result = validateBatchIngestionPayload(validBatch);
    expect(result.documents).toHaveLength(2);
    expect(result.source.tenantId).toBe('tenant-1');
  });

  it('rejects an empty document list', () => {
    expect(() =>
      validateBatchIngestionPayload({ ...validBatch, documents: [] }),
    ).toThrow(/Invalid batch/);
  });

  it('rejects more than 25 documents', () => {
    const documents = Array.from({ length: 26 }, () => validDocument);
    expect(() => validateBatchIngestionPayload({ ...validBatch, documents })).toThrow(
      /Invalid batch/,
    );
  });

  it('rejects a document with path separators in the filename', () => {
    expect(() =>
      validateBatchIngestionPayload({
        ...validBatch,
        documents: [{ ...validDocument, filename: '../evil.pdf' }],
      }),
    ).toThrow(/path separators/);
  });

  it('requires a source block', () => {
    const { source: _src, ...rest } = validBatch;
    expect(() => validateBatchIngestionPayload(rest as unknown)).toThrow(/Invalid batch/);
  });

  it('rejects a batch whose aggregate size exceeds the maximum', () => {
    // ~75 MiB base64 ≈ 56 MiB decoded each; two together exceed the 100 MiB cap.
    const bigBase64 = 'A'.repeat(75 * 1024 * 1024);
    const documents = [
      { ...validDocument, contentBase64: bigBase64 },
      { ...validDocument, contentBase64: bigBase64 },
    ];
    expect(() => validateBatchIngestionPayload({ ...validBatch, documents })).toThrow(
      /maximum size/,
    );
  });
});
