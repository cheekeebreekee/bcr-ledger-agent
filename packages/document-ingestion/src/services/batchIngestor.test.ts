import type { Client } from '@microsoft/microsoft-graph-client';
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

type FactoryName = 'client' | 'quarantine';

interface FakeSharePoint {
  uploads: { factory: FactoryName; target: SharePointTarget; args: UploadDocumentArgs }[];
  fields: { target: SharePointTarget; itemId: string; fields: Record<string, string> }[];
  failFor: Map<SharePointTarget, unknown>;
}

function setup(resolved: ResolvedClient, opts: { classify?: jest.Mock } = {}) {
  const sp: FakeSharePoint = { uploads: [], fields: [], failFor: new Map() };
  let n = 0;
  const classify =
    opts.classify ?? jest.fn(async (_ctx: ClassifierContext): Promise<Classification> => invoice);
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
      resolvePostClassification: jest.fn((client, classification) => ({ client, classification })),
      quarantine: jest.fn((reason: QuarantineReason) => ({
        source: 'quarantine' as const,
        reason,
        target: quarantineTarget,
      })),
    },
    classification: { classify },
    clientSharePointFactory: factory('client'),
    quarantineSharePointFactory: factory('quarantine'),
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
      category: 'faktury_zakupu',
      driveItemId: 'item-1',
    });
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
        resolvePostClassification: jest.fn((client, classification) => ({ client, classification })),
        quarantine: jest.fn((reason: QuarantineReason) => ({
          source: 'quarantine' as const,
          reason,
          target: quarantineTarget,
        })),
      },
      classification: { classify: jest.fn(async () => invoice) },
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
