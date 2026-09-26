import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  Classification,
  ClientDirectoryEntry,
  DocumentParty,
  IngestionSource,
  Logger,
  SharePointTarget,
} from '@bcr/shared';
import {
  buildSnapshot,
  type ClientDirectoryReader,
  type ClientDirectorySnapshot,
} from './clientDirectoryReader';
import { applyInvoiceDirection, ClientResolver } from './clientResolver';
import {
  TeamMembershipReadError,
  TeamMembershipReader,
  type MembershipCheck,
  type TeamMembershipSource,
} from './teamMembership';

const HOST = 'contoso.sharepoint.com';

const quarantineTarget: SharePointTarget = {
  siteHostname: HOST,
  sitePath: '/sites/BCRLedgerKwarantanna',
  driveName: 'Dokumenty',
  rootFolder: 'Kwarantanna',
};

const OID_A = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';
const OID_B = '0b8c7a2e-51f4-4a7e-9d3e-2f1c6a9b8d70';
const OID_STAFF = '5f0d2c11-7c3e-4b2a-8e61-9a4d3b2c1e0f';

/** A client row as the binding tool leaves it: RootFolder, DriveId and TeamId all set. */
function makeEntry(overrides: Partial<ClientDirectoryEntry>): ClientDirectoryEntry {
  return {
    listItemId: '1',
    title: 'Client',
    clientId: '0001',
    nip: '',
    companyNameAliases: [],
    userAadObjectIds: [],
    target: {
      siteHostname: HOST,
      sitePath: '/sites/Client-0001',
      driveName: 'Dokumenty',
      rootFolder: 'Dokumenty księgowe',
      expectedDriveId: 'b!drive-0001',
    },
    teamId: 'team-0001',
    isAdmin: false,
    active: true,
    ...overrides,
  };
}

/** A target as the binding tool leaves it. */
function boundTarget(sitePath: string, id: string): SharePointTarget {
  return {
    siteHostname: HOST,
    sitePath,
    driveName: 'Dokumenty',
    rootFolder: 'Dokumenty księgowe',
    expectedDriveId: `b!drive-${id}`,
  };
}

/** A logger that records every call, so tests can assert what reaches the logs. */
function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const write = (obj: unknown, msg?: string) =>
    lines.push({ ...(typeof obj === 'object' && obj ? obj : { msg: obj }), msg });
  const log = { info: write, warn: write, error: write, debug: write } as unknown as Logger;
  return { log, lines };
}

/** Uses the real snapshot builder, so resolver tests exercise real routing rules. */
function makeReader(entries: ClientDirectoryEntry[]): ClientDirectoryReader {
  const snapshot = buildSnapshot(entries, 0, {
    forbiddenSitePaths: ['/sites/BCRGROUP', quarantineTarget.sitePath],
    allowedSiteHostname: HOST,
  });
  return readerFor(snapshot);
}

function readerFor(snapshot: ClientDirectorySnapshot): ClientDirectoryReader {
  return { getSnapshot: jest.fn().mockResolvedValue(snapshot) } as unknown as ClientDirectoryReader;
}

const clientA = makeEntry({
  listItemId: '11',
  clientId: '0002',
  title: '[0002] Client A',
  nip: '1111111111',
  companyNameAliases: ['Client A Sp. z o.o.'],
  userAadObjectIds: [OID_A],
  target: boundTarget('/sites/ClientA', '0002'),
  teamId: 'team-0002',
});

const clientB = makeEntry({
  listItemId: '12',
  clientId: '0003',
  title: '[0003] Client B',
  nip: '2222222222',
  companyNameAliases: ['Client B Sp. z o.o.'],
  userAadObjectIds: [OID_B],
  target: boundTarget('/sites/ClientB', '0003'),
  teamId: 'team-0003',
});

const staffRow = makeEntry({
  listItemId: '99',
  clientId: 'bcr-admin',
  title: 'BCR staff',
  isAdmin: true,
  userAadObjectIds: [OID_STAFF],
  target: { siteHostname: '', sitePath: '', driveName: 'Documents' },
});

/**
 * Every client user is in exactly their row's Team: the state the binding
 * tool leaves. Tests about membership itself build their own source.
 */
