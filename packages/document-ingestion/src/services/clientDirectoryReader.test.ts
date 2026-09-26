import type { Client } from '@microsoft/microsoft-graph-client';
import type { ClientDirectoryEntry } from '@bcr/shared';
import {
  boundClientRows,
  buildSnapshot,
  ClientDirectoryReader,
  normalizeAadId,
  normalizeNip,
  siteKey,
  toEntry,
  type ClientDirectoryReaderOptions,
  type ClientDirectorySnapshot,
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

  it('stores the canonical site path, so the path checked is the path requested', () => {
    const entry = toEntry({
      id: '1',
      fields: { ClientId: '0001', SiteHostname: HOST, SitePath: ' //sites//Client-0001/ ' },
    });
    expect(entry!.target.sitePath).toBe('/sites/Client-0001');
  });

  it('keeps a non-canonical site path as typed (buildSnapshot excludes the row)', () => {
    const entry = toEntry({
      id: '1',
      fields: { ClientId: '0001', SiteHostname: HOST, SitePath: '/sites/Client-0001/sub' },
    });
    expect(entry!.target.sitePath).toBe('/sites/Client-0001/sub');
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

  it('keys a site by host and path only: case, slashes, drive and folder do not matter', () => {
    const a = siteKey({
      siteHostname: 'Contoso.SharePoint.com',
      sitePath: '//sites/ClientA/',
      driveName: 'Dokumenty',
      rootFolder: 'Dokumenty księgowe',
    });
    const b = siteKey({ siteHostname: HOST, sitePath: 'sites/clienta', driveName: 'Documents' });
    expect(a).toBe(`${HOST}/sites/clienta`);
    expect(b).toBe(a);
    expect(siteKey({ siteHostname: HOST, sitePath: '/sites/../x', driveName: 'Documents' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot: the routing rules
// ---------------------------------------------------------------------------

/** A client row as the binding tool leaves it: RootFolder, DriveId and TeamId all set. */
function row(overrides: Partial<ClientDirectoryEntry> & { listItemId: string }): ClientDirectoryEntry {
  const id = overrides.listItemId;
  return {
    title: `Client ${id}`,
    clientId: `00${id}`,
    nip: '',
    companyNameAliases: [],
    userAadObjectIds: [],
    target: {
      siteHostname: HOST,
      sitePath: `/sites/Client-${id}`,
      driveName: 'Dokumenty',
      rootFolder: 'Dokumenty księgowe',
      expectedDriveId: `b!drive-${id}`,
    },
    teamId: `team-${id}`,
    isAdmin: false,
    active: true,
    ...overrides,
  };
}

/** The same row without a TeamId, as a row the binding tool has not bound yet. */
function withoutTeamId(r: ClientDirectoryEntry): ClientDirectoryEntry {
  return (({ teamId: _teamId, ...rest }) => rest)(r);
}

/** The same row with its target's path replaced. */
function onPath(r: ClientDirectoryEntry, sitePath: string): ClientDirectoryEntry {
  return { ...r, target: { ...r.target, sitePath } };
}

/** Everything a snapshot decides, in a form two snapshots can be compared by. */
function decisions(snapshot: ClientDirectorySnapshot) {
  return {
    routed: [...snapshot.byUserAadObjectId].map(([k, v]) => `${k}->${v.listItemId}`).sort(),
    conflicted: [...snapshot.conflictedUserIds].sort(),
    forbidden: [...snapshot.forbiddenUserIds].sort(),
    unbound: [...snapshot.unboundUserIds].sort(),
    staff: [...snapshot.staffUserIds].sort(),
    excluded: [...snapshot.excludedRows].map(([k, v]) => `${k}:${v}`).sort(),
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

  it('treats two rows on the same site as a conflict even with different folders or drives', () => {
    const { snapshot } = build([
      row({
        listItemId: '1',
        target: { siteHostname: HOST, sitePath: '/sites/Shared', driveName: 'Dokumenty', rootFolder: 'A' },
        userAadObjectIds: [OID_1],
      }),
      row({
        listItemId: '2',
        target: { siteHostname: HOST, sitePath: '/sites//shared', driveName: 'Documents', rootFolder: 'B' },
        userAadObjectIds: [OID_2],
      }),
    ]);
    expect(snapshot.excludedRows.get('1')).toBe('target_conflict');
    expect(snapshot.excludedRows.get('2')).toBe('target_conflict');
    expect(snapshot.byUserAadObjectId.size).toBe(0);
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
    ['BCR GROUP with a doubled slash', { sitePath: '//sites//BCRGROUP' }],
    ['BCR GROUP through a dot segment', { sitePath: '/sites/./BCRGROUP' }],
    ['BCR GROUP through a parent segment', { sitePath: '/sites/x/../BCRGROUP' }],
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
    expect(snapshot.forbiddenUserIds.has(OID_1)).toBe(true);
    expect(snapshot.conflictedUserIds.has(OID_1)).toBe(false);
  });

  it('keeps a user on a forbidden row and a good row out of routing, as a conflict', () => {
    const { snapshot } = build([
      row({ listItemId: '1', userAadObjectIds: [OID_1] }),
      row({
        listItemId: '2',
        userAadObjectIds: [OID_1],
        target: { siteHostname: HOST, sitePath: '/sites/BCRGROUP', driveName: 'Dokumenty' },
      }),
    ]);
    expect(snapshot.byUserAadObjectId.has(OID_1)).toBe(false);
    expect(snapshot.conflictedUserIds.has(OID_1)).toBe(true);
  });

  it('excludes a row on a sub-site of a forbidden site', () => {
    const { snapshot } = build([
      onPath(row({ listItemId: '1', userAadObjectIds: [OID_1] }), '/sites/BCRGROUP/Sub'),
    ]);
    expect(snapshot.excludedRows.get('1')).toBe('forbidden_target');
    expect(snapshot.forbiddenUserIds.has(OID_1)).toBe(true);
  });

  it("excludes a row on a sub-site of another client's site, and leaves that client routing", () => {
    const { snapshot } = build([
      onPath(row({ listItemId: '1', userAadObjectIds: [OID_1] }), '/sites/ClientA'),
      onPath(row({ listItemId: '2', userAadObjectIds: [OID_2] }), '/sites/ClientA/sub'),
    ]);
    expect(snapshot.byUserAadObjectId.get(OID_1)?.listItemId).toBe('1');
    expect(snapshot.excludedRows.get('2')).toBe('forbidden_target');
    expect(snapshot.byUserAadObjectId.has(OID_2)).toBe(false);
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
// Contract C1: the one canonical site path. The same table runs through
// @bcr/shared's canonicalSitePath and tools/lib/bindings.mjs; here it runs
// through the routing rules, so a row is only ever routed by a path that
// names exactly one site collection.
// ---------------------------------------------------------------------------

describe('buildSnapshot and the canonical site path (C1)', () => {
  const CANONICAL: [string, string][] = [
    ['/sites/A', '/sites/A'],
    ['/sites/A/', '/sites/A'],
    ['sites/A', '/sites/A'],
    ['//sites//A', '/sites/A'],
    [' /teams/A ', '/teams/A'],
    ['/sites/0002PESKOVOISp.zo.o.-Ksigowo', '/sites/0002PESKOVOISp.zo.o.-Ksigowo'],
    ['/sites/BCRGROUPSp.zo.o', '/sites/BCRGROUPSp.zo.o'],
  ];
  const NOT_CANONICAL = [
    '/sites/A/x',
    '/sites/A.',
    '/sites/%41',
    '/sites/x\\..\\Q',
    '/sites/ A',
    '/sites/./A',
    '/sites/x/../A',
    '/sites',
    '/A/B',
  ];

  it.each(CANONICAL)('routes a row whose SitePath is %j, requesting %j', (typed, canonical) => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0001',
        SiteHostname: HOST,
        SitePath: typed,
        RootFolder: 'Dokumenty księgowe',
        DriveId: 'b!drive-1',
        TeamId: 'team-1',
        UserAadObjectIds: OID_1,
      },
    })!;
    expect(entry.target.sitePath).toBe(canonical);
    const { snapshot } = build([entry]);
    expect(snapshot.byUserAadObjectId.get(OID_1)?.target.sitePath).toBe(canonical);
  });

  it.each(NOT_CANONICAL)('excludes a row whose SitePath is %j as forbidden_target', (typed) => {
    const entry = toEntry({
      id: '1',
      fields: {
        ClientId: '0001',
        SiteHostname: HOST,
        SitePath: typed,
        RootFolder: 'Dokumenty księgowe',
        DriveId: 'b!drive-1',
        TeamId: 'team-1',
        UserAadObjectIds: OID_1,
      },
    })!;
    const { snapshot } = build([entry]);
    expect(snapshot.excludedRows.get('1')).toBe('forbidden_target');
    expect(snapshot.forbiddenUserIds.has(OID_1)).toBe(true);
    expect(snapshot.byUserAadObjectId.size).toBe(0);
  });

  it('compares a forbidden path in any case', () => {
    const bcrGroup = onPath(row({ listItemId: '1', userAadObjectIds: [OID_1] }), '/SITES/bcrgroup/');
    const { snapshot } = build([bcrGroup]);
    expect(snapshot.excludedRows.get('1')).toBe('forbidden_target');
  });
});

// ---------------------------------------------------------------------------
// Contract C4: a shared DriveId or TeamId is a target conflict, whatever the
// spelling of each row's path.
// ---------------------------------------------------------------------------

describe('buildSnapshot target conflicts on DriveId and TeamId (C4)', () => {
  type Edit = (r: ClientDirectoryEntry) => ClientDirectoryEntry;
  const driveId =
    (id: string): Edit =>
    (r) => ({ ...r, target: { ...r.target, expectedDriveId: id } });
  const teamId =
    (id: string): Edit =>
    (r) => ({ ...r, teamId: id });

  it.each([
    ['DriveId', driveId('b!SHARED'), driveId('b!shared')],
    ['TeamId', teamId('TEAM-SHARED'), teamId(' team-shared ')],
  ])('excludes both rows that share a %s (case-insensitive), on different sites', (_label, first, second) => {
    const { snapshot, conflicts } = build([
      first(row({ listItemId: '1', userAadObjectIds: [OID_1] })),
      second(row({ listItemId: '2', userAadObjectIds: [OID_2] })),
      row({ listItemId: '3', userAadObjectIds: [] }),
    ]);
    expect(snapshot.excludedRows.get('1')).toBe('target_conflict');
    expect(snapshot.excludedRows.get('2')).toBe('target_conflict');
    expect(snapshot.excludedRows.has('3')).toBe(false);
    expect(snapshot.byUserAadObjectId.size).toBe(0);
    expect([...snapshot.conflictedUserIds].sort()).toEqual([OID_1, OID_2].sort());
    expect(conflicts).toEqual([{ kind: 'target', listItemIds: ['1', '2'] }]);
  });

  it('reports rows sharing a site, a drive and a Team as one conflict', () => {
    const shared = row({ listItemId: '1', userAadObjectIds: [OID_1] });
    const { snapshot, conflicts } = build([
      shared,
      { ...shared, listItemId: '2', clientId: '0099', userAadObjectIds: [OID_2] },
    ]);
    expect(snapshot.byUserAadObjectId.size).toBe(0);
    expect(conflicts.filter((c) => c.kind === 'target')).toEqual([
      { kind: 'target', listItemIds: ['1', '2'] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Contract C3: a row the binding tool has not bound routes nobody.
// ---------------------------------------------------------------------------

describe('buildSnapshot unbound rows (C3)', () => {
  const bound = row({ listItemId: '1', userAadObjectIds: [OID_1] });

  const unboundTarget = { siteHostname: HOST, sitePath: '/sites/Client-1', driveName: 'Dokumenty' };

  it.each([
    ['RootFolder', { ...bound, target: { ...unboundTarget, expectedDriveId: 'b!drive-1' } }],
    ['DriveId', { ...bound, target: { ...unboundTarget, rootFolder: 'Dokumenty księgowe' } }],
    ['TeamId', withoutTeamId(bound)],
  ])('quarantines the users of a row without %s as unbound_target', (_missing, unboundRow) => {
    const { snapshot } = build([unboundRow]);
    expect(snapshot.excludedRows.get('1')).toBe('unbound_target');
    expect(snapshot.unboundUserIds.has(OID_1)).toBe(true);
    expect(snapshot.byUserAadObjectId.has(OID_1)).toBe(false);
    expect(snapshot.conflictedUserIds.has(OID_1)).toBe(false);
  });

  it('routes a fully bound row', () => {
    const { snapshot } = build([bound]);
    expect(snapshot.byUserAadObjectId.get(OID_1)?.listItemId).toBe('1');
    expect(snapshot.excludedRows.size).toBe(0);
  });

  it('does not ask a staff row for a binding', () => {
    const { snapshot } = build([
      row({
        listItemId: '9',
        isAdmin: true,
        userAadObjectIds: [OID_1],
        target: { siteHostname: '', sitePath: '', driveName: 'Documents' },
      }),
    ]);
    expect(snapshot.staffUserIds.has(OID_1)).toBe(true);
    expect(snapshot.excludedRows.size).toBe(0);
  });

  it('closes the reused-guest window: a guest bound to A and written onto new row B routes nowhere', () => {
    // Row B as onboarding writes it: B's own site, no RootFolder/DriveId/TeamId yet.
    const rowB = row({
      listItemId: '2',
      userAadObjectIds: [OID_1],
      target: { siteHostname: HOST, sitePath: '/sites/Client-2', driveName: 'Dokumenty' },
    });
    const { snapshot } = build([bound, withoutTeamId(rowB)]);
    expect(snapshot.byUserAadObjectId.has(OID_1)).toBe(false);
    expect(snapshot.conflictedUserIds.has(OID_1)).toBe(true);
    expect(snapshot.excludedRows.get('2')).toBe('unbound_target');
  });

  it('still counts an unbound row on a bound row\'s site as a target conflict', () => {
    const { snapshot } = build([
      bound,
      { ...onPath(row({ listItemId: '2', userAadObjectIds: [OID_2] }), '/sites/Client-1'), teamId: '' },
    ]);
    expect(snapshot.excludedRows.get('1')).toBe('target_conflict');
    expect(snapshot.excludedRows.get('2')).toBe('target_conflict');
    expect(snapshot.byUserAadObjectId.size).toBe(0);
  });

  it('gives identical decisions for every row order with forbidden, unbound and conflicting rows', () => {
    const OID_3 = '22222222-2222-2222-2222-222222222222';
    const OID_4 = '33333333-3333-3333-3333-333333333333';
    const rows = [
      row({ listItemId: '1', userAadObjectIds: [OID_1] }),
      { ...row({ listItemId: '2', userAadObjectIds: [OID_2] }), teamId: 'team-1' },
      onPath(row({ listItemId: '3', userAadObjectIds: [OID_3] }), '/sites/BCRGROUP/x'),
      withoutTeamId(row({ listItemId: '4', userAadObjectIds: [OID_4] })),
    ];
    const outcomes = permutations(rows).map((order) => JSON.stringify(decisions(build(order).snapshot)));
    expect(new Set(outcomes).size).toBe(1);
    expect(decisions(build(rows).snapshot)).toEqual({
      routed: [],
      conflicted: [OID_1, OID_2].sort(),
      forbidden: [OID_3],
      unbound: [OID_4],
      staff: [],
      excluded: ['1:target_conflict', '2:target_conflict', '3:forbidden_target', '4:unbound_target'],
    });
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
    RootFolder: 'Dokumenty księgowe',
    DriveId: `b!drive-${id}`,
    TeamId: `team-${id}`,
    ...fields,
  },
});

describe('boundClientRows (the rows the channel inbox sweeps)', () => {
  it('keeps active, bound, routed client rows, with or without user ids, in list item order', () => {
    const { snapshot } = build([
      row({ listItemId: '10', userAadObjectIds: [OID_1] }),
      row({ listItemId: '9' }),
      row({ listItemId: '100' }),
    ]);
    expect(boundClientRows(snapshot).map((r) => r.listItemId)).toEqual(['9', '10', '100']);
  });

  it('drops admin, inactive, unbound, forbidden and conflicting rows', () => {
    const { snapshot } = build([
      row({ listItemId: '1' }),
      row({ listItemId: '2', isAdmin: true }),
      row({ listItemId: '3', active: false }),
      withoutTeamId(row({ listItemId: '4' })),
      onPath(row({ listItemId: '5' }), '/sites/BCRGROUP'),
      onPath(row({ listItemId: '6' }), '/sites/Kwarantanna'),
      row({ listItemId: '7', target: { ...row({ listItemId: '7' }).target, siteHostname: 'evil.sharepoint.com' } }),
      onPath(row({ listItemId: '8' }), '/sites/Shared'),
      onPath(row({ listItemId: '9' }), '/sites/Shared'),
    ]);
    expect(boundClientRows(snapshot).map((r) => r.listItemId)).toEqual(['1']);
  });

  it('has no rows on an unavailable snapshot', () => {
    const { snapshot } = build([row({ listItemId: '1' })]);
    expect(boundClientRows({ ...snapshot, health: 'unavailable' })).toEqual([]);
  });
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
