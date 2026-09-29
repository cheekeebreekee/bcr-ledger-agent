import type { Client } from '@microsoft/microsoft-graph-client';
import { clientIdForDirectoryRow, LedgerDb, type ConnectionLike } from '@bcr/ledger-db';
import {
  CLIENT_ACCOUNT_REQUIRED,
  type Classification,
  type ClassifierContext,
  type ClientDirectoryEntry,
  type IngestionBatchRequestPayload,
  type Logger,
  type SearchRequestPayload,
  type SharePointTarget,
} from '@bcr/shared';
import { AcceptancePolicy } from './acceptancePolicy';
import { BatchIngestor, type SharePointFactoryLike } from './batchIngestor';
import { ChannelInbox, type InboxSharePoint } from './channelInbox';
import type { ClassificationOutcome } from './classificationService';
import { buildSnapshot, type ClientDirectoryReader } from './clientDirectoryReader';
import { ClientResolver } from './clientResolver';
import { ClientSearchService } from './clientSearch';
import type { DocumentIndex, IndexedDocument } from './documentIndex';
import type { InboxItem } from './sharePointService';
import { TeamMembershipReader } from './teamMembership';
import { UserAccountReader } from './userDirectory';

// ---------------------------------------------------------------------------
// The cross-path regression for the client account rule (owner's decision,
// 28 Sep 2026): a client is its `{NIP}@bcr-group.pl` Entra Member account, and
// guests have no capability in the ledger. The REAL resolver, batch ingestor,
// search service and channel inbox run here, wired as runtime.ts wires them
// (one resolver for uploads and search, the real Entra readers); only Graph,
// the Directory, SharePoint, the classifier and the database are fakes.
// Test data is synthetic.
// ---------------------------------------------------------------------------

const HOST = 'contoso.sharepoint.com';
const LIST_ID = 'c0ffee00-1234-4abc-9def-00112233aabb';
const TEAM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TEAM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const NIP_A = '1111111111';
const NOW = new Date('2026-09-28T12:00:00.000Z');
const OLD = '2026-09-28T11:30:00.000Z';

/** Client A's `{NIP}@bcr-group.pl` Member account. */
const CLIENT_A = 'a0000000-0000-4000-8000-000000000001';
/** A guest of client A's Team, invited by onboarding with the client's address. */
const GUEST = 'e0000000-0000-4000-8000-000000000006';
/** BCR staff: a Member whose UPN is no client's, in both Teams. */
const STAFF = 'c0000000-0000-4000-8000-000000000004';

const USERS: Readonly<
  Record<string, { userType: string; userPrincipalName: string; teams: string[] }>
> = {
  [CLIENT_A]: { userType: 'Member', userPrincipalName: `${NIP_A}@bcr-group.pl`, teams: [TEAM_A] },
  [GUEST]: {
    userType: 'Guest',
    userPrincipalName: `${NIP_A}_bcr-group.pl#EXT#@contoso.onmicrosoft.com`,
    teams: [TEAM_A],
  },
  [STAFF]: { userType: 'Member', userPrincipalName: 'staff@bcr-group.pl', teams: [TEAM_A, TEAM_B] },
};

const quarantineTarget: SharePointTarget = {
  siteHostname: HOST,
  sitePath: '/sites/BCRLedgerKwarantanna',
  driveName: 'Dokumenty',
  rootFolder: 'Kwarantanna',
};

/** Client A's row as the binding tool leaves it, with the given ids bound. */
function rowA(userAadObjectIds: readonly string[]): ClientDirectoryEntry {
  return {
    listItemId: '11',
    title: '[0002] Client A',
    clientId: '0002',
    nip: NIP_A,
    companyNameAliases: ['Client A Sp. z o.o.'],
    userAadObjectIds,
    target: {
      siteHostname: HOST,
      sitePath: '/sites/ClientA',
      driveName: 'Dokumenty',
      rootFolder: 'Dokumenty księgowe',
      expectedDriveId: 'b!drive-a',
    },
    teamId: TEAM_A,
    isAdmin: false,
    active: true,
  };
}

