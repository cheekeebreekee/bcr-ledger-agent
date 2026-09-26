import Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@microsoft/microsoft-graph-client';
import { PDFDocument } from 'pdf-lib';
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
import { AcceptancePolicy } from './acceptancePolicy';
import { BatchIngestor, RETRY_LATER, type BatchIngestorDeps } from './batchIngestor';
import {
  ClassificationService,
  FallbackClassifier,
  type ClassificationOutcome,
} from './classificationService';
import { ClaudeClassifier } from './claudeClassifier';
import {
  cachedSiteIdLookup,
  SharePointTargetError,
  type UploadDocumentArgs,
} from './sharePointService';
import { SharePointServiceFactory } from './sharePointServiceFactory';

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
  teamId: 'team-0002',
  nip: '1111111111',
  companyName: 'Client A Sp. z o.o.',
};

const invoice: Classification = {
  documentType: 'Faktura zakupu',
  folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
  confidence: 0.93,
  classifier: 'claude',
  model: 'claude-opus-5',
  fields: {
    category: 'faktury_zakupu',
    year: 2026,
    month: 9,
    direction: 'zakup',
    reasoning: 'model free text',
  },
};

const policy = new AcceptancePolicy(0.7);

/** What the classification service returns for a classifier result: the policy's decision. */
function decided(c: Classification): ClassificationOutcome {
  return { kind: 'decided', decision: policy.decide(c, new Date('2026-09-25T10:00:00Z')) };
}

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

type FactoryName = 'client' | 'quarantine';

interface FakeSharePoint {
  uploads: { factory: FactoryName; target: SharePointTarget; args: UploadDocumentArgs }[];
  fields: { target: SharePointTarget; itemId: string; fields: Record<string, string> }[];
  failFor: Map<SharePointTarget, unknown>;
}

function setup(
  resolved: ResolvedClient,
  opts: { classify?: jest.Mock; now?: () => Date; batchDeadlineMs?: number } = {},
) {
  const sp: FakeSharePoint = { uploads: [], fields: [], failFor: new Map() };
  let n = 0;
  const classify =
    opts.classify ??
    jest.fn(async (_ctx: ClassifierContext): Promise<ClassificationOutcome> => decided(invoice));
  const factory = (name: FactoryName) => ({
    forTarget: (target: SharePointTarget) => ({
      uploadDocument: jest.fn(async (args: UploadDocumentArgs): Promise<DriveItemRef> => {
        const failure = sp.failFor.get(target);
        if (failure) throw failure;
        sp.uploads.push({ factory: name, target, args });
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
  });
  const deps: BatchIngestorDeps = {
    resolver: {
      resolve: jest.fn().mockResolvedValue(resolved),
      quarantine: jest.fn((reason: QuarantineReason) => ({
        source: 'quarantine' as const,
        reason,
        target: quarantineTarget,
      })),
    },
    classification: { classify },
    clientSharePointFactory: factory('client'),
    quarantineSharePointFactory: factory('quarantine'),
    now: opts.now ?? (() => new Date('2026-09-25T10:00:00Z')),
    newId: () => `id-${++n}`,
    ...(opts.batchDeadlineMs !== undefined ? { batchDeadlineMs: opts.batchDeadlineMs } : {}),
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
      new Date('2026-09-25T10:00:00Z'),
    );
    expect(sp.uploads).toHaveLength(1);
    expect(sp.uploads[0]!.target).toBe(clientTarget);
    expect(sp.uploads[0]!.factory).toBe('client');
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
      teamId: 'team-0002',
      driveItemId: 'item-1',
      review: false,
      category: 'faktury_zakupu',
      confidence: 0.93,
      classifier: 'claude',
      model: 'claude-opus-5',
      month: '2026-09',
      reviewReasons: [],
      folder: '01_Faktury/02_Faktury_zakupu/2026/09',
    });
    expect(filed).not.toHaveProperty('suggestedCategory');
    expect(lines.find((l) => l['msg'] === 'client resolved')).toMatchObject({ teamId: 'team-0002' });
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
    [
      'a site that resolves to BCR GROUP or the quarantine',
      new SharePointTargetError('forbidden_site', 'x'),
      'forbidden_target',
    ],
  ])('holds the document in quarantine when the client space fails with %s', async (_l, failure, reason) => {
    const { ingestor, sp } = setup(clientA);
    sp.failFor.set(clientTarget, failure);
    const { log, lines } = recordingLogger();
    const [result] = await ingestor.ingestBatch(payload(), log);

    expect(result).toEqual({ filename: 'faktura.pdf', status: 'quarantined' });
    expect(sp.uploads).toHaveLength(1);
    expect(sp.uploads[0]!.target).toBe(quarantineTarget);
    expect(sp.uploads[0]!.factory).toBe('quarantine');
    expect(sp.fields[0]!.fields['QuarantineReason']).toBe(reason);
    expect(lines.find((l) => l['quarantineReason'] === reason && l['clientId'])).toMatchObject({
      clientId: '0002',
      listItemId: '11',
      teamId: 'team-0002',
      ...(failure instanceof SharePointTargetError ? { targetErrorKind: failure.kind } : {}),
    });
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
      .mockResolvedValue(decided(invoice));
    const { ingestor } = setup(clientA, { classify });
    const results = await ingestor.ingestBatch(payload(['a.pdf', 'b.pdf']), recordingLogger().log);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'uploaded']);
    expect(results[0]!.error).toEqual({ code: 'InternalError', message: 'The document could not be processed' });
  });
});