const TEAMS_OF: Readonly<Record<string, readonly string[]>> = {
  [OID_A]: ['team-0002'],
  [OID_B]: ['team-0003'],
};
const inOwnTeam: TeamMembershipSource = {
  teamsOf: async (oid) => new Set(TEAMS_OF[oid] ?? []),
};
const enforce: MembershipCheck = { mode: 'enforce', source: inOwnTeam };

const baseSource: IngestionSource = {
  tenantId: 'tenant-1',
  channelId: 'msteams',
  conversationId: 'conv-1',
  activityId: 'act-1',
  conversationType: 'personal',
  teamsChannelId: undefined,
  userAadObjectId: undefined,
  userDisplayName: undefined,
};

describe('ClientResolver.resolve', () => {
  const resolver = new ClientResolver(makeReader([clientA, clientB, staffRow]), {
    quarantineTarget,
    membership: enforce,
  });

  it('routes a bound guest to their own client', async () => {
    const resolved = await resolver.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toEqual({
      source: 'directory',
      clientId: '0002',
      listItemId: '11',
      title: '[0002] Client A',
      matchedBy: 'userAadObjectId',
      target: clientA.target,
      teamId: 'team-0002',
      nip: '1111111111',
      companyName: 'Client A Sp. z o.o.',
    });
  });

  it('logs the routing decision with ids only — the Team id included', async () => {
    const { log, lines } = recordingLogger();
    const r = new ClientResolver(makeReader([clientA]), { quarantineTarget, membership: enforce, log });
    await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(lines).toEqual([
      {
        clientId: '0002',
        listItemId: '11',
        teamId: 'team-0002',
        membership: 'verified',
        msg: 'routed to client via userAadObjectId',
      },
    ]);
  });

  it('matches the user id case-insensitively', async () => {
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: OID_A.toUpperCase(),
    });
    expect(resolved.source).toBe('directory');
  });

  it.each([
    ['no user id', undefined],
    ['an unknown user id', '9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6'],
  ])('quarantines %s as unmapped — never BCR GROUP, never another client', async (_label, oid) => {
    const resolved = await resolver.resolve({ ...baseSource, userAadObjectId: oid });
    expect(resolved).toEqual({ source: 'quarantine', reason: 'unmapped', target: quarantineTarget });
  });

  it('quarantines BCR staff as staff (they pick the client explicitly in a later phase)', async () => {
    const resolved = await resolver.resolve({ ...baseSource, userAadObjectId: OID_STAFF });
    expect(resolved).toEqual({ source: 'quarantine', reason: 'staff', target: quarantineTarget });
  });

  it('quarantines a user id that sits on a client row and an admin row as conflict', async () => {
    const r = new ClientResolver(
      makeReader([clientA, { ...staffRow, userAadObjectIds: [OID_A] }]),
      { quarantineTarget, membership: enforce },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'conflict' });
  });

  it('quarantines a user whose only row points at BCR GROUP as forbidden_target', async () => {
    const r = new ClientResolver(
      makeReader([{ ...clientA, target: { ...clientA.target, sitePath: '/sites/x/../BCRGROUP' } }]),
      { quarantineTarget, membership: enforce },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toEqual({ source: 'quarantine', reason: 'forbidden_target', target: quarantineTarget });
  });

  it('quarantines everything when the directory is unavailable', async () => {
    const unavailable: ClientDirectorySnapshot = {
      entries: [],
      byUserAadObjectId: new Map(),
      staffUserIds: new Set(),
      conflictedUserIds: new Set(),
      forbiddenUserIds: new Set(),
      unboundUserIds: new Set(),
      excludedRows: new Map(),
      health: 'unavailable',
      fetchedAt: 0,
    };
    const r = new ClientResolver(readerFor(unavailable), { quarantineTarget, membership: enforce });
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'stale_directory' });
  });

  // Contract C3: a row the binding tool has not bound routes nobody — it
  // would file into the library root, for a guest nobody checked is in this
  // client's Team only.
  it.each([
    ['RootFolder', { target: { ...clientA.target, rootFolder: '' } }],
    ['DriveId', { target: { ...clientA.target, expectedDriveId: '' } }],
    ['TeamId', { teamId: '' }],
  ])('quarantines a user whose only row lacks %s as unbound_target', async (_missing, override) => {
    const r = new ClientResolver(makeReader([{ ...clientA, ...override }, clientB]), { quarantineTarget, membership: enforce });
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toEqual({ source: 'quarantine', reason: 'unbound_target', target: quarantineTarget });
    const other = await r.resolve({ ...baseSource, userAadObjectId: OID_B });
    expect(other).toMatchObject({ source: 'directory', clientId: '0003' });
  });

  it('refuses an unbound row even if a snapshot were to route it', async () => {
    const unbound = (({ teamId: _teamId, ...rest }) => rest)(clientA);
    const snapshot: ClientDirectorySnapshot = {
      entries: [unbound],
      byUserAadObjectId: new Map([[OID_A, unbound]]),
      staffUserIds: new Set(),
      conflictedUserIds: new Set(),
      forbiddenUserIds: new Set(),
      unboundUserIds: new Set(),
      excludedRows: new Map(),
      health: 'fresh',
      fetchedAt: 0,
    };
    const r = new ClientResolver(readerFor(snapshot), { quarantineTarget, membership: enforce });
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'unbound_target' });
  });

  it('quarantines both users of rows that share a DriveId as conflict', async () => {
    const r = new ClientResolver(
      makeReader([clientA, { ...clientB, target: { ...clientB.target, expectedDriveId: 'b!drive-0002' } }]),
      { quarantineTarget, membership: enforce },
    );
    for (const oid of [OID_A, OID_B]) {
      const resolved = await r.resolve({ ...baseSource, userAadObjectId: oid });
      expect(resolved).toMatchObject({ source: 'quarantine', reason: 'conflict' });
    }
  });

  it('quarantines a user whose row names a sub-site as forbidden_target', async () => {
    const r = new ClientResolver(
      makeReader([{ ...clientA, target: { ...clientA.target, sitePath: '/sites/ClientB/sub' } }, clientB]),
      { quarantineTarget, membership: enforce },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'forbidden_target' });
  });

  it('falls back to the title as companyName when no aliases are set', async () => {
    const r = new ClientResolver(
      makeReader([{ ...clientA, companyNameAliases: [] }]),
      { quarantineTarget, membership: enforce },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved.source === 'directory' && resolved.companyName).toBe('[0002] Client A');
  });
});

