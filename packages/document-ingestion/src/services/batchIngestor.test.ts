import {
  SharePointError,
  ValidationError,
  type Classification,
  type ClassifierContext,
  type DirectoryClientResolution,
  type DriveItemRef,
  type IngestionBatchRequestPayload,
  type Logger,
  type QuarantineReason,
  type ResolvedClient,
  type SharePointTarget,
} from '@bcr/shared';
import { BatchIngestor, type BatchIngestorDeps } from './batchIngestor';
import { SharePointTargetError, type UploadDocumentArgs } from './sharePointService';

const OID = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';

const quarantineTarget: SharePointTarget = {
  siteHostname: 'contoso.sharepoint.com',
  sitePath: '/sites/BCRLedgerKwarantanna',
  driveName: 'Dokumenty',
  rootFolder: 'Kwarantanna',
};

const clientTarget: SharePointTarget = {
  siteHostname: 'contoso.sharepoint.com',
  sitePath: '/sites/ClientA',
  driveName: 'Dokumenty',
  rootFolder: 'Dokumenty księgowe',
};

const clientA: DirectoryClientResolution = {
  source: 'directory',
  clientId: '0002',
  listItemId: '11',
  title: '[0002] Client A',
  matchedBy: 'userAadObjectId',
  target: clientTarget,
  nip: '1111111111',
  companyName: 'Client A Sp. z o.o.',
};

const invoice: Classification = {
  documentType: 'Faktura zakupu',
  folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
  confidence: 0.93,
  classifier: 'claude',
  fields: { category: 'faktury_zakupu', year: 2026, month: 9, reasoning: 'model free text' },
};

function payload(filenames: string[] = ['faktura.pdf']): IngestionBatchRequestPayload {
  return {
    documents: filenames.map((filename) => ({
      filename,
      contentType: 'application/pdf',
      contentBase64: Buffer.from(`bytes of ${filename}`).toString('base64'),
    })),
    source: {
      tenantId: 't',
      channelId: 'msteams',
      conversationId: 'c',
      activityId: 'a',
      conversationType: 'personal',
      teamsChannelId: undefined,
      userAadObjectId: OID,
      userDisplayName: undefined,
    },
  };
}

/** A logger that records every call, so tests can assert what reaches the logs. */
function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const make = (bindings: Record<string, unknown>): Logger => {
    const write = (obj: unknown, msg?: string) =>
      lines.push({ ...bindings, ...(typeof obj === 'object' && obj ? obj : { msg: obj }), msg });
    return {
      info: write,
      warn: write,
      error: write,
      debug: write,
      child: (more: Record<string, unknown>) => make({ ...bindings, ...more }),
    } as unknown as Logger;
  };
  return { log: make({}), lines };
}

interface FakeSharePoint {
  uploads: { target: SharePointTarget; args: UploadDocumentArgs }[];
  fields: { target: SharePointTarget; itemId: string; fields: Record<string, string> }[];
  failFor: Map<SharePointTarget, unknown>;
}

function setup(resolved: ResolvedClient, opts: { classify?: jest.Mock } = {}) {
  const sp: FakeSharePoint = { uploads: [], fields: [], failFor: new Map() };
  let n = 0;
  const classify =
    opts.classify ?? jest.fn(async (_ctx: ClassifierContext): Promise<Classification> => invoice);
  const deps: BatchIngestorDeps = {
    resolver: {
      resolve: jest.fn().mockResolvedValue(resolved),
      resolvePostClassification: jest.fn((client, classification) => ({ client, classification })),
      quarantine: jest.fn((reason: QuarantineReason) => ({
        source: 'quarantine' as const,
        reason,
        target: quarantineTarget,
      })),
    },
    classification: { classify },
    sharePointFactory: {
      forTarget: (target: SharePointTarget) => ({
        uploadDocument: jest.fn(async (args: UploadDocumentArgs): Promise<DriveItemRef> => {
          const failure = sp.failFor.get(target);
          if (failure) throw failure;
          sp.uploads.push({ target, args });
          return {
            id: `item-${sp.uploads.length}`,
            name: args.filename,
            webUrl: `https://${target.siteHostname}${target.sitePath}/${args.filename}`,
          };
        }),
        setListItemFields: jest.fn(async (itemId: string, fields: Readonly<Record<string, string>>) => {
          sp.fields.push({ target, itemId, fields: { ...fields } });
          return true;
        }),
      }),
    },
    now: () => new Date('2026-09-25T10:00:00Z'),
    newId: () => `id-${++n}`,
  };
  return { ingestor: new BatchIngestor(deps), deps, sp, classify };
}

