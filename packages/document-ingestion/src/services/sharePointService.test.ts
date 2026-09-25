import { RetryHandlerOptions, type Client } from '@microsoft/microsoft-graph-client';
import { SharePointError, ValidationError, type Logger, type SharePointTarget } from '@bcr/shared';
import {
  cachedSiteIdLookup,
  forbiddenSiteKeys,
  graphStatus,
  SharePointService,
  SharePointTargetError,
  siteCollectionKey,
  splitExtension,
} from './sharePointService';

const target: SharePointTarget = {
  siteHostname: 'contoso.sharepoint.com',
  sitePath: '/sites/ClientA',
  driveName: 'Dokumenty',
  rootFolder: 'Dokumenty księgowe',
};

interface Call {
  method: 'get' | 'post' | 'put' | 'patch';
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** Per-request middleware options, e.g. RetryHandlerOptions. */
  middleware: unknown[];
}

type Handler = (call: Call) => unknown;

/** A Graph client double: every request is recorded and answered by the first matching handler. */
function fakeGraph(handlers: [RegExp, Handler][]): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  const api = (path: string) => {
    const query: Record<string, string> = {};
    const middleware: unknown[] = [];
    const request = {
      query(q: Record<string, string>) {
        Object.assign(query, q);
        return request;
      },
      header() {
        return request;
      },
      middlewareOptions(options: unknown[]) {
        middleware.push(...options);
        return request;
      },
      get: () => respond('get'),
      post: (body: unknown) => respond('post', body),
      put: (body: unknown) => respond('put', body),
      patch: (body: unknown) => respond('patch', body),
    };
    const respond = async (method: Call['method'], body?: unknown) => {
      const call: Call = { method, path, query, body, middleware };
      calls.push(call);
      const handler = handlers.find(([pattern]) => pattern.test(`${method.toUpperCase()} ${path}`));
      if (!handler) throw Object.assign(new Error(`unhandled ${method} ${path}`), { statusCode: 500 });
      return handler[1](call);
    };
    return request;
  };
  return { client: { api } as unknown as Client, calls };
}

const graphError = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
const network = () => Object.assign(new Error('fetch failed'), { statusCode: -1 });

/** A logger that records every call, so tests can assert what reaches the logs. */
function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const write = (obj: unknown, msg?: string) =>
    lines.push({ ...(typeof obj === 'object' && obj ? obj : { msg: obj }), msg });
  const log = { info: write, warn: write, error: write, debug: write } as unknown as Logger;
  return { log, lines };
}

const siteAndDrive: [RegExp, Handler][] = [
  [/^GET \/sites\/contoso\.sharepoint\.com:\/sites\/ClientA$/, () => ({ id: 'site-1' })],
  [/^GET \/sites\/site-1\/drives$/, () => ({ value: [{ id: 'drive-other', name: 'Other' }, { id: 'drive-1', name: 'Dokumenty' }] })],
  [/^POST \/drives\/drive-1\/items\/[^/]+\/children$/, () => ({})],
  [/^GET \/drives\/drive-1\/items\/[^/]+:\/.+$/, (c) => ({ id: `folder:${c.path.split(':/')[1]}` })],
];

const noRetry = { retry: { retries: 0, minTimeoutMs: 0 } };
const doc = { folderPath: '01_Faktury/2026/09', filename: 'faktura.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') };