// ---------------------------------------------------------------------------
// Team membership at upload time (R46): the row's Team, and no other
// ---------------------------------------------------------------------------

describe('ClientResolver.resolve — Team membership', () => {
  /** A membership source that answers from a table, recording who it was asked about. */
  function source(teams: readonly string[] | Error): TeamMembershipSource & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      teamsOf: async (oid) => {
        calls.push(oid);
        if (teams instanceof Error) throw teams;
        return new Set(teams);
      },
    };
  }

  function resolverWith(
    membership: MembershipCheck,
    entries: ClientDirectoryEntry[] = [clientA, clientB, staffRow],
  ) {
    const { log, lines } = recordingLogger();
    const r = new ClientResolver(makeReader(entries), { quarantineTarget, membership, log });
    return { r, lines };
  }

  const uploadBy = (oid: string | undefined) => ({ ...baseSource, userAadObjectId: oid });

  it("routes when the uploader's Teams are exactly the row's Team", async () => {
    const { r } = resolverWith({ mode: 'enforce', source: source(['team-0002']) });
    expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory', clientId: '0002' });
  });

  it('compares Team ids case-insensitively, on both sides', async () => {
    const { r } = resolverWith({ mode: 'enforce', source: source(['TEAM-0002']) }, [
      { ...clientA, teamId: 'Team-0002' },
    ]);
    expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory' });
  });

  it.each([
    ["not in the row's Team", ['team-0099'], false, 1],
    ["in the row's Team and another client's (the R46 guest)", ['team-0002', 'team-0003'], true, 1],
    ["in the row's Team and two others", ['team-0003', 'team-0002', 'team-0099'], true, 2],
    ['in no Team at all', [], false, 0],
  ] as const)(
    'quarantines an uploader %s as membership_mismatch, logging ids and counts only',
    async (_label, teams, inRowTeam, otherTeamCount) => {
      const { r, lines } = resolverWith({ mode: 'enforce', source: source(teams) });
      expect(await r.resolve(uploadBy(OID_A))).toEqual({
        source: 'quarantine',
        reason: 'membership_mismatch',
        target: quarantineTarget,
      });
      expect(lines).toEqual([
        {
          event: 'membership.mismatch',
          clientId: '0002',
          listItemId: '11',
          teamId: 'team-0002',
          teamCount: teams.length,
          inRowTeam,
          otherTeamCount,
          msg: 'membership.mismatch',
        },
      ]);
    },
  );

  it.each([
    ['a missing grant (403)', new TeamMembershipReadError('no', 403), { status: 403 }],
    ['a user Graph does not know (404)', new TeamMembershipReadError('no', 404), { status: 404 }],
    ['Graph down after retries', new TeamMembershipReadError('no', 502), { status: 502 }],
    ['a network failure', new TeamMembershipReadError('no'), {}],
    ['any other error', new Error('boom'), {}],
  ])('quarantines as membership_unverified when the read fails: %s', async (_label, error, extra) => {
    const { r, lines } = resolverWith({ mode: 'enforce', source: source(error) });
    expect(await r.resolve(uploadBy(OID_A))).toEqual({
      source: 'quarantine',
      reason: 'membership_unverified',
      target: quarantineTarget,
    });
    expect(lines).toEqual([
      {
        event: 'membership.unverified',
        clientId: '0002',
        listItemId: '11',
        teamId: 'team-0002',
        ...extra,
        msg: 'membership.unverified',
      },
    ]);
  });

  it.each([
    ['staff', OID_STAFF, 'staff'],
    ['an unmapped user', '9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6', 'unmapped'],
    ['no user id', undefined, 'unmapped'],
  ])('does not read the Teams of %s: they are quarantined already', async (_label, oid, reason) => {
    const teams = source(['team-0002']);
    const { r } = resolverWith({ mode: 'enforce', source: teams });
    expect(await r.resolve(uploadBy(oid))).toMatchObject({ source: 'quarantine', reason });
    expect(teams.calls).toEqual([]);
  });

  it('does not read the Teams of a user whose row is not bound', async () => {
    const teams = source(['team-0002']);
    const { r } = resolverWith({ mode: 'enforce', source: teams }, [{ ...clientA, teamId: '' }]);
    expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ reason: 'unbound_target' });
    expect(teams.calls).toEqual([]);
  });

  it('asks about the uploader, lower-cased', async () => {
    const teams = source(['team-0002']);
    const { r } = resolverWith({ mode: 'enforce', source: teams });
    await r.resolve(uploadBy(OID_A.toUpperCase()));
    expect(teams.calls).toEqual([OID_A]);
  });

  it('with the check off, routes without reading Teams, and says so in the routing log', async () => {
    const { r, lines } = resolverWith({ mode: 'off' });
    expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory', clientId: '0002' });
    expect(lines).toEqual([
      expect.objectContaining({
        membership: 'unchecked',
        msg: 'routed to client via userAadObjectId',
      }),
    ]);
  });

  // End to end through the real reader: its cache decides how soon a new
  // Team shows up, and a failure must never be remembered as a pass.
  describe('through TeamMembershipReader', () => {
    const TEAM_A = '11111111-aaaa-4aaa-8aaa-111111111111';
    const TEAM_B = '22222222-bbbb-4bbb-8bbb-222222222222';
    const teamEntry = (id: string) => ({
      '@odata.type': '#microsoft.graph.group',
      id,
      resourceProvisioningOptions: ['Team'],
    });

    function graphAnswering(answer: () => unknown) {
      let calls = 0;
      const client = {
        api: () => ({
          get: async () => {
            calls += 1;
            return answer();
          },
        }),
      } as unknown as Client;
      return { client, calls: () => calls };
    }

    const rowA = { ...clientA, teamId: TEAM_A };

    it('hit: a second upload within 5 minutes reuses the read', async () => {
      let now = 0;
      const g = graphAnswering(() => ({ value: [teamEntry(TEAM_A)] }));
      const reader = new TeamMembershipReader(g.client, { now: () => now, retry: { retries: 0 } });
      const { r } = resolverWith({ mode: 'enforce', source: reader }, [rowA]);
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory' });
      now += 4 * 60 * 1000;
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory' });
      expect(g.calls()).toBe(1);
    });

    it('expiry: after 5 minutes a newly joined Team is seen, and the upload is held', async () => {
      let now = 0;
      let teams = [teamEntry(TEAM_A)];
      const g = graphAnswering(() => ({ value: teams }));
      const reader = new TeamMembershipReader(g.client, { now: () => now, retry: { retries: 0 } });
      const { r } = resolverWith({ mode: 'enforce', source: reader }, [rowA]);
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory' });
      teams = [teamEntry(TEAM_A), teamEntry(TEAM_B)];
      now += 5 * 60 * 1000;
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ reason: 'membership_mismatch' });
      expect(g.calls()).toBe(2);
    });

    it('miss: another uploader is read separately', async () => {
      const g = graphAnswering(() => ({ value: [teamEntry(TEAM_A)] }));
      const reader = new TeamMembershipReader(g.client, { retry: { retries: 0 } });
      const { r } = resolverWith({ mode: 'enforce', source: reader }, [
        rowA,
        { ...clientB, teamId: TEAM_B },
      ]);
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory' });
      expect(await r.resolve(uploadBy(OID_B))).toMatchObject({ reason: 'membership_mismatch' });
      expect(g.calls()).toBe(2);
    });

    it('a failed read is not cached: held now, routed once the read works', async () => {
      let denied = true;
      const g = graphAnswering(() => {
        if (denied) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
        return { value: [teamEntry(TEAM_A)] };
      });
      const reader = new TeamMembershipReader(g.client, { retry: { retries: 0 } });
      const { r, lines } = resolverWith({ mode: 'enforce', source: reader }, [rowA]);
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ reason: 'membership_unverified' });
      expect(lines[0]).toMatchObject({ event: 'membership.unverified', status: 403 });
      denied = false;
      expect(await r.resolve(uploadBy(OID_A))).toMatchObject({ source: 'directory' });
      expect(g.calls()).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Post-classification: direction only, never the client