describe('BatchIngestor — bound client', () => {
  it("files into the client's own space and returns the taxonomy label, never model text", async () => {
    const { ingestor, sp, classify } = setup(clientA);
    const { log } = recordingLogger();
    const [result] = await ingestor.ingestBatch(payload(), log);

    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ client: { nip: '1111111111', companyName: 'Client A Sp. z o.o.' } }),
    );
    expect(sp.uploads).toHaveLength(1);
    expect(sp.uploads[0]!.target).toBe(clientTarget);
    expect(sp.uploads[0]!.args.folderPath).toBe('01_Faktury/02_Faktury_zakupu/2026/09');
    expect(result).toEqual({
      filename: 'faktura.pdf',
      status: 'uploaded',
      result: {
        driveItemId: 'item-1',
        webUrl: 'https://contoso.sharepoint.com/sites/ClientA/faktura.pdf',
        folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
        finalFilename: 'faktura.pdf',
        classification: {
          documentType: 'Faktura zakupu',
          categoryId: 'faktury_zakupu',
          confidence: 0.93,
          classifier: 'claude',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('model free text');
  });

  it('logs document.filed with ids only — no filename, title, NIP or location', async () => {
    const { ingestor } = setup(clientA);
    const { log, lines } = recordingLogger();
    await ingestor.ingestBatch(payload(['8652567240-20260217-ABC.pdf']), log);

    const filed = lines.find((l) => l['event'] === 'document.filed');
    expect(filed).toMatchObject({
      documentId: 'id-2',
      clientId: '0002',
      listItemId: '11',
      category: 'faktury_zakupu',
      driveItemId: 'item-1',
    });
    const serialized = JSON.stringify(lines);
    const leaks = ['8652567240', 'Client A', '1111111111', '/sites/ClientA', 'faktura'].filter((s) =>
      serialized.includes(s),
    );
    expect(leaks).toEqual([]);
  });

  it.each([
    ['no write grant (403)', new SharePointTargetError('forbidden', 'x'), 'target_unwritable'],
    ['site gone (404)', new SharePointTargetError('site_not_found', 'x'), 'target_unwritable'],
    ['a transient failure after retries', new SharePointError('Upload failed', 502), 'target_unwritable'],
    ['a drive that no longer matches the row', new SharePointTargetError('drive_mismatch', 'x'), 'stale_directory'],
  ])('holds the document in quarantine when the client space fails with %s', async (_l, failure, reason) => {
    const { ingestor, sp } = setup(clientA);
    sp.failFor.set(clientTarget, failure);
    const [result] = await ingestor.ingestBatch(payload(), recordingLogger().log);

    expect(result).toEqual({ filename: 'faktura.pdf', status: 'quarantined' });
    expect(sp.uploads).toHaveLength(1);
    expect(sp.uploads[0]!.target).toBe(quarantineTarget);
    expect(sp.fields[0]!.fields['QuarantineReason']).toBe(reason);
  });

  it('rejects a document whose name cannot be made safe, without quarantining it', async () => {
    const { ingestor, sp } = setup(clientA);
    sp.failFor.set(clientTarget, new ValidationError('Filename is empty after sanitisation'));
    const [result] = await ingestor.ingestBatch(payload(), recordingLogger().log);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'ValidationError' } });
    expect(sp.uploads).toHaveLength(0);
  });

  it('keeps going after one document fails', async () => {
    const classify = jest
      .fn()
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValue(invoice);
    const { ingestor } = setup(clientA, { classify });
    const results = await ingestor.ingestBatch(payload(['a.pdf', 'b.pdf']), recordingLogger().log);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'uploaded']);
    expect(results[0]!.error).toEqual({ code: 'InternalError', message: 'The document could not be processed' });
  });
});

describe('BatchIngestor — quarantine', () => {
  const unmapped: ResolvedClient = { source: 'quarantine', reason: 'unmapped', target: quarantineTarget };

  it('stores the upload in the staff quarantine without classifying it', async () => {
    const { ingestor, sp, classify } = setup(unmapped);
    const [result] = await ingestor.ingestBatch(payload(['skan.pdf']), recordingLogger().log);

    expect(classify).not.toHaveBeenCalled();
    expect(sp.uploads).toHaveLength(1);
    expect(sp.uploads[0]!.target).toBe(quarantineTarget);
    expect(sp.uploads[0]!.args.folderPath).toBe('2026/09/id-1');
    expect(sp.uploads[0]!.args.filename).toBe('skan.pdf');
    expect(result).toEqual({ filename: 'skan.pdf', status: 'quarantined' });
  });

  it('records who uploaded it on the quarantined item, for triage by identity', async () => {
    const { ingestor, sp } = setup(unmapped);
    await ingestor.ingestBatch(payload(['skan.pdf']), recordingLogger().log);
    expect(sp.fields).toEqual([
      {
        target: quarantineTarget,
        itemId: 'item-1',
        fields: {
          UploaderOid: OID,
          QuarantineReason: 'unmapped',
          OriginalFilename: 'skan.pdf',
          DocumentId: 'id-2',
        },
      },
    ]);
  });

  it('returns nothing about where the document went', async () => {
    const { ingestor } = setup(unmapped);
    const results = await ingestor.ingestBatch(payload(['skan.pdf']), recordingLogger().log);
    const json = JSON.stringify(results);
    const leaks = ['sharepoint', 'Kwarantanna', 'sites', 'item-', 'unmapped'].filter((s) =>
      json.includes(s),
    );
    expect(leaks).toEqual([]);
  });

  it('logs document.quarantined with the reason and uploader id', async () => {
    const { ingestor } = setup(unmapped);
    const { log, lines } = recordingLogger();
    await ingestor.ingestBatch(payload(['skan.pdf']), log);
    expect(lines.find((l) => l['event'] === 'document.quarantined')).toMatchObject({
      documentId: 'id-2',
      quarantineReason: 'unmapped',
      uploaderOid: OID,
      driveItemId: 'item-1',
    });
  });

  it('rejects the document (never files it elsewhere) when the quarantine itself fails', async () => {
    const { ingestor, sp } = setup(unmapped);
    sp.failFor.set(quarantineTarget, new SharePointError('Upload failed', 502));
    const { log, lines } = recordingLogger();
    const [result] = await ingestor.ingestBatch(payload(['skan.pdf']), log);
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'QuarantineFailed' } });
    expect(sp.uploads).toHaveLength(0);
    expect(lines.some((l) => l['event'] === 'document.quarantine_failed')).toBe(true);
  });
});