describe('SharePointService.uploadDocument', () => {
  it('creates the folder chain under the channel folder and uploads with conflictBehavior=fail', async () => {
    const { client, calls } = fakeGraph([
      ...siteAndDrive,
      [/^PUT \/drives\/drive-1\/root:\/.+:\/content$/, () => ({ id: 'item-1', name: 'faktura.pdf', webUrl: 'u', parentReference: { driveId: 'drive-1', path: 'p' } })],
    ]);
    const item = await new SharePointService(client, target, noRetry).uploadDocument(doc);

    expect(item.id).toBe('item-1');
    const folders = calls.filter((c) => c.method === 'post').map((c) => (c.body as { name: string }).name);
    expect(folders).toEqual(['Dokumenty księgowe', '01_Faktury', '2026', '09']);
    const put = calls.find((c) => c.method === 'put')!;
    expect(put.path).toBe('/drives/drive-1/root:/Dokumenty%20ksi%C4%99gowe/01_Faktury/2026/09/faktura.pdf:/content');
    expect(put.query).toEqual({ '@microsoft.graph.conflictBehavior': 'fail' });
  });

  it('takes the next free _n name on a 409 and never probes for existing names', async () => {
    let puts = 0;
    const { client, calls } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        if (puts <= 2) throw graphError(409);
        return { id: 'item-3', name: 'faktura_2.pdf', webUrl: 'u' };
      }],
    ]);
    const item = await new SharePointService(client, target, noRetry).uploadDocument(doc);
    expect(item.name).toBe('faktura_2.pdf');
    const putNames = calls
      .filter((c) => c.method === 'put')
      .map((c) => /\/([^/]+):\/content$/.exec(c.path)?.[1]);
    expect(putNames).toEqual(['faktura.pdf', 'faktura_1.pdf', 'faktura_2.pdf']);
    const fileProbes = calls.filter((c) => c.method === 'get' && /\.pdf/.test(c.path));
    expect(fileProbes).toEqual([]);
  });

  it('gives up after the original name and ten suffixes', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/^PUT /, () => { throw graphError(409); }]]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({
      httpStatus: 409,
    });
  });

  it('percent-encodes #, % and spaces in names so they cannot truncate the URL', async () => {
    const { client, calls } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => ({ id: 'i', name: 'n', webUrl: 'u' })],
    ]);
    await new SharePointService(client, target, noRetry).uploadDocument({
      ...doc,
      filename: 'FV #12 100%.pdf',
    });
    const put = calls.find((c) => c.method === 'put')!;
    expect(put.path.endsWith('/FV%20%2312%20100%25.pdf:/content')).toBe(true);
  });

  it.each([
    ['a network failure', network],
    ['a 500', () => graphError(500)],
    ['a 502', () => graphError(502)],
  ])('retries %s on the PUT and succeeds', async (_label, failure) => {
    let puts = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        if (puts === 1) throw failure();
        return { id: 'i', name: 'n', webUrl: 'u' };
      }],
    ]);
    const svc = new SharePointService(client, target, { retry: { retries: 2, minTimeoutMs: 0 } });
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
    expect(puts).toBe(2);
  });

  // The content PUT runs with the SDK's retries off, so throttling and
  // brownouts are retried here, once per app-level attempt, never stacked.
  it.each([429, 503, 504])('retries a %i on the PUT itself, then gives up with a SharePointError', async (status) => {
    let puts = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        throw graphError(status);
      }],
    ]);
    const svc = new SharePointService(client, target, { retry: { retries: 3, minTimeoutMs: 0 } });
    await expect(svc.uploadDocument(doc)).rejects.toBeInstanceOf(SharePointError);
    expect(puts).toBe(4);
  });

  it.each(['application/octet-stream', 'application/pdf'])(
    'owns every retry of a %s PUT: the SDK retries are off and a 503 is retried here',
    async (contentType) => {
      let puts = 0;
      const { client, calls } = fakeGraph([
        ...siteAndDrive,
        [/^PUT /, () => {
          puts += 1;
          if (puts === 1) throw graphError(503);
          return { id: 'i', name: 'n', webUrl: 'u' };
        }],
      ]);
      const svc = new SharePointService(client, target, { retry: { retries: 2, minTimeoutMs: 0 } });
      await expect(svc.uploadDocument({ ...doc, contentType })).resolves.toMatchObject({ id: 'i' });
      expect(puts).toBe(2);
      const put = calls.find((c) => c.method === 'put')!;
      expect(put.middleware).toEqual([expect.any(RetryHandlerOptions)]);
      expect((put.middleware[0] as RetryHandlerOptions).maxRetries).toBe(0);
    },
  );

  it('reports a missing write grant as a target error', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/^PUT /, () => { throw graphError(403); }]]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it('reports a generic failure as SharePointError', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/^PUT /, () => { throw graphError(400); }]]);
    const err = await new SharePointService(client, target, noRetry).uploadDocument(doc).catch((e) => e);
    expect(err).toBeInstanceOf(SharePointError);
    expect(err).not.toBeInstanceOf(SharePointTargetError);
  });

  it('refuses an item that comes back in a different drive', async () => {
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => ({ id: 'i', name: 'n', webUrl: 'u', parentReference: { driveId: 'drive-evil', path: 'p' } })],
    ]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({
      kind: 'drive_mismatch',
    });
  });
});

