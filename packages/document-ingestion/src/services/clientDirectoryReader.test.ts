import type { Client } from '@microsoft/microsoft-graph-client';
import { ClientDirectoryReader, normalizeAadId, normalizeName, normalizeNip, toEntry } from './clientDirectoryReader';

describe('toEntry', () => {
  it('parses a full directory row', () => {
    const entry = toEntry({
      id: '42',
      fields: {
        Title: '[0002] PESKOVOI Sp. z o. o. - Księgowość',
        ClientId: '0002',
        NIP: '  123-456-78-90 ',
        CompanyNameAliases: 'PESKOVOI Sp. z o.o.\nPeskovoi\n\n  Peskovoi Group  ',
        PersonNames: 'Jan Kowalski\nAnna Nowak',
        SiteHostname: 'contoso.sharepoint.com',
        SitePath: '/sites/Client-0002',
        DriveName: 'Dokumenty',
        RootFolder: 'BCR',
        IsAdmin: false,
        Status: 'Active',
      },
    });
    expect(entry).not.toBeNull();
    expect(entry!.clientId).toBe('0002');
    expect(entry!.nip).toBe('1234567890');
    expect(entry!.companyNameAliases).toEqual([
      'PESKOVOI Sp. z o.o.',
      'Peskovoi',
      'Peskovoi Group',
    ]);
    expect(entry!.personNames).toEqual(['Jan Kowalski', 'Anna Nowak']);
    expect(entry!.target).toEqual({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/Client-0002',
      driveName: 'Dokumenty',
      rootFolder: 'BCR',
    });
    expect(entry!.isAdmin).toBe(false);
    expect(entry!.active).toBe(true);
  });

  it('defaults drive to `Documents` when omitted', () => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0001',
        SiteHostname: 'contoso.sharepoint.com',
        SitePath: '/sites/x',
      },
    });
    expect(entry!.target.driveName).toBe('Documents');
  });

  it('treats missing Status as active (defaults to Active)', () => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0001',
        SiteHostname: 'a.sharepoint.com',
        SitePath: '/sites/x',
      },
    });
    expect(entry!.active).toBe(true);
  });

  it('marks Inactive rows as inactive', () => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0001',
        SiteHostname: 'a.sharepoint.com',
        SitePath: '/sites/x',
        Status: 'Inactive',
      },
    });
    expect(entry!.active).toBe(false);
  });

  it('rejects a row missing ClientId', () => {
    expect(
      toEntry({
        id: '1',
        fields: { Title: 'x', SiteHostname: 'a', SitePath: '/sites/x' },
      }),
    ).toBeNull();
  });

  it('rejects a non-admin row missing a SharePoint target', () => {
    expect(
      toEntry({
        id: '1',
        fields: { ClientId: '0001', IsAdmin: false },
      }),
    ).toBeNull();
  });

  it('accepts an admin row without a SharePoint target', () => {
    const entry = toEntry({
      id: '1',
      fields: { ClientId: 'admin-roman', Title: 'Roman', IsAdmin: true },
    });
    expect(entry).not.toBeNull();
    expect(entry!.isAdmin).toBe(true);
    expect(entry!.target.siteHostname).toBe('');
    expect(entry!.target.sitePath).toBe('');
  });
});

describe('normalizeName / normalizeNip', () => {
  it('normalizes diacritics + case + whitespace', () => {
    expect(normalizeName('  PESKOVOI Sp. z o.o. ')).toBe('peskovoi sp z o o');
    expect(normalizeName('Księgowość')).toBe('ksiegowosc');
    expect(normalizeName('ACME  --  s.a.')).toBe('acme s a');
  });

  it('strips everything but digits from NIP', () => {
    expect(normalizeNip('PL 123-456-78-90')).toBe('1234567890');
    expect(normalizeNip('')).toBe('');
    expect(normalizeNip('N/A')).toBe('');
  });
});

describe('normalizeAadId', () => {
  it('lower-cases GUIDs and returns them intact', () => {
    expect(normalizeAadId('AE3987D3-9A3A-4FF8-BCF7-713D24E79C48')).toBe(
      'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
    );
  });

  it('trims whitespace', () => {
    expect(normalizeAadId('  ae3987d3-9a3a-4ff8-bcf7-713d24e79c48\n')).toBe(
      'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
    );
  });

  it('returns empty string for non-GUID input', () => {
    expect(normalizeAadId('yahor.simak@bcr-group.pl')).toBe('');
    expect(normalizeAadId('not-a-guid')).toBe('');
    expect(normalizeAadId('')).toBe('');
  });
});

