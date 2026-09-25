import type { Client } from '@microsoft/microsoft-graph-client';
import type { ClientDirectoryEntry } from '@bcr/shared';
import {
  buildSnapshot,
  ClientDirectoryReader,
  normalizeAadId,
  normalizeNip,
  normalizeTarget,
  toEntry,
  type ClientDirectoryReaderOptions,
  type ConflictKind,
} from './clientDirectoryReader';

const HOST = 'contoso.sharepoint.com';
const OID_1 = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';
const OID_2 = '11111111-1111-1111-1111-111111111111';

describe('toEntry', () => {
  it('parses a full directory row', () => {
    const entry = toEntry({
      id: '42',
      fields: {
        Title: '[0002] Client Sp. z o. o. - Księgowość',
        ClientId: '0002',
        NIP: '  123-456-78-90 ',
        CompanyNameAliases: 'Client Sp. z o.o.\nClient\n\n  Client Group  ',
        SiteHostname: HOST,
        SitePath: '/sites/Client-0002',
        DriveName: 'Dokumenty',
        RootFolder: 'Dokumenty księgowe',
        DriveId: 'b!drive-0002',
        TeamId: 'team-0002',
        IsAdmin: false,
        Status: 'Active',
      },
    });
    expect(entry).toEqual({
      listItemId: '42',
      title: '[0002] Client Sp. z o. o. - Księgowość',
      clientId: '0002',
      nip: '1234567890',
      companyNameAliases: ['Client Sp. z o.o.', 'Client', 'Client Group'],
      userAadObjectIds: [],
      target: {
        siteHostname: HOST,
        sitePath: '/sites/Client-0002',
        driveName: 'Dokumenty',
        rootFolder: 'Dokumenty księgowe',
        expectedDriveId: 'b!drive-0002',
      },
      teamId: 'team-0002',
      isAdmin: false,
      active: true,
    });
  });

  it('defaults drive to `Documents` and omits optional target fields when blank', () => {
    const entry = toEntry({
      id: '1',
      fields: { ClientId: '0001', SiteHostname: HOST, SitePath: '/sites/x', RootFolder: '  ' },
    });
    expect(entry!.target).toEqual({ siteHostname: HOST, sitePath: '/sites/x', driveName: 'Documents' });
    expect(entry).not.toHaveProperty('teamId');
  });

  it('treats missing Status as active and Inactive as inactive', () => {
    const base = { ClientId: '0001', SiteHostname: HOST, SitePath: '/sites/x' };
    expect(toEntry({ id: '1', fields: base })!.active).toBe(true);
    expect(toEntry({ id: '1', fields: { ...base, Status: 'Inactive' } })!.active).toBe(false);
  });

  it('rejects a row missing ClientId, and a non-admin row missing a target', () => {
    expect(toEntry({ id: '1', fields: { Title: 'x', SiteHostname: 'a', SitePath: '/sites/x' } })).toBeNull();
    expect(toEntry({ id: '1', fields: { ClientId: '0001', IsAdmin: false } })).toBeNull();
  });

  it('accepts an admin row without a SharePoint target', () => {
    const entry = toEntry({ id: '1', fields: { ClientId: 'admin', Title: 'Staff', IsAdmin: true } });
    expect(entry!.isAdmin).toBe(true);
  });

  it('parses multi-line UserAadObjectIds and drops invalid entries', () => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0002',
        SiteHostname: HOST,
        SitePath: '/sites/x',
        UserAadObjectIds: `${OID_1.toUpperCase()}\nnot-a-guid\n  ${OID_2}  `,
      },
    });
    expect(entry!.userAadObjectIds).toEqual([OID_1, OID_2]);
  });
});

