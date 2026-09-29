import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  ClientDirectoryEntry,
  IngestionSource,
  Logger,
  SharePointTarget,
} from '@bcr/shared';
import {
  buildSnapshot,
  type ClientDirectoryReader,
  type ClientDirectorySnapshot,
} from './clientDirectoryReader';
import { ClientResolver, type ClientResolverOptions } from './clientResolver';
import {
  TeamMembershipReadError,
  TeamMembershipReader,
  type MembershipCheck,
  type TeamMembershipSource,
} from './teamMembership';
import {
  UserAccountReadError,
  UserAccountReader,
  type UserAccount,
  type UserAccountSource,
} from './userDirectory';

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
/** A guest (of client A's Team, as onboarding invites them). */
const OID_GUEST = '6a1e3d22-8d4f-4c3b-9f72-0b5e4c3d2f10';
/** A Member on no row: a `{NIP}@` account of a client without a row, or staff. */
const OID_UNMAPPED = '9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
/** Entra has no such user. */
const OID_DELETED = '7b2f4e33-9e50-4d4c-8a83-1c6f5d4e3a21';

/**
 * Entra's view of every test user (synthetic): each client's `{NIP}@` Member
 * account, staff, a guest. `{NIP}@` UPNs are data a log must never carry.
 */
const ACCOUNTS: Readonly<Record<string, UserAccount>> = {
  [OID_A]: { userType: 'Member', userPrincipalName: '1111111111@bcr-group.pl' },
  [OID_B]: { userType: 'Member', userPrincipalName: '2222222222@bcr-group.pl' },
  [OID_STAFF]: { userType: 'Member', userPrincipalName: 'staff@bcr-group.pl' },
  [OID_GUEST]: {
    userType: 'Guest',
    userPrincipalName: 'guest_example.com#EXT#@contoso.onmicrosoft.com',
  },
  [OID_UNMAPPED]: { userType: 'Member', userPrincipalName: '3333333333@bcr-group.pl' },
};

/** An account source that answers from a table (or fails), recording who it was asked about. */
function accountsFrom(
  table: Readonly<Record<string, UserAccount>> | Error = ACCOUNTS,
): UserAccountSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    accountOf: async (oid) => {
      calls.push(oid);
      if (table instanceof Error) throw table;
      return table[oid] ?? null;
    },
  };
}

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