describe('toEntry — userAadObjectIds parsing', () => {
  it('parses multi-line UserAadObjectIds and drops invalid entries', () => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0002',
        SiteHostname: 'a.sharepoint.com',
        SitePath: '/sites/x',
        UserAadObjectIds:
          'AE3987D3-9A3A-4FF8-BCF7-713D24E79C48\n' +
          'not-a-guid\n' +
          '  11111111-1111-1111-1111-111111111111  ',
      },
    });
    expect(entry!.userAadObjectIds).toEqual([
      'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
      '11111111-1111-1111-1111-111111111111',
    ]);
  });

  it('defaults userAadObjectIds to [] when column is absent', () => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0001',
        SiteHostname: 'a.sharepoint.com',
        SitePath: '/sites/x',
      },
    });
    expect(entry!.userAadObjectIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end reader behaviour (paging, TTL cache, dedup)
// ---------------------------------------------------------------------------

interface FakeApi {
  get: jest.Mock<Promise<unknown>, []>;
}

function makeGraph(pages: unknown[]): { client: Client; api: jest.Mock } {
  const api = jest.fn((_path: string): FakeApi => ({
    get: jest.fn().mockImplementation(() => {
      const next = pages.shift();
      return Promise.resolve(next);
    }),
  }));
  return { client: { api } as unknown as Client, api };
}

const activeRow = (
  id: string,
  fields: Record<string, unknown>,
): { id: string; fields: Record<string, unknown> } => ({
  id,
  fields: {
    Status: 'Active',
    SiteHostname: 'contoso.sharepoint.com',
    SitePath: `/sites/Client-${id}`,
    DriveName: 'Documents',
    ...fields,
  },
});

describe('ClientDirectoryReader', () => {
  it('follows @odata.nextLink until exhausted', async () => {
    const page1 = {
      value: [activeRow('1', { ClientId: '0001', NIP: '1111111111' })],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
    };
    const page2 = {
      value: [activeRow('2', { ClientId: '0002', NIP: '2222222222' })],
    };
    const { client, api } = makeGraph([page1, page2]);
    const reader = new ClientDirectoryReader(client, {
      siteId: 'site',
      listId: 'list',
      cacheTtlMs: 60_000,
    });

    const snap = await reader.getSnapshot();

    expect(api).toHaveBeenCalledTimes(2);
    expect(snap.entries.map((e) => e.clientId)).toEqual(['0001', '0002']);
    expect(snap.byNip.size).toBe(2);
  });

  it('caches the snapshot within TTL', async () => {
    const page = { value: [activeRow('1', { ClientId: '0001' })] };
    const { client, api } = makeGraph([page, page]);
    let now = 1_000_000;
    const reader = new ClientDirectoryReader(client, {
      siteId: 's',
      listId: 'l',
      cacheTtlMs: 5_000,
      now: () => now,
    });

    await reader.getSnapshot();
    now += 4_999;
    await reader.getSnapshot();
    expect(api).toHaveBeenCalledTimes(1);

    now += 2; // now past TTL
    await reader.getSnapshot();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('drops inactive rows', async () => {
    const page = {
      value: [
        activeRow('1', { ClientId: '0001' }),
        activeRow('2', { ClientId: '0002', Status: 'Inactive' }),
      ],
    };
    const { client } = makeGraph([page]);
    const reader = new ClientDirectoryReader(client, {
      siteId: 's',
      listId: 'l',
      cacheTtlMs: 60_000,
    });
    const snap = await reader.getSnapshot();
    expect(snap.entries.map((e) => e.clientId)).toEqual(['0001']);
  });

  it('drops duplicate keys across clients (fail-closed)', async () => {
    const page = {
      value: [
        activeRow('1', {
          ClientId: '0001',
          NIP: '1234567890',
          CompanyNameAliases: 'ACME',
        }),
        activeRow('2', {
          ClientId: '0002',
          NIP: '1234567890', // same NIP on a different client
          CompanyNameAliases: 'DIFFERENT',
        }),
      ],
    };
    const { client } = makeGraph([page]);
    const reader = new ClientDirectoryReader(client, {
      siteId: 's',
      listId: 'l',
      cacheTtlMs: 60_000,
    });
    const snap = await reader.getSnapshot();
    // Both entries kept, but the ambiguous NIP is removed from the lookup
    // map so neither client wins by content.
    expect(snap.entries).toHaveLength(2);
    expect(snap.byNip.has('1234567890')).toBe(false);
    expect(snap.byCompanyAlias.get('acme')?.clientId).toBe('0001');
    expect(snap.byCompanyAlias.get('different')?.clientId).toBe('0002');
  });

  it('returns an empty snapshot on the first fetch failure', async () => {
    const api = jest.fn(() => ({
      get: jest.fn().mockRejectedValue(new Error('boom')),
    }));
    const client = { api } as unknown as Client;
    const reader = new ClientDirectoryReader(client, {
      siteId: 's',
      listId: 'l',
      cacheTtlMs: 60_000,
    });
    const snap = await reader.getSnapshot();
    expect(snap.entries).toHaveLength(0);
    expect(snap.byNip.size).toBe(0);
  });

  it('serves the stale snapshot on refresh failure after a prior success', async () => {
    let call = 0;
    const api = jest.fn(() => ({
      get: jest.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            value: [activeRow('1', { ClientId: '0001' })],
          });
        }
        return Promise.reject(new Error('graph unavailable'));
      }),
    }));
    const client = { api } as unknown as Client;
    let now = 1_000_000;
    const reader = new ClientDirectoryReader(client, {
      siteId: 's',
      listId: 'l',
      cacheTtlMs: 1_000,
      now: () => now,
    });

    const first = await reader.getSnapshot();
    expect(first.entries).toHaveLength(1);

    now += 5_000; // force refresh
    const second = await reader.getSnapshot();
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].clientId).toBe('0001');
  });
});