describe('SharePointService target resolution', () => {
  it('refuses a path that now resolves to a different drive than the recorded one', async () => {
    const { client, calls } = fakeGraph(siteAndDrive);
    const svc = new SharePointService(client, { ...target, expectedDriveId: 'drive-recorded' }, noRetry);
    await expect(svc.uploadDocument(doc)).rejects.toMatchObject({ kind: 'drive_mismatch' });
    expect(calls.some((c) => c.method === 'put' || c.method === 'post')).toBe(false);
  });

  it('accepts the recorded drive', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/^PUT /, () => ({ id: 'i', name: 'n', webUrl: 'u' })]]);
    const svc = new SharePointService(client, { ...target, expectedDriveId: 'drive-1' }, noRetry);
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
  });

  it.each([
    [404, 'site_not_found'],
    [403, 'forbidden'],
  ])('classifies a %i on the site lookup as %s', async (status, kind) => {
    const { client } = fakeGraph([[/^GET \/sites\/contoso/, () => { throw graphError(status); }]]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({ kind });
  });

  it('reports a missing drive name as drive_not_found', async () => {
    const { client } = fakeGraph([
      [/^GET \/sites\/contoso/, () => ({ id: 'site-1' })],
      [/^GET \/sites\/site-1\/drives$/, () => ({ value: [{ id: 'd', name: 'Documents' }] })],
    ]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({
      kind: 'drive_not_found',
    });
  });

  it('does not cache a failed resolution', async () => {
    let first = true;
    const { client } = fakeGraph([
      [/^GET \/sites\/contoso/, () => {
        if (first) {
          first = false;
          throw graphError(503);
        }
        return { id: 'site-1' };
      }],
      ...siteAndDrive.slice(1),
      [/^PUT /, () => ({ id: 'i', name: 'n', webUrl: 'u' })],
    ]);
    const svc = new SharePointService(client, target, noRetry);
    await expect(svc.uploadDocument(doc)).rejects.toBeInstanceOf(SharePointError);
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
  });

  it('treats a 403 while creating folders as a missing write grant', async () => {
    const { client } = fakeGraph([
      ...siteAndDrive.slice(0, 2),
      [/^POST \/drives\/drive-1\/items\/root\/children$/, () => { throw graphError(403); }],
    ]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });
});

describe('SharePointService transient failures', () => {
  it('retries a network failure on every Graph call before the upload', async () => {
    const failed = new Set<string>();
    const flaky = (h: Handler): Handler => (c) => {
      const key = `${c.method} ${c.path}`;
      if (!failed.has(key)) {
        failed.add(key);
        throw network();
      }
      return h(c);
    };
    const { client } = fakeGraph([
      ...siteAndDrive.map(([re, h]): [RegExp, Handler] => [re, flaky(h)]),
      [/^PUT /, () => ({ id: 'i', name: 'n', webUrl: 'u' })],
    ]);
    const svc = new SharePointService(client, target, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
    expect(failed.size).toBeGreaterThanOrEqual(4);
  });

  it('turns a folder read that keeps failing into a SharePointError', async () => {
    const { client } = fakeGraph([
      siteAndDrive[0]!,
      siteAndDrive[1]!,
      siteAndDrive[2]!,
      [/^GET \/drives\/drive-1\/items\//, () => { throw graphError(503); }],
    ]);
    const err = await new SharePointService(client, target, noRetry).uploadDocument(doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharePointError);
    expect(err).not.toBeInstanceOf(SharePointTargetError);
  });

  it('reports a 403 on a folder read as a missing grant', async () => {
    const { client } = fakeGraph([
      siteAndDrive[0]!,
      siteAndDrive[1]!,
      siteAndDrive[2]!,
      [/^GET \/drives\/drive-1\/items\//, () => { throw graphError(403); }],
    ]);
    await expect(new SharePointService(client, target, noRetry).uploadDocument(doc)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it.each([
    [503, 1],
    [429, 1],
    [504, 1],
    [500, 3],
    [502, 3],
  ])('tries a site lookup that gets %i %i time(s): the SDK retries 429/503/504', async (status, expected) => {
    let gets = 0;
    const { client } = fakeGraph([
      [/^GET \/sites\/contoso/, () => {
        gets += 1;
        throw graphError(status);
      }],
    ]);
    const svc = new SharePointService(client, target, { retry: { retries: 2, minTimeoutMs: 0 } });
    await expect(svc.uploadDocument(doc)).rejects.toBeInstanceOf(SharePointError);
    expect(gets).toBe(expected);
  });
});

const BCR_GROUP = '11111111-1111-1111-1111-111111111111';
const QUARANTINE = '22222222-2222-2222-2222-222222222222';
const WEB = '33333333-3333-3333-3333-333333333333';
const OTHER_WEB = '44444444-4444-4444-4444-444444444444';
const CLIENT_SITE = '55555555-5555-5555-5555-555555555555';
const siteId = (collection: string, web = WEB) => `contoso.sharepoint.com,${collection},${web}`;

/** Graph where the client's path resolves to `resolvedSiteId`; everything else would succeed. */
function graphResolvingTo(resolvedSiteId: string) {
  return fakeGraph([
    [/^GET \/sites\/contoso\.sharepoint\.com:\/sites\/ClientA$/, () => ({ id: resolvedSiteId })],
    [/^GET \/sites\/[^/]+\/drives$/, () => ({ value: [{ id: 'drive-1', name: 'Dokumenty' }] })],
    [/^POST /, () => ({})],
    [/^GET \/drives\//, () => ({ id: 'folder' })],
    [/^PUT /, () => ({ id: 'i', name: 'n', webUrl: 'u' })],
  ]);
}

describe('SharePointService forbidden sites', () => {
  it.each([
    ['the same full id', siteId(BCR_GROUP)],
    ['the site collection GUID alone', BCR_GROUP],
    ['the same collection with another web (a subweb)', siteId(BCR_GROUP, OTHER_WEB)],
    ['upper case', siteId(BCR_GROUP).toUpperCase()],
  ])('refuses to write to a forbidden site given as %s, whatever path led there', async (_label, forbidden) => {
    const { client, calls } = graphResolvingTo(siteId(BCR_GROUP));
    const { log, lines } = recordingLogger();
    const svc = new SharePointService(client, target, { ...noRetry, forbiddenSiteIds: [forbidden], log });
    await expect(svc.uploadDocument(doc)).rejects.toMatchObject({ kind: 'forbidden_site', httpStatus: 403 });
    expect(calls.map((c) => c.method)).toEqual(['get']);
    expect(lines.filter((l) => l['event'] === 'sharepoint.forbidden_site')).toEqual([
      { event: 'sharepoint.forbidden_site', siteCollectionId: BCR_GROUP, msg: 'sharepoint.forbidden_site' },
    ]);
  });

  it('refuses a client target that resolves into the looked-up quarantine collection', async () => {
    const { client, calls } = graphResolvingTo(siteId(QUARANTINE, OTHER_WEB));
    const lookup = jest.fn(async () => siteId(QUARANTINE));
    const svc = new SharePointService(client, target, {
      ...noRetry,
      forbiddenSiteIds: [siteId(BCR_GROUP)],
      forbiddenSiteLookups: [lookup],
      log: recordingLogger().log,
    });
    await expect(svc.uploadDocument(doc)).rejects.toMatchObject({ kind: 'forbidden_site' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'get /sites/contoso.sharepoint.com:/sites/ClientA',
    ]);
  });

  it('files into an allowed site and looks the quarantine up once for the life of the service', async () => {
    const { client } = graphResolvingTo(siteId(CLIENT_SITE));
    const lookup = jest.fn(async () => siteId(QUARANTINE));
    const svc = new SharePointService(client, target, {
      ...noRetry,
      forbiddenSiteIds: [siteId(BCR_GROUP)],
      forbiddenSiteLookups: [lookup],
    });
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cannot be looked up', () => Promise.reject(graphError(503))],
    ['comes back in a form that cannot be compared', async () => 'contoso.sharepoint.com:/sites/Q:'],
  ])('refuses the target (fail closed) when the quarantine site %s', async (_label, lookup) => {
    const { client, calls } = graphResolvingTo(siteId(CLIENT_SITE));
    const svc = new SharePointService(client, target, { ...noRetry, forbiddenSiteLookups: [lookup] });
    const err = await svc.uploadDocument(doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharePointError);
    expect(err).not.toBeInstanceOf(SharePointTargetError);
    expect(calls.map((c) => c.method)).toEqual(['get']);
  });

  it('refuses a resolved site id it cannot compare', async () => {
    const { client, calls } = graphResolvingTo('contoso.sharepoint.com,not-a-guid');
    const svc = new SharePointService(client, target, { ...noRetry, forbiddenSiteIds: [siteId(BCR_GROUP)] });
    const err = await svc.uploadDocument(doc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharePointError);
    expect(err).not.toBeInstanceOf(SharePointTargetError);
    expect(calls.map((c) => c.method)).toEqual(['get']);
  });

  it.each([
    ["Graph's path form", 'contoso.sharepoint.com:/sites/BCRGROUP:'],
    ['a two-part id', `contoso.sharepoint.com,${BCR_GROUP}`],
    ['placeholder GUIDs', 'contoso.sharepoint.com,site-guid,web-guid'],
  ])('will not be built with a forbidden site id in %s, which could never match', (_label, id) => {
    const { client } = fakeGraph([]);
    expect(() => new SharePointService(client, target, { forbiddenSiteIds: [id] })).toThrow(ValidationError);
  });
});

describe('cachedSiteIdLookup', () => {
  const quarantineSite = { siteHostname: 'contoso.sharepoint.com', sitePath: '/sites/Kwarantanna' };

  it('looks the site up by host and path, once', async () => {
    const { client, calls } = fakeGraph([[/^GET \/sites\//, () => ({ id: siteId(QUARANTINE) })]]);
    const lookup = cachedSiteIdLookup(client, quarantineSite, noRetry);
    await expect(lookup()).resolves.toBe(siteId(QUARANTINE));
    await expect(lookup()).resolves.toBe(siteId(QUARANTINE));
    expect(calls.map((c) => c.path)).toEqual(['/sites/contoso.sharepoint.com:/sites/Kwarantanna']);
  });

  it('does not keep a failure, so the next upload asks again', async () => {
    let first = true;
    const { client, calls } = fakeGraph([
      [/^GET \/sites\//, () => {
        if (first) {
          first = false;
          throw graphError(503);
        }
        return { id: siteId(QUARANTINE) };
      }],
    ]);
    const lookup = cachedSiteIdLookup(client, quarantineSite, noRetry);
    await expect(lookup()).rejects.toMatchObject({ statusCode: 503 });
    await expect(lookup()).resolves.toBe(siteId(QUARANTINE));
    expect(calls).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    let first = true;
    const { client } = fakeGraph([
      [/^GET \/sites\//, () => {
        if (first) {
          first = false;
          throw network();
        }
        return { id: siteId(QUARANTINE) };
      }],
    ]);
    const lookup = cachedSiteIdLookup(client, quarantineSite, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(lookup()).resolves.toBe(siteId(QUARANTINE));
  });
});

describe('SharePointService possible duplicates', () => {
  it('logs a possible duplicate when a name is taken right after a network failure on it', async () => {
    let puts = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        // SharePoint stored the first PUT, but its response was lost.
        if (puts === 1) throw network();
        if (puts === 2) throw graphError(409);
        return { id: 'item-2', name: 'faktura_1.pdf', webUrl: 'u' };
      }],
    ]);
    const { log, lines } = recordingLogger();
    const svc = new SharePointService(client, target, { retry: { retries: 1, minTimeoutMs: 0 }, log });
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ name: 'faktura_1.pdf' });
    expect(lines.filter((l) => l['event'] === 'sharepoint.possible_duplicate')).toEqual([
      {
        event: 'sharepoint.possible_duplicate',
        driveItemId: 'item-2',
        nameSuffix: 1,
        msg: 'sharepoint.possible_duplicate',
      },
    ]);
  });

  it.each([500, 502, 503, 504])(
    'logs a possible duplicate when a name is taken after a %i on it (the write may have landed)',
    async (status) => {
      let puts = 0;
      const { client } = fakeGraph([
        ...siteAndDrive,
        [/^PUT /, () => {
          puts += 1;
          if (puts === 1) throw graphError(status);
          if (puts === 2) throw graphError(409);
          return { id: 'item-2', name: 'faktura_1.pdf', webUrl: 'u' };
        }],
      ]);
      const { log, lines } = recordingLogger();
      const svc = new SharePointService(client, target, { retry: { retries: 1, minTimeoutMs: 0 }, log });
      await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ name: 'faktura_1.pdf' });
      expect(lines.filter((l) => l['event'] === 'sharepoint.possible_duplicate')).toHaveLength(1);
    },
  );

  it('does not log one after a 429, which SharePoint never commits', async () => {
    let puts = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        if (puts === 1) throw graphError(429);
        if (puts === 2) throw graphError(409);
        return { id: 'item-2', name: 'faktura_1.pdf', webUrl: 'u' };
      }],
    ]);
    const { log, lines } = recordingLogger();
    const svc = new SharePointService(client, target, { retry: { retries: 1, minTimeoutMs: 0 }, log });
    await svc.uploadDocument(doc);
    expect(lines.some((l) => l['event'] === 'sharepoint.possible_duplicate')).toBe(false);
  });

  it('does not log one for an ordinary name conflict', async () => {
    let puts = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        if (puts === 1) throw graphError(409);
        return { id: 'item-2', name: 'faktura_1.pdf', webUrl: 'u' };
      }],
    ]);
    const { log, lines } = recordingLogger();
    await new SharePointService(client, target, { ...noRetry, log }).uploadDocument(doc);
    expect(lines.some((l) => l['event'] === 'sharepoint.possible_duplicate')).toBe(false);
  });
});