const SCOPE = clientIdForDirectoryRow(LIST_ID, '11');

const invoice: Classification = {
  documentType: 'Faktura zakupu',
  folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
  confidence: 0.93,
  classifier: 'claude',
  model: 'claude-opus-5',
  fields: { category: 'faktury_zakupu', year: 2026, month: 9, direction: 'zakup' },
};
const policy = new AcceptancePolicy(0.7);

/** A logger that records every line, children included. */
function recordingLogger(
  bindings: Record<string, unknown> = {},
  lines: Record<string, unknown>[] = [],
): { log: Logger; lines: Record<string, unknown>[] } {
  const write = (obj: unknown, msg?: string) =>
    lines.push({ ...bindings, ...(typeof obj === 'object' && obj ? obj : { msg: obj }), msg });
  const log = {
    info: write,
    warn: write,
    error: write,
    debug: write,
    child: (b: Record<string, unknown>) => recordingLogger({ ...bindings, ...b }, lines).log,
  } as unknown as Logger;
  return { log, lines };
}

/** Entra, read-only: `/users/{id}` and `/users/{id}/memberOf`. Records every path. */
function fakeGraph(): { client: Client; paths: string[] } {
  const paths: string[] = [];
  const respond = async (path: string): Promise<unknown> => {
    paths.push(path);
    const [route = ''] = path.split('?');
    let m: RegExpExecArray | null;
    if ((m = /^\/users\/([^/]+)$/.exec(route))) {
      const user = USERS[m[1] ?? ''];
      if (!user) throw Object.assign(new Error('Not Found'), { statusCode: 404 });
      return { userType: user.userType, userPrincipalName: user.userPrincipalName };
    }
    if ((m = /^\/users\/([^/]+)\/memberOf$/.exec(route))) {
      const user = USERS[m[1] ?? ''];
      if (!user) throw Object.assign(new Error('Not Found'), { statusCode: 404 });
      return {
        value: user.teams.map((id) => ({
          '@odata.type': '#microsoft.graph.group',
          id,
          resourceProvisioningOptions: ['Team'],
        })),
      };
    }
    throw Object.assign(new Error(`unexpected ${path}`), { statusCode: 400 });
  };
  const api = (path: string) => {
    const request = { middlewareOptions: () => request, get: () => respond(path) };
    return request;
  };
  return { client: { api } as unknown as Client, paths };
}

/** Both SharePoint factories of the bot path, recording every target they are asked for. */
function uploadFactory(name: 'client' | 'quarantine', calls: string[]): SharePointFactoryLike {
  return {
    forTarget: (target) => {
      calls.push(`${name}:${target.sitePath}`);
      return {
        uploadDocument: async (args) => ({
          id: `${name}-item`,
          name: args.filename,
          webUrl: `https://${target.siteHostname}${target.sitePath}/${args.filename}`,
        }),
        setListItemFields: async () => true,
      };
    },
  };
}

/** Client A's channel folder: the one file the test posts, and every call made to it. */
function fakeInbox(creator: string, calls: string[]): InboxSharePoint {
  const item: InboxItem = {
    id: 'item-1',
    name: 'faktura.pdf',
    eTag: '"{item-1},1"',
    size: 1024,
    file: { mimeType: 'application/pdf' },
    createdBy: { user: { id: creator } },
    createdDateTime: OLD,
    lastModifiedBy: { user: { id: creator } },
    lastModifiedDateTime: OLD,
    parentReference: { driveId: 'b!drive-a', id: 'inbox-a' },
  };
  return {
    resolveInbox: async () => {
      calls.push('resolveInbox');
      return { driveId: 'b!drive-a', folderId: 'inbox-a' };
    },
    listInboxChildren: async () => {
      calls.push('listInboxChildren');
      return [item];
    },
    checkInboxItem: async () => {
      calls.push('checkInboxItem');
    },
    downloadInboxItem: async () => {
      calls.push('downloadInboxItem');
      return Buffer.from('%PDF-1.7');
    },
    ensureInboxFolder: async () => {
      calls.push('ensureInboxFolder');
      return 'folder-1';
    },
    moveWithinInbox: async () => {
      calls.push('moveWithinInbox');
      return { id: 'item-1', nameSuffix: 0 };
    },
  };
}