describe('BatchIngestor — classification outcomes', () => {
  it('hands a document back with RetryLater when the model cannot answer now, filing nothing', async () => {
    const classify = jest.fn(
      async (): Promise<ClassificationOutcome> => ({
        kind: 'retry_later',
        classifier: 'claude',
        reason: 'overloaded',
        status: 529,
      }),
    );
    const { ingestor, sp } = setup(clientA, { classify });
    const { log, lines } = recordingLogger();
    const [result] = await ingestor.ingestBatch(payload(), log);

    expect(result).toEqual({
      filename: 'faktura.pdf',
      status: 'rejected',
      error: { code: RETRY_LATER, message: 'The document was not processed now; send it again later' },
    });
    expect(sp.uploads).toEqual([]);
    expect(lines.find((l) => l['event'] === 'document.retry_later')).toMatchObject({
      documentId: 'id-2',
      clientId: '0002',
      listItemId: '11',
      teamId: 'team-0002',
      classifier: 'claude',
      reason: 'overloaded',
      status: 529,
    });
    expect(lines.some((l) => l['event'] === 'document.filed')).toBe(false);
  });

  it('files a document the policy sends to review into 98_ of the client’s own space, suggestion logged', async () => {
    const unresolved: Classification = {
      ...invoice,
      confidence: 0.5,
      reviewReasons: ['DIRECTION_UNRESOLVED'],
      fields: { category: 'faktury_sprzedazy', year: 2026, month: 7 },
    };
    const { ingestor, sp } = setup(clientA, { classify: jest.fn(async () => decided(unresolved)) });
    const { log, lines } = recordingLogger();
    const [result] = await ingestor.ingestBatch(payload(), log);

    expect(sp.uploads.map((u) => [u.factory, u.args.folderPath])).toEqual([
      ['client', '98_Nieposortowane/2026/09'],
    ]);
    expect(result?.result?.classification).toEqual({
      documentType: 'Nieposortowane',
      categoryId: 'nieposortowane',
      confidence: 0.5,
      classifier: 'claude',
    });
    expect(lines.find((l) => l['event'] === 'document.filed')).toMatchObject({
      review: true,
      category: 'nieposortowane',
      suggestedCategory: 'faktury_sprzedazy',
      month: '2026-07',
      confidence: 0.5,
      reviewReasons: ['DIRECTION_UNRESOLVED', 'LOW_CONFIDENCE'],
      folder: '98_Nieposortowane/2026/09',
    });
  });

  describe('with the real classifier behind a fake Claude API', () => {
    const silent = { info: () => undefined, warn: () => undefined } as unknown as Logger;

    function realClassification(create: jest.Mock) {
      const claude = new ClaudeClassifier({
        apiKey: 'k',
        model: 'claude-opus-5',
        maxContentBytes: 10 * 1024 * 1024,
        client: { messages: { create } } as never,
        log: silent,
      });
      return new ClassificationService([claude, new FallbackClassifier()], {
        policy,
        log: silent,
      });
    }

    async function longPdf(pages: number): Promise<Buffer> {
      const doc = await PDFDocument.create();
      for (let i = 0; i < pages; i += 1) doc.addPage([100, 100]);
      return Buffer.from(await doc.save());
    }

    it('files the original of a 101-page PDF, although the model read only its first 20 pages', async () => {
      const original = await longPdf(101);
      const create = jest.fn().mockResolvedValue({
        model: 'claude-opus-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              category: 'umowy',
              year: null,
              month: null,
              confidence: 0.9,
              client_role: 'none',
              reasoning: 'OWU',
              parties: [],
            }),
          },
        ],
      });
      const { deps, sp } = setup(clientA);
      const real = new BatchIngestor({ ...deps, classification: realClassification(create) });

      const [result] = await real.ingestBatch(
        {
          ...payload(),
          documents: [
            { filename: 'owu.pdf', contentType: 'application/pdf', contentBase64: original.toString('base64') },
          ],
        },
        recordingLogger().log,
      );

      expect(result?.status).toBe('uploaded');
      expect(sp.uploads[0]?.args.folderPath).toBe('04_Umowy');
      expect(sp.uploads[0]?.args.content.equals(original)).toBe(true);
      const sent = create.mock.calls[0][0].messages[0].content[0].source.data as string;
      expect((await PDFDocument.load(Buffer.from(sent, 'base64'))).getPageCount()).toBe(20);
    });

    it('never files a document to 98_ because Claude was overloaded', async () => {
      const create = jest
        .fn()
        .mockRejectedValue(Anthropic.APIError.generate(529, { type: 'error' }, 'Overloaded', new Headers()));
      const { deps, sp } = setup(clientA);
      const real = new BatchIngestor({ ...deps, classification: realClassification(create) });

      const results = await real.ingestBatch(payload(['a.pdf', 'b.pdf']), recordingLogger().log);

      expect(results.map((r) => r.error?.code)).toEqual([RETRY_LATER, RETRY_LATER]);
      expect(sp.uploads).toEqual([]);
    });
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
    expect(sp.uploads[0]!.factory).toBe('quarantine');
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

  // The runtime Team check (R46): a bound guest who is not in their row's
  // Team alone, or whose Teams cannot be read, is held like any other reason.
  it.each(['membership_mismatch', 'membership_unverified'] as const)(
    'holds a %s upload unclassified, and records the reason on the item',
    async (reason) => {
      const held: ResolvedClient = { source: 'quarantine', reason, target: quarantineTarget };
      const { ingestor, sp, classify } = setup(held);
      const { log, lines } = recordingLogger();
      const [result] = await ingestor.ingestBatch(payload(['skan.pdf']), log);

      expect(result).toEqual({ filename: 'skan.pdf', status: 'quarantined' });
      expect(classify).not.toHaveBeenCalled();
      expect(sp.uploads.map((u) => u.factory)).toEqual(['quarantine']);
      expect(sp.fields[0]!.fields['QuarantineReason']).toBe(reason);
      expect(lines.find((l) => l['event'] === 'document.quarantined')).toMatchObject({
        quarantineReason: reason,
      });
    },
  );

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

