import { validateIngestionPayload } from './validation';

const validPayload = {
  filename: 'Invoice_03_2026.pdf',
  contentType: 'application/pdf',
  contentBase64: Buffer.from('hello').toString('base64'),
  source: {
    tenantId: 'tenant-1',
    channelId: 'msteams',
    conversationId: 'conv-1',
    activityId: 'act-1',
    userDisplayName: 'Alice',
  },
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