/** A real LedgerDb over a fake connection: the real repositories run in the real transaction. */
function fakeDb() {
  const scopes: string[] = [];
  let scope = '';
  const conn: ConnectionLike = {
    async query(a: string | { text: string; values: unknown[] }, b?: unknown[]) {
      const call = typeof a === 'string' ? { text: a, values: b ?? [] } : a;
      const t = call.text;
      if (t.startsWith('SELECT set_config')) {
        scope = String(call.values[0]);
        scopes.push(scope);
        return { rows: [] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(t)) return { rows: [] };
      if (t.includes('INSERT INTO ledger.clients')) return { rows: [{ client_id: scope }] };
      if (t.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (t.includes('count(*)::int AS n FROM ledger.search_queries')) return { rows: [{ n: 0 }] };
      if (t.includes('INSERT INTO ledger.search_queries')) return { rows: [] };
      if (t.includes('UPDATE ledger.search_queries')) {
        return { rows: [{ query_id: call.values.at(-1) }] };
      }
      if (t.includes('count(*)::int AS n FROM (')) return { rows: [{ n: 0 }] };
      if (t.includes('FROM ledger.documents')) return { rows: [] };
      throw new Error(`unexpected statement: ${t.slice(0, 60)}`);
    },
    release() {},
    on() {},
    removeListener() {},
  };
  const db = new LedgerDb(
    { connect: async () => conn, end: async () => undefined },
    { log: recordingLogger().log },
  );
  return { db, scopes, withClientTx: jest.spyOn(db, 'withClientTx') };
}

/** Everything wired once, as runtime.ts wires it, over a Directory holding `rows`. */
function world(rows: readonly ClientDirectoryEntry[]) {
  // One log for every service, so each assertion sees every line.
  const { log, lines } = recordingLogger();
  const graph = fakeGraph();
  const snapshot = buildSnapshot(rows, NOW.getTime(), {
    forbiddenSitePaths: ['/sites/BCRGROUP', quarantineTarget.sitePath],
    allowedSiteHostname: HOST,
  });
  const directory = { getSnapshot: async () => snapshot } as unknown as ClientDirectoryReader;
  const noRetry = { retry: { retries: 0 } };
  const resolver = new ClientResolver(directory, {
    quarantineTarget,
    membership: { mode: 'enforce', source: new TeamMembershipReader(graph.client, noRetry) },
    accounts: new UserAccountReader(graph.client, noRetry),
    log,
  });

  const classify = jest.fn(
    async (_ctx: ClassifierContext): Promise<ClassificationOutcome> => ({
      kind: 'decided',
      decision: policy.decide(invoice, NOW),
    }),
  );
  const indexed: IndexedDocument[] = [];
  const index: DocumentIndex = {
    mode: 'write',
    record: jest.fn(async (doc: IndexedDocument) => {
      indexed.push(doc);
    }),
  };

  const factoryCalls: string[] = [];
  const ingestor = new BatchIngestor({
    resolver,
    classification: { classify },
    clientSharePointFactory: uploadFactory('client', factoryCalls),
    quarantineSharePointFactory: uploadFactory('quarantine', factoryCalls),
    index,
    now: () => NOW,
  });

  const interpret = jest.fn();
  const database = fakeDb();
  const search = new ClientSearchService({
    resolver,
    db: database.db,
    interpreter: { interpret },
    directoryListId: LIST_ID,
    searchRows: [],
    now: () => NOW,
  });

  const inboxCalls: string[] = [];
  const inboxFor = (creator: string) =>
    new ChannelInbox({
      mode: 'enforce',
      directory: { getSnapshot: async () => snapshot },
      sharePointFactory: { forTarget: () => fakeInbox(creator, inboxCalls) },
      accounts: new UserAccountReader(graph.client, { ...noRetry, sdkRetries: false }),
      membership: new TeamMembershipReader(graph.client, { ...noRetry, sdkRetries: false }),
      classification: { classify },
      minAgeMs: 60_000,
      maxFilesPerTick: 10,
      maxDownloadBytes: 1024 * 1024,
      index,
      now: () => NOW,
    });

  return {
    upload: (oid: string) => ingestor.ingestBatch(uploadBy(oid), log),
    ask: (oid: string, kind: 'question' | 'typed') => search.search(searchBy(oid, kind), log),
    post: (creator: string) => inboxFor(creator).sweep(log),
    lines,
    graph,
    classify,
    index,
    indexed,
    factoryCalls,
    interpret,
    withClientTx: database.withClientTx,
    scopes: database.scopes,
    inboxCalls,
  };
}

function uploadBy(oid: string): IngestionBatchRequestPayload {
  return {
    documents: ['faktura.pdf', 'umowa.pdf'].map((filename) => ({
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
      userAadObjectId: oid,
      userDisplayName: undefined,
    },
  };
}

function searchBy(oid: string, kind: 'question' | 'typed'): SearchRequestPayload {
  const source = {
    tenantId: '379013e4-0000-4000-8000-000000000001',
    conversationId: 'conv-1',
    activityId: 'act-1',
    conversationType: 'personal',
    userAadObjectId: oid,
  } as const;
  return kind === 'question'
    ? { source, query: { kind: 'question', text: 'faktury z września' } }
    : ({ source, query: { kind: 'typed', filter: {} } } as SearchRequestPayload);
}

const skipped = (lines: Record<string, unknown>[]) =>
  lines.filter((l) => l['event'] === 'inbox.skipped').map((l) => l['reason']);

// ---------------------------------------------------------------------------

describe('the client account rule, across every path', () => {
  // Rows 2 and 10 before the rebind hold only the guest; after a partial one
  // the guest could sit beside the client account.
  it.each([
    ['the only id on the row', [GUEST]],
    ["beside the row's client account", [CLIENT_A, GUEST]],
  ])(
    'a guest bound on a client row (%s) can neither file, nor search, nor be quarantined',
    async (_label, ids) => {
      const w = world([rowA(ids)]);

      // Upload: refused, nothing stored anywhere, the quarantine included.
      const results = await w.upload(GUEST);
      expect(results.map((r) => [r.status, r.error?.code])).toEqual([
        ['rejected', CLIENT_ACCOUNT_REQUIRED],
        ['rejected', CLIENT_ACCOUNT_REQUIRED],
      ]);
      expect(results.every((r) => r.result === undefined)).toBe(true);
      expect(w.factoryCalls).toEqual([]);
      expect(w.classify).not.toHaveBeenCalled();
      expect(w.index.record).not.toHaveBeenCalled();
      expect(w.lines.some((l) => l['event'] === 'document.quarantined')).toBe(false);

      // Search: no access, before any transaction or model call.
      await expect(w.ask(GUEST, 'question')).resolves.toEqual({ status: 'no_access' });
      await expect(w.ask(GUEST, 'typed')).resolves.toEqual({ status: 'no_access' });
      expect(w.withClientTx).not.toHaveBeenCalled();
      expect(w.interpret).not.toHaveBeenCalled();

      // Their channel post: left exactly where it is, never read.
      const summary = await w.post(GUEST);
      expect(summary).toMatchObject({ filed: 0, sortedToReview: 0, skippedNotClient: 1 });
      expect(skipped(w.lines)).toEqual(['guest']);
      expect(w.inboxCalls).toEqual(['resolveInbox', 'listInboxChildren']);
      expect(w.classify).not.toHaveBeenCalled();
      expect(w.index.record).not.toHaveBeenCalled();

      // A guest's Teams are never read, on any path.
      expect(w.graph.paths.filter((p) => p.includes(`${GUEST}/memberOf`))).toEqual([]);
    },
  );

  it('a staff Member bound on a client row cannot route', async () => {
    const w = world([rowA([CLIENT_A, STAFF])]);

    // Upload: held for staff as not_client_account, never the client's space.
    const results = await w.upload(STAFF);
    expect(results.map((r) => r.status)).toEqual(['quarantined', 'quarantined']);
    expect(results.every((r) => r.result === undefined)).toBe(true);
    expect(w.factoryCalls.every((c) => c.startsWith('quarantine:'))).toBe(true);
    expect(w.factoryCalls).not.toHaveLength(0);
    expect(w.lines.find((l) => l['msg'] === 'client resolved')).toMatchObject({
      resolution: 'quarantine',
      quarantineReason: 'not_client_account',
    });
    expect(w.classify).not.toHaveBeenCalled();
    expect(w.index.record).not.toHaveBeenCalled();

    // Search: no access.
    await expect(w.ask(STAFF, 'question')).resolves.toEqual({ status: 'no_access' });
    await expect(w.ask(STAFF, 'typed')).resolves.toEqual({ status: 'no_access' });
    expect(w.withClientTx).not.toHaveBeenCalled();
    expect(w.interpret).not.toHaveBeenCalled();

    // Channel post: left untouched.
    const summary = await w.post(STAFF);
    expect(summary).toMatchObject({ filed: 0, skippedNotClient: 1 });
    expect(skipped(w.lines)).toEqual(['not_client_account']);
    expect(w.inboxCalls).toEqual(['resolveInbox', 'listInboxChildren']);

    // The account check comes first: staff's Teams are never read.
    expect(w.graph.paths.filter((p) => p.includes(`${STAFF}/memberOf`))).toEqual([]);
    expect(JSON.stringify(w.lines)).not.toContain('staff@bcr-group.pl');
  });

  it("the row's {NIP}@ account files, searches and is swept", async () => {
    const w = world([rowA([CLIENT_A, GUEST, STAFF])]);

    // Upload: filed into the client's own space, and indexed.
    const results = await w.upload(CLIENT_A);
    expect(results.map((r) => r.status)).toEqual(['uploaded', 'uploaded']);
    expect(w.factoryCalls).toEqual(['client:/sites/ClientA', 'client:/sites/ClientA']);
    expect(w.classify).toHaveBeenCalledTimes(2);
    expect(w.indexed.map((d) => [d.source, d.uploadedByOid])).toEqual([
      ['bot', CLIENT_A],
      ['bot', CLIENT_A],
    ]);
    expect(w.lines.find((l) => l['msg'] === 'routed to client via userAadObjectId')).toMatchObject({
      listItemId: '11',
      account: 'verified',
      membership: 'verified',
    });

    // Search: runs, in this row's scope and no other.
    await expect(w.ask(CLIENT_A, 'typed')).resolves.toMatchObject({ status: 'ok' });
    expect(w.withClientTx).toHaveBeenCalled();
    expect(w.withClientTx.mock.calls.every(([scope]) => scope === SCOPE)).toBe(true);
    expect(new Set(w.scopes)).toEqual(new Set([SCOPE]));

    // Channel post: moved within the channel folder, and indexed.
    const summary = await w.post(CLIENT_A);
    expect(summary).toMatchObject({ filed: 1, skippedNotClient: 0, skippedUnverified: 0 });
    expect(w.inboxCalls).toContain('moveWithinInbox');
    expect(w.indexed.filter((d) => d.source === 'inbox').map((d) => d.uploadedByOid)).toEqual([
      CLIENT_A,
    ]);

    // No log line anywhere carries the account's UPN.
    expect(JSON.stringify(w.lines)).not.toContain(`${NIP_A}@`);
  });
});
