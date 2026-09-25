import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    const r = new ClientResolver(makeReader([clientA]), { quarantineTarget, log });
    await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(lines).toEqual([
      { clientId: '0002', listItemId: '11', teamId: 'team-0002', msg: 'routed to client via userAadObjectId' },
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
      { quarantineTarget },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'conflict' });
  });

  it('quarantines a user whose only row points at BCR GROUP as forbidden_target', async () => {
    const r = new ClientResolver(
      makeReader([{ ...clientA, target: { ...clientA.target, sitePath: '/sites/x/../BCRGROUP' } }]),
      { quarantineTarget },
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
    const r = new ClientResolver(readerFor(unavailable), { quarantineTarget });
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
    const r = new ClientResolver(makeReader([{ ...clientA, ...override }, clientB]), { quarantineTarget });
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
    const r = new ClientResolver(readerFor(snapshot), { quarantineTarget });
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'unbound_target' });
  });

  it('quarantines both users of rows that share a DriveId as conflict', async () => {
    const r = new ClientResolver(
      makeReader([clientA, { ...clientB, target: { ...clientB.target, expectedDriveId: 'b!drive-0002' } }]),
      { quarantineTarget },
    );
    for (const oid of [OID_A, OID_B]) {
      const resolved = await r.resolve({ ...baseSource, userAadObjectId: oid });
      expect(resolved).toMatchObject({ source: 'quarantine', reason: 'conflict' });
    }
  });

  it('quarantines a user whose row names a sub-site as forbidden_target', async () => {
    const r = new ClientResolver(
      makeReader([{ ...clientA, target: { ...clientA.target, sitePath: '/sites/ClientB/sub' } }, clientB]),
      { quarantineTarget },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved).toMatchObject({ source: 'quarantine', reason: 'forbidden_target' });
  });

  it('falls back to the title as companyName when no aliases are set', async () => {
    const r = new ClientResolver(
      makeReader([{ ...clientA, companyNameAliases: [] }]),
      { quarantineTarget },
    );
    const resolved = await r.resolve({ ...baseSource, userAadObjectId: OID_A });
    expect(resolved.source === 'directory' && resolved.companyName).toBe('[0002] Client A');
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