// ---------------------------------------------------------------------------

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    documentType: 'Nieposortowane',
    folderPath: '98_Nieposortowane/2026/02',
    confidence: 0.75,
    classifier: 'claude',
    fields: { category: 'nieposortowane', year: 2026, month: 2 },
    ...overrides,
  };
}

describe('ClientResolver.resolvePostClassification', () => {
  const resolver = new ClientResolver(makeReader([clientA, clientB, staffRow]), {
    quarantineTarget,
    membership: enforce,
  });

  it('flips a nieposortowane invoice to faktury_zakupu when the bound client is the buyer', async () => {
    const pre = await resolver.resolve({ ...baseSource, userAadObjectId: OID_A });
    const post = resolver.resolvePostClassification(
      pre,
      makeClassification({ parties: [{ role: 'buyer', nip: '1111111111' }] }),
    );
    expect(post.client).toBe(pre);
    expect(post.directionCorrection).toBe('zakup');
    expect(post.classification.folderPath).toBe('01_Faktury/02_Faktury_zakupu/2026/02');
  });

  it('flips to faktury_sprzedazy when the bound client is the seller', async () => {
    const pre = await resolver.resolve({ ...baseSource, userAadObjectId: OID_A });
    const post = resolver.resolvePostClassification(
      pre,
      makeClassification({ parties: [{ role: 'seller', nip: '1111111111' }] }),
    );
    expect(post.directionCorrection).toBe('sprzedaz');
    expect(post.classification.fields.category).toBe('faktury_sprzedazy');
  });

  // Regressions for the verified findings nip-promotion-misfile and
  // prompt-injection-steers-routing: a document naming another client's NIP
  // stays exactly where identity put it.
  it("keeps a quarantined receipt in quarantine even though client B's NIP is on it", async () => {
    const pre = await resolver.resolve({ ...baseSource, userAadObjectId: undefined });
    const post = resolver.resolvePostClassification(
      pre,
      makeClassification({ parties: [{ role: 'seller', nip: '2222222222' }] }),
    );
    expect(post.client).toEqual({ source: 'quarantine', reason: 'unmapped', target: quarantineTarget });
  });

  it("keeps a staff upload in quarantine even when exactly one client's NIP matches", async () => {
    const pre = await resolver.resolve({ ...baseSource, userAadObjectId: OID_STAFF });
    const post = resolver.resolvePostClassification(
      pre,
      makeClassification({ parties: [{ role: 'buyer', nip: '1111111111' }] }),
    );
    expect(post.client.source).toBe('quarantine');
  });

  it("keeps client A's upload in A when the document names only client B", async () => {
    const pre = await resolver.resolve({ ...baseSource, userAadObjectId: OID_A });
    const post = resolver.resolvePostClassification(
      pre,
      makeClassification({ parties: [{ role: 'seller', nip: '2222222222' }] }),
    );
    expect(post.client).toBe(pre);
    expect(post.directionCorrection).toBeUndefined();
  });

  it('never changes the client for any combination of parties (property)', async () => {
    const roles: DocumentParty['role'][] = ['seller', 'buyer', 'issuer', 'recipient', 'unknown'];
    const nips = ['1111111111', '2222222222', '3333333333', ''];
    const uploaders = [OID_A, OID_B, OID_STAFF, undefined];
    for (const oid of uploaders) {
      const pre = await resolver.resolve({ ...baseSource, userAadObjectId: oid });
      for (const role of roles) {
        for (const nip of nips) {
          for (const other of nips) {
            const parties: DocumentParty[] = [
              { role, nip },
              { role: 'seller', nip: other },
            ];
            const post = resolver.resolvePostClassification(pre, makeClassification({ parties }));
            expect(post.client).toBe(pre);
          }
        }
      }
    }
  });

  it('does nothing when no parties are extracted', async () => {
    const pre = await resolver.resolve({ ...baseSource, userAadObjectId: OID_A });
    const classification = makeClassification();
    const post = resolver.resolvePostClassification(pre, classification);
    expect(post.classification).toBe(classification);
  });
});

