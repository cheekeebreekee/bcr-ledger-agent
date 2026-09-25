import type { Client } from '@microsoft/microsoft-graph-client';
import { SharePointError, type SharePointTarget } from '@bcr/shared';
import { SharePointService, SharePointTargetError, graphStatus, splitExtension } from './sharePointService';

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
}

type Handler = (call: Call) => unknown;

/** A Graph client double: every request is recorded and answered by the first matching handler. */
function fakeGraph(handlers: [RegExp, Handler][]): { client: Client; calls: Call[] } {
  const calls: Call[] = [];
  const api = (path: string) => {
    const query: Record<string, string> = {};
    const request = {
      query(q: Record<string, string>) {
        Object.assign(query, q);
        return request;
      },
      header() {
        return request;
      },
      get: () => respond('get'),
      post: (body: unknown) => respond('post', body),
      put: (body: unknown) => respond('put', body),
      patch: (body: unknown) => respond('patch', body),
    };
    const respond = async (method: Call['method'], body?: unknown) => {
      const call: Call = { method, path, query, body };
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

  it('retries transient failures and succeeds', async () => {
    let puts = 0;
    const { client } = fakeGraph([
      ...siteAndDrive,
      [/^PUT /, () => {
        puts += 1;
        if (puts === 1) throw graphError(503);
        return { id: 'i', name: 'n', webUrl: 'u' };
      }],
    ]);
    const svc = new SharePointService(client, target, { retry: { retries: 2, minTimeoutMs: 0 } });
    await expect(svc.uploadDocument(doc)).resolves.toMatchObject({ id: 'i' });
    expect(puts).toBe(2);
  });

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

  it('stops on a non-retryable chunk failure', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/createUploadSession$/, () => ({ uploadUrl: 'https://upload.example/s' })]]);
    const svc = new SharePointService(client, target, { ...noRetry, fetch: fetchReturning([400]) });
    await expect(svc.uploadDocument({ ...doc, content: big })).rejects.toThrow(/Chunk upload HTTP 400/);
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

  it('returns false instead of failing the upload', async () => {
    const { client } = fakeGraph([...siteAndDrive, [/^PATCH /, () => { throw graphError(400); }]]);
    await expect(
      new SharePointService(client, target, noRetry).setListItemFields('item-9', { a: 'b' }),
    ).resolves.toBe(false);
  });
});

describe('helpers', () => {
  it('splits an extension off a filename', () => {
    expect(splitExtension('a.b.pdf')).toEqual({ name: 'a.b', ext: '.pdf' });
    expect(splitExtension('.hidden')).toEqual({ name: '.hidden', ext: '' });
    expect(splitExtension('noext')).toEqual({ name: 'noext', ext: '' });
  });

  it('reads a status from statusCode or status', () => {
    expect(graphStatus({ statusCode: 404 })).toBe(404);
    expect(graphStatus({ status: 429 })).toBe(429);
    expect(graphStatus(new Error('x'))).toBeUndefined();
    expect(graphStatus(null)).toBeUndefined();
  });
});