describe('SharePointService chunked upload', () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 1); // > 4 MiB simple-upload limit

  function fetchReturning(statuses: number[]): typeof fetch {
    return jest.fn(async () => {
      const status = statuses.shift() ?? 500;
      return {
        status,
        json: async () => ({ id: 'big-item', name: 'big.pdf', webUrl: 'u' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it('uploads in chunks through a session that never overwrites', async () => {
    const { client, calls } = fakeGraph([
      ...siteAndDrive,
      [/^POST \/drives\/drive-1\/root:.+:\/createUploadSession$/, () => ({ uploadUrl: 'https://upload.example/s1' })],
    ]);
    const svc = new SharePointService(client, target, { ...noRetry, fetch: fetchReturning([202, 202, 202, 201]) });
    const item = await svc.uploadDocument({ ...doc, content: big });
    expect(item.id).toBe('big-item');
    const session = calls.find((c) => c.path.endsWith('createUploadSession'))!;
    expect(session.body).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'fail' } });
  });

  it('moves to the next name when the session reports the name is taken', async () => {
    let sessions = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/createUploadSession$/, () => {
        sessions += 1;
        if (sessions === 1) throw graphError(409);
        return { uploadUrl: 'https://upload.example/s2' };
      }],
    ]);
    const svc = new SharePointService(client, target, { ...noRetry, fetch: fetchReturning([202, 202, 202, 201]) });
    await expect(svc.uploadDocument({ ...doc, content: big })).resolves.toMatchObject({ id: 'big-item' });
    expect(sessions).toBe(2);
  });

  it('treats a 409 on the last chunk as a name conflict', async () => {
    let sessions = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/createUploadSession$/, () => {
        sessions += 1;
        return { uploadUrl: `https://upload.example/s${sessions}` };
      }],
    ]);
    const svc = new SharePointService(client, target, {
      ...noRetry,
      fetch: fetchReturning([202, 202, 202, 409, 202, 202, 202, 201]),
    });
    await expect(svc.uploadDocument({ ...doc, content: big })).resolves.toMatchObject({ id: 'big-item' });
    expect(sessions).toBe(2);
  });

  it('logs a possible duplicate when the last chunk is taken after a network failure on it', async () => {
    let sessions = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/createUploadSession$/, () => {
        sessions += 1;
        return { uploadUrl: `https://upload.example/s${sessions}` };
      }],
    ]);
    // Session 1: the last chunk is stored but its response is lost; the retry gets 409.
    const outcomes: (number | Error)[] = [202, 202, 202, new TypeError('fetch failed'), 409];
    outcomes.push(202, 202, 202, 201); // session 2, under the next name
    const fetchFn = jest.fn(async () => {
      const next = outcomes.shift() ?? 500;
      if (next instanceof Error) throw next;
      const json = async () => ({ id: 'big-item', name: 'big_1.pdf', webUrl: 'u' });
      return { status: next, json } as unknown as Response;
    }) as unknown as typeof fetch;
    const { log, lines } = recordingLogger();
    const retry = { retries: 1, minTimeoutMs: 0 };
    const svc = new SharePointService(client, target, { retry, fetch: fetchFn, log });
    await expect(svc.uploadDocument({ ...doc, content: big })).resolves.toMatchObject({ id: 'big-item' });
    expect(sessions).toBe(2);
    expect(lines.filter((l) => l['event'] === 'sharepoint.possible_duplicate')).toHaveLength(1);
  });

  it('stops on a non-retryable chunk failure with a SharePointError the pipeline can quarantine', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/createUploadSession$/, () => ({ uploadUrl: 'https://upload.example/s' })]]);
    const svc = new SharePointService(client, target, { ...noRetry, fetch: fetchReturning([400]) });
    const err = await svc.uploadDocument({ ...doc, content: big }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SharePointError);
    expect(err).toMatchObject({ httpStatus: 502 });
  });

  it('reports a 403 on session creation as a missing write grant', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/createUploadSession$/, () => { throw graphError(403); }]]);
    const svc = new SharePointService(client, target, noRetry);
    await expect(svc.uploadDocument({ ...doc, content: big })).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('SharePointService.setListItemFields', () => {
  it('patches the list item behind a drive item', async () => {
    const { client, calls } = fakeGraph([...siteAndDrive, [/^PATCH /, () => ({})]]);
    const ok = await new SharePointService(client, target, noRetry).setListItemFields('item-9', { QuarantineReason: 'unmapped' });
    expect(ok).toBe(true);
    const patch = calls.find((c) => c.method === 'patch')!;
    expect(patch.path).toBe('/drives/drive-1/items/item-9/listItem/fields');
    expect(patch.body).toEqual({ QuarantineReason: 'unmapped' });
  });

  it('returns false instead of failing the upload, without retrying a 400', async () => {
    const { client, calls } = fakeGraph([...siteAndDrive, [/^PATCH /, () => { throw graphError(400); }]]);
    const svc = new SharePointService(client, target, { retry: { retries: 3, minTimeoutMs: 0 } });
    await expect(svc.setListItemFields('item-9', { a: 'b' })).resolves.toBe(false);
    expect(calls.filter((c) => c.method === 'patch')).toHaveLength(1);
  });

  it('retries a network failure', async () => {
    let patches = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PATCH /, () => {
        patches += 1;
        if (patches === 1) throw network();
        return {};
      }],
    ]);
    const svc = new SharePointService(client, target, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(svc.setListItemFields('item-9', { a: 'b' })).resolves.toBe(true);
    expect(patches).toBe(2);
  });
});