describe('BatchIngestor — batch deadline', () => {
  /** A clock that moves forward by `stepMs` every time it is read. */
  function steppingClock(stepMs: number): () => Date {
    let t = Date.parse('2026-09-25T10:00:00Z');
    return () => {
      const d = new Date(t);
      t += stepMs;
      return d;
    };
  }

  it('hands back the documents not started by the deadline for a retry, never filing them late', async () => {
    // The clock is read at the start and once before each document: 0, 60, 120, 180, 240 s.
    const { ingestor, sp, classify } = setup(clientA, {
      now: steppingClock(60_000),
      batchDeadlineMs: 150_000,
    });
    const { log, lines } = recordingLogger();
    const results = await ingestor.ingestBatch(payload(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']), log);

    expect(results.map((r) => r.status)).toEqual(['uploaded', 'uploaded', 'rejected', 'rejected']);
    expect(results[2]).toEqual({
      filename: 'c.pdf',
      status: 'rejected',
      error: { code: RETRY_LATER, message: 'The document was not processed now; send it again later' },
    });
    expect(sp.uploads.map((u) => u.args.filename)).toEqual(['a.pdf', 'b.pdf']);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(lines.find((l) => l['event'] === 'batch.deadline_exceeded')).toMatchObject({
      notStartedCount: 2,
      documentCount: 4,
    });
  });

  it('finishes a document it started before the deadline, even past it', async () => {
    let t = Date.parse('2026-09-25T10:00:00Z');
    const classify = jest.fn(async (): Promise<ClassificationOutcome> => {
      t += 200_000; // a slow model call
      return decided(invoice);
    });
    const { ingestor, sp } = setup(clientA, { classify, now: () => new Date(t) });
    const results = await ingestor.ingestBatch(payload(['a.pdf', 'b.pdf']), recordingLogger().log);
    expect(results.map((r) => r.status)).toEqual(['uploaded', 'rejected']);
    expect(sp.uploads).toHaveLength(1);
  });

  it('applies to quarantined batches too, and defaults to 150 s', async () => {
    const unmapped: ResolvedClient = { source: 'quarantine', reason: 'unmapped', target: quarantineTarget };
    let t = Date.parse('2026-09-25T10:00:00Z');
    const { ingestor, sp, deps } = setup(unmapped, { now: () => new Date(t) });
    (deps.resolver.resolve as jest.Mock).mockImplementation(async () => {
      t += 149_999;
      return unmapped;
    });
    const first = await ingestor.ingestBatch(payload(['a.pdf']), recordingLogger().log);
    expect(first.map((r) => r.status)).toEqual(['quarantined']);

    (deps.resolver.resolve as jest.Mock).mockImplementation(async () => {
      t += 150_000;
      return unmapped;
    });
    const second = await ingestor.ingestBatch(payload(['b.pdf']), recordingLogger().log);
    expect(second.map((r) => r.error?.code)).toEqual([RETRY_LATER]);
    expect(sp.uploads.map((u) => u.args.filename)).toEqual(['a.pdf']);
  });
});

// ---------------------------------------------------------------------------
// With the real SharePoint services: the client guard and the quarantine
// guard are separate, so a client row that resolves to the quarantine is
// refused while the quarantine itself still works.
// ---------------------------------------------------------------------------

describe('BatchIngestor — real SharePoint services and forbidden sites', () => {
  const BCR_GROUP = '11111111-1111-1111-1111-111111111111';
  const QUARANTINE = '22222222-2222-2222-2222-222222222222';
  const siteId = (collection: string, web: string) => `contoso.sharepoint.com,${collection},${web}`;
  const WEB_1 = '33333333-3333-3333-3333-333333333333';
  const WEB_2 = '44444444-4444-4444-4444-444444444444';

  interface Call {
    method: string;
    path: string;
    body: unknown;
  }

  /** Graph double: the client's path resolves to `clientSiteId`; the quarantine to its own site. */
  function fakeGraph(clientSiteId: string): { client: Client; calls: Call[] } {
    const calls: Call[] = [];
    const drives: Record<string, string> = {
      [siteId(QUARANTINE, WEB_1)]: 'drive-quarantine',
      [siteId(BCR_GROUP, WEB_1)]: 'drive-bcrgroup',
      [siteId(QUARANTINE, WEB_2)]: 'drive-quarantine-subweb',
    };
    const api = (path: string) => {
      const request = {
        query: () => request,
        header: () => request,
        middlewareOptions: () => request,
        get: () => respond('get'),
        post: (body: unknown) => respond('post', body),
        put: (body: unknown) => respond('put', body),
        patch: (body: unknown) => respond('patch', body),
      };
      const respond = async (method: string, body?: unknown): Promise<unknown> => {
        calls.push({ method, path, body });
        if (method === 'get' && path === '/sites/contoso.sharepoint.com:/sites/ClientA') {
          return { id: clientSiteId };
        }
        if (method === 'get' && path === '/sites/contoso.sharepoint.com:/sites/BCRLedgerKwarantanna') {
          return { id: siteId(QUARANTINE, WEB_1) };
        }
        const drivesOf = /^\/sites\/(.+)\/drives$/.exec(path);
        if (method === 'get' && drivesOf) {
          return { value: [{ id: drives[drivesOf[1]!] ?? 'drive-unknown', name: 'Dokumenty' }] };
        }
        if (method === 'post' && path.endsWith('/children')) return {};
        if (method === 'get' && path.startsWith('/drives/')) return { id: 'folder' };
        if (method === 'put') return { id: 'item-q', name: 'faktura.pdf', webUrl: 'u' };
        if (method === 'patch') return {};
        throw Object.assign(new Error(`unhandled ${method} ${path}`), { statusCode: 400 });
      };
      return request;
    };
    return { client: { api } as unknown as Client, calls };
  }

  function realIngestor(clientSiteId: string) {
    const { client, calls } = fakeGraph(clientSiteId);
    const { log, lines } = recordingLogger();
    const retry = { retries: 0, minTimeoutMs: 0 };
    const bcrGroup = [siteId(BCR_GROUP, WEB_1)];
    const deps: BatchIngestorDeps = {
      resolver: {
        resolve: jest.fn().mockResolvedValue(clientA),
        quarantine: jest.fn((reason: QuarantineReason) => ({
          source: 'quarantine' as const,
          reason,
          target: quarantineTarget,
        })),
      },
      classification: { classify: jest.fn(async () => decided(invoice)) },
      clientSharePointFactory: new SharePointServiceFactory(client, {
        retry,
        log,
        forbiddenSiteIds: bcrGroup,
        forbiddenSiteLookups: [cachedSiteIdLookup(client, quarantineTarget, { retry })],
      }),
      quarantineSharePointFactory: new SharePointServiceFactory(client, {
        retry,
        log,
        forbiddenSiteIds: bcrGroup,
      }),
      now: () => new Date('2026-09-25T10:00:00Z'),
      newId: () => 'id-1',
    };
    return { ingestor: new BatchIngestor(deps), calls, lines, log };
  }

  it.each([
    ['the quarantine site', siteId(QUARANTINE, WEB_1)],
    ['a subweb of the quarantine site', siteId(QUARANTINE, WEB_2)],
    ['BCR GROUP', siteId(BCR_GROUP, WEB_1)],
  ])('quarantines a client target resolving to %s as forbidden_target', async (_l, resolvedTo) => {
    const { ingestor, calls, lines, log } = realIngestor(resolvedTo);
    const [result] = await ingestor.ingestBatch(payload(), log);

    expect(result).toEqual({ filename: 'faktura.pdf', status: 'quarantined' });
    const writes = calls.filter((c) => c.method !== 'get');
    // Nothing under the client's folder; the one file is the quarantine copy.
    expect(writes.filter((c) => c.method === 'put').map((c) => c.path)).toEqual([
      '/drives/drive-quarantine/root:/Kwarantanna/2026/09/id-1/faktura.pdf:/content',
    ]);
    expect(writes.some((c) => c.path.includes('drive-bcrgroup') || c.path.includes('subweb'))).toBe(false);
    expect(writes.find((c) => c.method === 'patch')?.body).toMatchObject({
      QuarantineReason: 'forbidden_target',
    });
    expect(lines.some((l) => l['event'] === 'sharepoint.forbidden_site')).toBe(true);
  });

  it('files a client target on its own site into that site', async () => {
    const { ingestor, calls, log } = realIngestor(siteId('55555555-5555-5555-5555-555555555555', WEB_1));
    const [result] = await ingestor.ingestBatch(payload(), log);
    expect(result?.status).toBe('uploaded');
    expect(calls.filter((c) => c.method === 'put').map((c) => c.path)).toEqual([
      '/drives/drive-unknown/root:/Dokumenty%20ksi%C4%99gowe/01_Faktury/02_Faktury_zakupu/2026/09/faktura.pdf:/content',
    ]);
  });
});