/** A resolver as runtime builds one: every option given, the accounts from the table unless set. */
function resolverOf(
  directory: ClientDirectoryReader,
  opts: Partial<ClientResolverOptions> = {},
): ClientResolver {
  return new ClientResolver(directory, {
    quarantineTarget,
    membership: enforce,
    accounts: accountsFrom(),
    ...opts,
  });
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
  const resolver = resolverOf(makeReader([clientA, clientB, staffRow]));

  it("routes the row's {NIP}@ Member account to its own client", async () => {
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

  it("routes the row's {NIP}@ Member account and logs account: verified, ids only", async () => {
    const { log, lines } = recordingLogger();
    const r = resolverOf(makeReader([clientA]), { log });
    await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(lines).toEqual([
      {
        clientId: '0002',
        listItemId: '11',
        teamId: 'team-0002',
        account: 'verified',
        membership: 'verified',
        msg: 'routed to client via userAadObjectId',
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('1111111111');
  });

  it('matches the user id case-insensitively', async () => {
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: OID_A.toUpperCase(),
    });
    expect(resolved.source).toBe('directory');
  });

  it('quarantines a Member on no row as unmapped — never BCR GROUP, never another client', async () => {
    const resolved = await resolver.resolve({ ...baseSource, userAadObjectId: OID_UNMAPPED });
    expect(resolved).toEqual({ source: 'quarantine', reason: 'unmapped', target: quarantineTarget });
  });

  it('still quarantines staff on an admin row as staff after reading their account', async () => {
    const accounts = accountsFrom();
    const r = resolverOf(makeReader([clientA, clientB, staffRow]), { accounts });
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_STAFF });
    expect(resolved).toEqual({ source: 'quarantine', reason: 'staff', target: quarantineTarget });
    expect(accounts.calls).toEqual([OID_STAFF]);
  });

  it('quarantines a user id that sits on a client row and an admin row as conflict', async () => {
    const r = resolverOf(
      makeReader([clientA, { ...staffRow, userAadObjectIds: [OID_A] }]),
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'conflict' });
  });

  it('quarantines a user whose only row points at BCR GROUP as forbidden_target', async () => {
    const r = resolverOf(
      makeReader([{ ...clientA, target: { ...clientA.target, sitePath: '/sites/x/../BCRGROUP' } }]),
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
    const r = resolverOf(readerFor(unavailable));
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'stale_directory' });
  });

  // Contract C3: a row the binding tool has not bound routes nobody — it
  // would file into the library root, for an account nobody checked is in
  // this client's Team only.
  it.each([
    ['RootFolder', { target: { ...clientA.target, rootFolder: '' } }],
    ['DriveId', { target: { ...clientA.target, expectedDriveId: '' } }],
    ['TeamId', { teamId: '' }],
  ])('quarantines a user whose only row lacks %s as unbound_target', async (_missing, override) => {
    const r = resolverOf(makeReader([{ ...clientA, ...override }, clientB]));
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
    const r = resolverOf(readerFor(snapshot));
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'unbound_target' });
  });

  it('quarantines both users of rows that share a DriveId as conflict', async () => {
    const r = resolverOf(
      makeReader([clientA, { ...clientB, target: { ...clientB.target, expectedDriveId: 'b!drive-0002' } }]),
    );
    for (const oid of [OID_A, OID_B]) {
      const resolved = await r.resolve({ ...baseSource, userAadObjectId: oid });
      expect(resolved).toMatchObject({ source: 'quarantine', reason: 'conflict' });
    }
  });

  it('quarantines a user whose row names a sub-site as forbidden_target', async () => {
    const r = resolverOf(
      makeReader([{ ...clientA, target: { ...clientA.target, sitePath: '/sites/ClientB/sub' } }, clientB]),
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'forbidden_target' });
  });

  it('falls back to the title as companyName when no aliases are set', async () => {
    const r = resolverOf(
      makeReader([{ ...clientA, companyNameAliases: [] }]),
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
    const r = resolverOf(makeReader(entries), { membership, log });
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
    ["in the row's Team and another client's (R46)", ['team-0002', 'team-0003'], true, 1],
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
    ['staff', OID_STAFF, 'quarantine', 'staff'],
    ['an unmapped Member', OID_UNMAPPED, 'quarantine', 'unmapped'],
    ['a guest', OID_GUEST, 'refused', 'guest'],
    ['a deleted user', OID_DELETED, 'refused', 'unknown_user'],
    ['no user id', undefined, 'refused', 'no_identity'],
  ])(
    'does not read Teams for refused, staff or unmapped users: %s',
    async (_label, oid, outcome, reason) => {
      const teams = source(['team-0002']);
      const { r } = resolverWith({ mode: 'enforce', source: teams });
      expect(await r.resolve(uploadBy(oid))).toMatchObject({ source: outcome, reason });
      expect(teams.calls).toEqual([]);
    },
  );

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
// The client account (owner's decision, 28 Sep 2026): a client is its
// {NIP}@bcr-group.pl Member account; guests have no capability.
// ---------------------------------------------------------------------------

describe('ClientResolver.resolve — the client account', () => {
  /** A membership source that records who it was asked about. */
  function teamsSource(teams: readonly string[] = ['team-0002']) {
    const calls: string[] = [];
    const source: TeamMembershipSource = {
      teamsOf: async (oid) => {
        calls.push(oid);
        return new Set(teams);
      },
    };
    return { source, calls };
  }

  function setup(
    entries: ClientDirectoryEntry[] = [clientA, clientB, staffRow],
    opts: {
      accounts?: UserAccountSource & { calls: string[] };
      membership?: 'enforce' | 'off';
      reader?: ClientDirectoryReader;
    } = {},
  ) {
    const teams = teamsSource();
    const accounts = opts.accounts ?? accountsFrom();
    const directory = opts.reader ?? makeReader(entries);
    const { log, lines } = recordingLogger();
    const r = resolverOf(directory, {
      accounts,
      membership: opts.membership === 'off' ? { mode: 'off' } : { mode: 'enforce', source: teams.source },
      log,
    });
    return { r, lines, teams, accounts, directory };
  }

  const by = (oid: string | undefined, purpose?: 'upload' | 'search') => ({
    ...baseSource,
    userAadObjectId: oid,
    ...(purpose ? { purpose } : {}),
  });

  const guestOnA = { ...clientA, userAadObjectIds: [OID_GUEST] };

  it("routes the row's {NIP}@ Member account and logs account: verified", async () => {
    const { r, lines, accounts, teams } = setup();
    expect(await r.resolve(by(OID_A))).toMatchObject({ source: 'directory', listItemId: '11' });
    expect(accounts.calls).toEqual([OID_A]);
    expect(teams.calls).toEqual([OID_A]);
    expect(lines).toEqual([
      expect.objectContaining({
        account: 'verified',
        membership: 'verified',
        msg: 'routed to client via userAadObjectId',
      }),
    ]);
  });

  it('refuses a guest bound on a client row: no quarantine target, no Teams read, no snapshot needed', async () => {
    const { r, lines, teams, directory } = setup([guestOnA, clientB]);
    const resolved = await r.resolve(by(OID_GUEST));
    expect(resolved).toEqual({ source: 'refused', reason: 'guest' });
    expect(resolved).not.toHaveProperty('target');
    expect(teams.calls).toEqual([]);
    expect(directory.getSnapshot).not.toHaveBeenCalled();
    expect(lines).toEqual([
      {
        event: 'identity.refused',
        reason: 'guest',
        purpose: 'upload',
        userAadObjectId: OID_GUEST,
        msg: 'identity.refused',
      },
    ]);
  });

  it('refuses a guest on no row, a guest on an admin row, and a guest while the Directory is unavailable', async () => {
    const onNoRow = setup([clientA]);
    const onAdminRow = setup([clientA, { ...staffRow, userAadObjectIds: [OID_GUEST] }]);
    const unavailable = setup([], {
      reader: readerFor({ ...buildSnapshot([], 0, { forbiddenSitePaths: [], allowedSiteHostname: HOST }), health: 'unavailable' }),
    });
    for (const t of [onNoRow, onAdminRow, unavailable]) {
      expect(await t.r.resolve(by(OID_GUEST))).toEqual({ source: 'refused', reason: 'guest' });
      expect(t.teams.calls).toEqual([]);
    }
  });

  it('refuses a guest whatever the type spelling, for search too', async () => {
    const accounts = accountsFrom({ [OID_GUEST]: { userType: ' GUEST ', userPrincipalName: 'x' } });
    const { r, lines } = setup([guestOnA], { accounts });
    expect(await r.resolve(by(OID_GUEST, 'search'))).toEqual({ source: 'refused', reason: 'guest' });
    expect(lines[0]).toMatchObject({ event: 'identity.refused', purpose: 'search' });
  });

  it('refuses an unreadable account as identity_unverified and reads it again on the next call', async () => {
    let failing = true;
    const paths: string[] = [];
    const graph = {
      api: (path: string) => ({
        get: async () => {
          paths.push(path);
          if (failing) throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
          return ACCOUNTS[OID_A];
        },
      }),
    } as unknown as Client;
    const reader = new UserAccountReader(graph, { retry: { retries: 0 } });
    const { log, lines } = recordingLogger();
    const r = resolverOf(makeReader([clientA]), { accounts: reader, log });

    expect(await r.resolve(by(OID_A))).toEqual({ source: 'refused', reason: 'identity_unverified' });
    expect(lines).toEqual([
      { event: 'identity.unverified', purpose: 'upload', status: 503, msg: 'identity.unverified' },
      {
        event: 'identity.refused',
        reason: 'identity_unverified',
        purpose: 'upload',
        userAadObjectId: OID_A,
        msg: 'identity.refused',
      },
    ]);
    failing = false;
    expect(await r.resolve(by(OID_A))).toMatchObject({ source: 'directory' });
    expect(paths).toHaveLength(2);
  });

  it.each([
    ['a read error without a status', new UserAccountReadError('no')],
    ['any other error', new Error('boom')],
  ])('refuses as identity_unverified on %s, with no status', async (_label, error) => {
    const { r, lines } = setup([clientA], { accounts: accountsFrom(error) });
    expect(await r.resolve(by(OID_A))).toEqual({ source: 'refused', reason: 'identity_unverified' });
    expect(lines[0]).toEqual({
      event: 'identity.unverified',
      purpose: 'upload',
      msg: 'identity.unverified',
    });
  });

  it('refuses a deleted user as unknown_user', async () => {
    const { r, teams } = setup([{ ...clientA, userAadObjectIds: [OID_DELETED] }]);
    expect(await r.resolve(by(OID_DELETED))).toEqual({ source: 'refused', reason: 'unknown_user' });
    expect(teams.calls).toEqual([]);
  });

  it.each([['Other'], [''], ['   ']])(
    'refuses a non-Member, non-Guest type (%j) as not_member',
    async (userType) => {
      const accounts = accountsFrom({
        [OID_A]: { userType, userPrincipalName: '1111111111@bcr-group.pl' },
      });
      const { r, teams } = setup([clientA], { accounts });
      expect(await r.resolve(by(OID_A))).toEqual({ source: 'refused', reason: 'not_member' });
      expect(teams.calls).toEqual([]);
    },
  );

  it.each([
    ['no id', undefined],
    ['an empty id', '  '],
    ['a non-GUID id', '../me'],
  ])('refuses %s as no_identity without a Graph call', async (_label, oid) => {
    const { r, accounts, directory, lines } = setup();
    expect(await r.resolve(by(oid))).toEqual({ source: 'refused', reason: 'no_identity' });
    expect(accounts.calls).toEqual([]);
    expect(directory.getSnapshot).not.toHaveBeenCalled();
    expect(lines).toEqual([
      { event: 'identity.refused', reason: 'no_identity', purpose: 'upload', msg: 'identity.refused' },
    ]);
  });

  // Regression: a staff id bound on a client row cannot route.
  it('quarantines a staff Member bound on a client row as not_client_account, without a Teams read', async () => {
    const { r, lines, teams } = setup([{ ...clientA, userAadObjectIds: [OID_STAFF] }]);
    expect(await r.resolve(by(OID_STAFF))).toEqual({
      source: 'quarantine',
      reason: 'not_client_account',
      target: quarantineTarget,
    });
    expect(teams.calls).toEqual([]);
    expect(lines).toEqual([
      {
        event: 'client_account.mismatch',
        clientId: '0002',
        listItemId: '11',
        teamId: 'team-0002',
        purpose: 'upload',
        accountCheck: 'upn_mismatch',
        msg: 'client_account.mismatch',
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('bcr-group.pl');
  });

  it("quarantines another client's {NIP}@ account bound on this row as not_client_account", async () => {
    // Client B's account typed onto client A's row (and B's row without it).
    const { r, teams } = setup([
      { ...clientA, userAadObjectIds: [OID_B] },
      { ...clientB, userAadObjectIds: [] },
    ]);
    expect(await r.resolve(by(OID_B))).toMatchObject({
      source: 'quarantine',
      reason: 'not_client_account',
    });
    expect(teams.calls).toEqual([]);
  });

  it.each([
    ['no NIP', ''],
    ['a 9-digit NIP', '111111111'],
    ['an 11-digit NIP', '11111111111'],
  ])('quarantines every Member of a row with %s as not_client_account', async (_label, nip) => {
    const { r, lines } = setup([{ ...clientA, nip, userAadObjectIds: [OID_A, OID_STAFF] }]);
    for (const oid of [OID_A, OID_STAFF]) {
      expect(await r.resolve(by(oid))).toMatchObject({ reason: 'not_client_account' });
    }
    expect(lines.map((l) => l['accountCheck'])).toEqual(['row_nip_invalid', 'row_nip_invalid']);
  });

  it('compares the UPN case-insensitively and never accepts a subdomain or onmicrosoft alias', async () => {
    const upns: [string, string][] = [
      ['1111111111@BCR-Group.PL', 'directory'],
      [' 1111111111@bcr-group.pl ', 'directory'],
      ['1111111111@sub.bcr-group.pl', 'quarantine'],
      ['1111111111@contoso.onmicrosoft.com', 'quarantine'],
      ['1111111111_bcr-group.pl#EXT#@contoso.onmicrosoft.com', 'quarantine'],
      ['x1111111111@bcr-group.pl', 'quarantine'],
    ];
    for (const [userPrincipalName, want] of upns) {
      const accounts = accountsFrom({ [OID_A]: { userType: 'Member', userPrincipalName } });
      const { r } = setup([clientA], { accounts });
      expect([userPrincipalName, (await r.resolve(by(OID_A))).source]).toEqual([
        userPrincipalName,
        want,
      ]);
    }
  });

  it('uses the injected domain when given one', async () => {
    const accounts = accountsFrom({
      [OID_A]: { userType: 'Member', userPrincipalName: '1111111111@contoso.example' },
    });
    const r = resolverOf(makeReader([clientA]), { accounts, clientAccountDomain: 'contoso.example' });
    expect(await r.resolve(by(OID_A))).toMatchObject({ source: 'directory' });
  });

  it('MEMBERSHIP_CHECK_MODE=off skips the Teams read but never the account check', async () => {
    const off = setup([clientA, { ...clientB, userAadObjectIds: [OID_B, OID_STAFF, OID_GUEST] }], {
      membership: 'off',
    });
    expect(await off.r.resolve(by(OID_A))).toMatchObject({ source: 'directory' });
    expect(await off.r.resolve(by(OID_STAFF))).toMatchObject({ reason: 'not_client_account' });
    expect(await off.r.resolve(by(OID_GUEST))).toEqual({ source: 'refused', reason: 'guest' });
    expect(off.accounts.calls).toEqual([OID_A, OID_STAFF, OID_GUEST]);
    expect(off.teams.calls).toEqual([]);
  });
});

describe('content-based routing stays deleted', () => {
  // The control for the cross-client write path is that the code does not
  // exist. If someone re-adds a NIP lookup or a promotion step to the
  // resolver, this fails before it can ship.
  it('clientResolver.ts has no NIP lookup and no promotion', () => {
    const source = readFileSync(join(__dirname, 'clientResolver.ts'), 'utf8');
    const offenders = ['byNip', 'rowsByNip', 'snapshot.entries', 'promote', 'Promote', 'fallback'].filter(
      (needle) => source.includes(needle),
    );
    expect(offenders).toEqual([]);
  });

  // The account confirms the row the object id chose; it never finds one. A
  // lookup keyed by the UPN (or a NIP taken from it) would be content-free
  // routing by another name.
  it('clientResolver.ts never looks a row up by UPN or NIP', () => {
    const source = readFileSync(join(__dirname, 'clientResolver.ts'), 'utf8');
    const offenders = [
      /\.get\([^)]*userPrincipalName/,
      /\.get\([^)]*\.nip\b/,
      /\.find\(/,
      /\.filter\(/,
      /entries\b/,
    ].filter((pattern) => pattern.test(source));
    expect(offenders).toEqual([]);
    // The one map the resolver reads a row from is keyed by object id.
    expect(source.match(/\.get\([^)]*\)/g)).toEqual(['.get(oid)']);
  });

  // Direction is settled inside classification, from the bound client's own
  // identity. Nothing there may reach the Directory, where another client's
  // NIP could be found.
  it('the classification modules never read the Directory', () => {
    const offenders: string[] = [];
    for (const file of [
      'invoiceDirection.ts',
      'acceptancePolicy.ts',
      'claudeClassifier.ts',
      'classificationService.ts',
    ]) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      for (const needle of ['getSnapshot', 'byUserAadObjectId', 'byNip', 'clientDirectory']) {
        if (source.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