describe('normalizers', () => {
  it('strips everything but digits from NIP', () => {
    expect(normalizeNip('PL 123-456-78-90')).toBe('1234567890');
    expect(normalizeNip('N/A')).toBe('');
  });

  it('normalizes AAD ids and rejects non-GUIDs', () => {
    expect(normalizeAadId(`  ${OID_1.toUpperCase()}\n`)).toBe(OID_1);
    expect(normalizeAadId('user@example.com')).toBe('');
  });

  it('treats targets differing only in case, slashes and whitespace as the same place', () => {
    expect(
      normalizeTarget({
        siteHostname: 'Contoso.SharePoint.com',
        sitePath: '/sites/ClientA/',
        driveName: 'Dokumenty',
        rootFolder: '/Dokumenty księgowe/',
      }),
    ).toBe(
      normalizeTarget({
        siteHostname: HOST,
        sitePath: 'sites/clienta',
        driveName: 'dokumenty',
        rootFolder: 'Dokumenty księgowe',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot: the routing rules
// ---------------------------------------------------------------------------

function row(overrides: Partial<ClientDirectoryEntry> & { listItemId: string }): ClientDirectoryEntry {
  return {
    title: `Client ${overrides.listItemId}`,
    clientId: `00${overrides.listItemId}`,
    nip: '',
    companyNameAliases: [],
    userAadObjectIds: [],
    target: { siteHostname: HOST, sitePath: `/sites/Client-${overrides.listItemId}`, driveName: 'Dokumenty' },
    isAdmin: false,
    active: true,
    ...overrides,
  };
}

const snapshotOptions = {
  forbiddenSitePaths: ['/sites/BCRGROUP', '/sites/Kwarantanna'],
  allowedSiteHostname: HOST,
};

function build(entries: ClientDirectoryEntry[]) {
  const conflicts: { kind: ConflictKind; listItemIds: readonly string[] }[] = [];
  const snapshot = buildSnapshot(entries, 0, {
    ...snapshotOptions,
    onConflict: (kind, listItemIds) => conflicts.push({ kind, listItemIds }),
  });
  return { snapshot, conflicts };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('buildSnapshot', () => {
  it('routes a user id that sits on exactly one client row', () => {
    const { snapshot } = build([row({ listItemId: '1', userAadObjectIds: [OID_1] })]);
    expect(snapshot.byUserAadObjectId.get(OID_1)?.listItemId).toBe('1');
    expect(snapshot.health).toBe('fresh');
  });

  it.each([2, 3, 4, 5])(
    'routes a user id shared by %i client rows nowhere (the third row no longer wins)',
    (count) => {
      const rows = Array.from({ length: count }, (_, i) =>
        row({ listItemId: String(i + 1), userAadObjectIds: [OID_1] }),
      );
      const { snapshot, conflicts } = build(rows);
      expect(snapshot.byUserAadObjectId.has(OID_1)).toBe(false);
      expect(snapshot.conflictedUserIds.has(OID_1)).toBe(true);
      expect(conflicts).toContainEqual({
        kind: 'userAadObjectId',
        listItemIds: rows.map((r) => r.listItemId),
      });
    },
  );

  it('gives identical routing for every row order (A,B,A and A,B,B included)', () => {
    const rows = [
      row({ listItemId: '1', userAadObjectIds: [OID_1, OID_2] }),
      row({ listItemId: '2', userAadObjectIds: [OID_1] }),
      row({ listItemId: '3', userAadObjectIds: [OID_1] }),
      row({ listItemId: '4', userAadObjectIds: [] }),
    ];
    const outcomes = permutations(rows).map((order) => {
      const { snapshot } = build(order);
      return {
        routed: [...snapshot.byUserAadObjectId].map(([k, v]) => `${k}->${v.listItemId}`).sort(),
        conflicted: [...snapshot.conflictedUserIds].sort(),
      };
    });
    const offenders = outcomes.filter((o) => JSON.stringify(o) !== JSON.stringify(outcomes[0]));
    expect(offenders).toEqual([]);
    expect(outcomes[0]).toEqual({ routed: [`${OID_2}->1`], conflicted: [OID_1] });
  });

  it('treats a user id on a client row and an admin row as a conflict, not a client', () => {
    const { snapshot } = build([
      row({ listItemId: '1', userAadObjectIds: [OID_1] }),
      row({ listItemId: '9', isAdmin: true, userAadObjectIds: [OID_1] }),
    ]);
    expect(snapshot.byUserAadObjectId.has(OID_1)).toBe(false);
    expect(snapshot.staffUserIds.has(OID_1)).toBe(false);
    expect(snapshot.conflictedUserIds.has(OID_1)).toBe(true);
  });

  it('marks a user id found only on an admin row as staff', () => {
    const { snapshot } = build([row({ listItemId: '9', isAdmin: true, userAadObjectIds: [OID_1] })]);
    expect(snapshot.staffUserIds.has(OID_1)).toBe(true);
    expect(snapshot.byUserAadObjectId.size).toBe(0);
  });

  it('counts a user id listed twice on the same row once', () => {
    const { snapshot } = build([row({ listItemId: '1', userAadObjectIds: [OID_1, OID_1] })]);
    expect(snapshot.byUserAadObjectId.get(OID_1)?.listItemId).toBe('1');
  });

  it('excludes every row that shares a target, and their users become conflicts', () => {
    const shared = { siteHostname: HOST, sitePath: '/sites/Shared', driveName: 'Dokumenty' };
    const { snapshot, conflicts } = build([
      row({ listItemId: '1', target: shared, userAadObjectIds: [OID_1] }),
      row({ listItemId: '2', target: { ...shared, sitePath: '/SITES/shared/' }, userAadObjectIds: [OID_2] }),
      row({ listItemId: '3', userAadObjectIds: [] }),
    ]);
    expect(snapshot.excludedRows.get('1')).toBe('target_conflict');
    expect(snapshot.excludedRows.get('2')).toBe('target_conflict');
    expect(snapshot.excludedRows.has('3')).toBe(false);
    expect(snapshot.byUserAadObjectId.size).toBe(0);
    expect([...snapshot.conflictedUserIds].sort()).toEqual([OID_2, OID_1].sort());
    expect(conflicts.map((c) => c.kind)).toContain('target');
  });

  it.each([
    ['BCR GROUP', { sitePath: '/sites/BCRGROUP' }],
    ['the quarantine site', { sitePath: '/sites/kwarantanna/' }],
    ['another SharePoint host', { siteHostname: 'evil.sharepoint.com' }],
  ])('excludes a row pointing at %s', (_label, targetOverride) => {
    const { snapshot } = build([
      row({
        listItemId: '1',
        userAadObjectIds: [OID_1],
        target: { siteHostname: HOST, sitePath: '/sites/x', driveName: 'Dokumenty', ...targetOverride },
      }),
    ]);
    expect(snapshot.excludedRows.get('1')).toBe('forbidden_target');
    expect(snapshot.byUserAadObjectId.has(OID_1)).toBe(false);
    expect(snapshot.conflictedUserIds.has(OID_1)).toBe(true);
  });

  it('only alerts on a shared NIP or ClientId — neither routes anything', () => {
    const { snapshot, conflicts } = build([
      row({ listItemId: '1', clientId: '0002', nip: '1234567890', userAadObjectIds: [OID_1] }),
      row({ listItemId: '2', clientId: '0002', nip: '1234567890', userAadObjectIds: [OID_2] }),
    ]);
    expect(snapshot.byUserAadObjectId.get(OID_1)?.listItemId).toBe('1');
    expect(snapshot.byUserAadObjectId.get(OID_2)?.listItemId).toBe('2');
    expect(conflicts.map((c) => c.kind).sort()).toEqual(['clientId', 'nip']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end reader behaviour (paging, TTL cache, stale cap, backoff)
// ---------------------------------------------------------------------------

function makeGraph(responses: (unknown | Error)[]): { client: Client; api: jest.Mock } {
  const api = jest.fn(() => ({
    get: jest.fn().mockImplementation(() => {
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
  }));
  return { client: { api } as unknown as Client, api };
}

const activeRow = (id: string, fields: Record<string, unknown>) => ({
  id,
  fields: {
    Status: 'Active',
    SiteHostname: HOST,
    SitePath: `/sites/Client-${id}`,
    DriveName: 'Documents',
    ...fields,
  },
});

function readerOptions(overrides: Partial<ClientDirectoryReaderOptions> = {}): ClientDirectoryReaderOptions {
  return {
    siteId: 'site',
    listId: 'list',
    cacheTtlMs: 60_000,
    maxStaleMs: 900_000,
    ...snapshotOptions,
    ...overrides,
  };
}

describe('ClientDirectoryReader', () => {
  it('follows @odata.nextLink until exhausted and drops inactive rows', async () => {
    const { client, api } = makeGraph([
      {
        value: [activeRow('1', { ClientId: '0001', UserAadObjectIds: OID_1 })],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
      },
      { value: [activeRow('2', { ClientId: '0002', Status: 'Inactive' })] },
    ]);
    const snap = await new ClientDirectoryReader(client, readerOptions()).getSnapshot();
    expect(api).toHaveBeenCalledTimes(2);
    expect(snap.entries.map((e) => e.clientId)).toEqual(['0001']);
    expect(snap.byUserAadObjectId.get(OID_1)?.clientId).toBe('0001');
  });

  it('caches the snapshot within TTL', async () => {
    const page = { value: [activeRow('1', { ClientId: '0001' })] };
    const { client, api } = makeGraph([page, page]);
    let now = 1_000_000;
    const reader = new ClientDirectoryReader(client, readerOptions({ cacheTtlMs: 5_000, now: () => now }));
    await reader.getSnapshot();
    now += 4_999;
    await reader.getSnapshot();
    expect(api).toHaveBeenCalledTimes(1);
    now += 2;
    await reader.getSnapshot();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('returns an unavailable snapshot when the first fetch fails', async () => {
    const { client } = makeGraph([new Error('boom')]);
    const snap = await new ClientDirectoryReader(client, readerOptions()).getSnapshot();
    expect(snap.health).toBe('unavailable');
    expect(snap.byUserAadObjectId.size).toBe(0);
  });

  it('serves the last good snapshot while it is younger than maxStaleMs, then stops routing', async () => {
    const good = { value: [activeRow('1', { ClientId: '0001', UserAadObjectIds: OID_1 })] };
    const { client } = makeGraph([good, new Error('down'), new Error('down'), new Error('down')]);
    let now = 1_000_000;
    const reader = new ClientDirectoryReader(
      client,
      readerOptions({ cacheTtlMs: 1_000, maxStaleMs: 10_000, retryBackoffMs: 0, now: () => now }),
    );

    expect((await reader.getSnapshot()).health).toBe('fresh');

    now += 5_000; // refresh fails, snapshot 5 s old: still used
    const stale = await reader.getSnapshot();
    expect(stale.health).toBe('fresh');
    expect(stale.byUserAadObjectId.has(OID_1)).toBe(true);

    now += 6_000; // 11 s old: past the cap
    const expired = await reader.getSnapshot();
    expect(expired.health).toBe('unavailable');
    expect(expired.byUserAadObjectId.size).toBe(0);
  });

  it('does not hammer Graph while refreshes keep failing', async () => {
    const { client, api } = makeGraph([new Error('throttled'), new Error('throttled')]);
    let now = 1_000_000;
    const reader = new ClientDirectoryReader(
      client,
      readerOptions({ retryBackoffMs: 30_000, now: () => now }),
    );
    await reader.getSnapshot();
    now += 1_000;
    await reader.getSnapshot();
    await reader.getSnapshot();
    expect(api).toHaveBeenCalledTimes(1);
    now += 30_000;
    await reader.getSnapshot();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    const page = { value: [activeRow('1', { ClientId: '0001' })] };
    const { client, api } = makeGraph([page]);
    const reader = new ClientDirectoryReader(client, readerOptions());
    await Promise.all([reader.getSnapshot(), reader.getSnapshot(), reader.getSnapshot()]);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