describe('helpers', () => {
  it('splits an extension off a filename', () => {
    expect(splitExtension('a.b.pdf')).toEqual({ name: 'a.b', ext: '.pdf' });
    expect(splitExtension('.hidden')).toEqual({ name: '.hidden', ext: '' });
    expect(splitExtension('noext')).toEqual({ name: 'noext', ext: '' });
  });

  it('keys a site id by its site collection GUID, and refuses forms it cannot compare', () => {
    expect(siteCollectionKey(`Contoso.SharePoint.com,${BCR_GROUP.toUpperCase()},${WEB}`)).toBe(BCR_GROUP);
    expect(siteCollectionKey(` ${BCR_GROUP} `)).toBe(BCR_GROUP);
    expect(siteCollectionKey('contoso.sharepoint.com:/sites/BCRGROUP:')).toBeNull();
    expect(siteCollectionKey(`contoso.sharepoint.com,${BCR_GROUP}`)).toBeNull();
    expect(siteCollectionKey('')).toBeNull();
    expect([...forbiddenSiteKeys([siteId(BCR_GROUP), QUARANTINE])]).toEqual([BCR_GROUP, QUARANTINE]);
  });

  it('reads a status from statusCode or status', () => {
    expect(graphStatus({ statusCode: 404 })).toBe(404);
    expect(graphStatus({ status: 429 })).toBe(429);
    expect(graphStatus(new Error('x'))).toBeUndefined();
    expect(graphStatus(null)).toBeUndefined();
  });
});