describe('content-based routing stays deleted', () => {
  // The control for the cross-client write path is that the code does not
  // exist. If someone re-adds a NIP lookup or a promotion step to the
  // resolver, this fails before it can ship.
  it('clientResolver.ts has no NIP lookup and no promotion', () => {
    const source = readFileSync(join(__dirname, 'clientResolver.ts'), 'utf8');
    const offenders = ['byNip', 'promote', 'Promote', 'fallback'].filter((needle) =>
      source.includes(needle),
    );
    expect(offenders).toEqual([]);
  });
});

describe('applyInvoiceDirection', () => {
  it('returns null when parties is empty', () => {
    expect(applyInvoiceDirection(makeClassification({ parties: [] }), '9571185285')).toBeNull();
  });

  it('returns null when the current category is neither invoice nor nieposortowane', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          fields: { category: 'umowy', year: 2026, month: 2 },
          parties: [{ role: 'seller', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });

  it('returns null when the current category already matches the party role', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          documentType: 'Faktura sprzedaży',
          folderPath: '01_Faktury/01_Faktury_sprzedaży/2026/02',
          fields: { category: 'faktury_sprzedazy', year: 2026, month: 2 },
          parties: [{ role: 'seller', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });

  it('returns null when year/month are missing (cannot rebuild path)', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          fields: { category: 'nieposortowane' },
          parties: [{ role: 'buyer', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });

  it('flips nieposortowane → faktury_zakupu for a buyer client', () => {
    const applied = applyInvoiceDirection(
      makeClassification({ parties: [{ role: 'buyer', nip: '9571185285' }] }),
      '9571185285',
    );
    expect(applied?.direction).toBe('zakup');
    expect(applied?.classification.fields.category).toBe('faktury_zakupu');
    expect(applied?.classification.folderPath).toBe('01_Faktury/02_Faktury_zakupu/2026/02');
  });

  it('ignores party roles other than seller/buyer', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({ parties: [{ role: 'unknown', nip: '9571185285' }] }),
        '9571185285',
      ),
    ).toBeNull();
  });
});
