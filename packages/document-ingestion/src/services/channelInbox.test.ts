import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  Classification,
  Classifier,
  ClassifierContext,
  ClientDirectoryEntry,
  Logger,
} from '@bcr/shared';
import {
  ChannelInbox,
  CLASSIFY_RESERVE_MS,
  INBOX_TICK_HARD_LIMIT_MS,
  WRITE_RESERVE_MS,
  inboxPlacement,
  reviewFolderPath,
  selectCandidates,
  type ChannelInboxDeps,
  type InboxTickSummary,
} from './channelInbox';
import { ClassificationService, FallbackClassifier } from './classificationService';
import { buildSnapshot, type ClientDirectorySnapshot } from './clientDirectoryReader';
import type { InboxItem } from './sharePointService';
import { createSharePointWiring } from './sharePointWiring';
import { TeamMembershipReader } from './teamMembership';
import { UserTypeReader } from './userDirectory';

// ---------------------------------------------------------------------------
// A fake tenant: sites, drives with folder trees, users and their Teams. It
// answers the Graph calls the sweep makes and records every one of them.
// ---------------------------------------------------------------------------

const HOST = 'contoso.sharepoint.com';
const WEB = '99999999-9999-4999-8999-999999999999';
const BCR_GROUP = '11111111-1111-4111-8111-111111111111';
const QUARANTINE = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';
const siteId = (collection: string) => `${HOST},${collection},${WEB}`;

/** Which collection each site path resolves to, and that collection's drive. */
const SITES: Record<string, { collection: string; drive: string }> = {
  '/sites/ClientA': { collection: SITE_A, drive: 'drive-a' },
  '/sites/ClientB': { collection: SITE_B, drive: 'drive-b' },
  '/sites/Kwarantanna': { collection: QUARANTINE, drive: 'drive-q' },
  // Paths a Directory row could carry that Graph resolves to a guarded site.
  '/sites/LooksLikeAClient': { collection: QUARANTINE, drive: 'drive-q' },
  '/sites/AlsoLooksLikeAClient': { collection: BCR_GROUP, drive: 'drive-g' },
};

const TEAM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TEAM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const GUEST_A = 'a0000000-0000-4000-8000-000000000001';
const GUEST_AB = 'ab000000-0000-4000-8000-000000000002';
const GUEST_B = 'b0000000-0000-4000-8000-000000000003';
const STAFF = 'c0000000-0000-4000-8000-000000000004';
const DELETED = 'd0000000-0000-4000-8000-000000000005';

const CHANNEL = 'Dokumenty księgowe';
const NOW = new Date('2026-09-26T10:00:00.000Z');
const OLD = '2026-09-26T09:50:00.000Z';
const YOUNG = '2026-09-26T09:59:30.000Z';
const GRAPH = 'https://graph.microsoft.com/v1.0';

interface FakeItem {
  id: string;
  name: string;
  driveId: string;
  parentId: string | null;
  folder?: boolean;
  mimeType?: string;
  size?: number;
  eTag: string;
  createdBy?: string;
  /** Who changed it last: the creator unless set; `null` for an application. */
  modifiedBy?: string | null;
  createdDateTime?: string;
  lastModifiedDateTime: string;
  content?: Buffer;
}

interface Call {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'stream';
  readonly path: string;
  readonly query: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Override = (call: Call, next: () => unknown) => unknown;

const graphError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

class FakeTenant {
  readonly calls: Call[] = [];
  readonly items = new Map<string, FakeItem>();
  readonly users = new Map<string, { userType: string; teams: string[] }>();
  /** Checked in order before the default answer; the first matching pattern wins. */
  readonly overrides: [RegExp, Override][] = [];
  pageSize = 200;
  private seq = 0;

  constructor() {
    for (const { drive } of Object.values(SITES)) {
      if (this.items.has(`root-${drive}`)) continue;
      this.items.set(`root-${drive}`, {
        id: `root-${drive}`,
        name: 'root',
        driveId: drive,
        parentId: null,
        folder: true,
        eTag: 'e0',
        lastModifiedDateTime: OLD,
      });
      this.addFolder(drive, `root-${drive}`, CHANNEL, `inbox-${drive.slice(-1)}`);
    }
    this.users.set(GUEST_A, { userType: 'Guest', teams: [TEAM_A] });
    this.users.set(GUEST_AB, { userType: 'Guest', teams: [TEAM_A, TEAM_B] });
    this.users.set(GUEST_B, { userType: 'Guest', teams: [TEAM_B] });
    this.users.set(STAFF, { userType: 'Member', teams: [TEAM_A, TEAM_B] });
  }

  addFolder(driveId: string, parentId: string, name: string, id = this.nextId('folder')): string {
    this.items.set(id, {
      id,
      name,
      driveId,
      parentId,
      folder: true,
      eTag: 'e1',
      lastModifiedDateTime: OLD,
    });
    return id;
  }

  addFile(
    parentId: string,
    file: Partial<Omit<FakeItem, 'id' | 'parentId'>> & { name: string },
  ): string {
    const parent = this.items.get(parentId);
    if (!parent) throw new Error(`no parent ${parentId}`);
    const id = this.nextId('item');
    const content = file.content ?? Buffer.from(`%PDF synthetic ${id}`);
    this.items.set(id, {
      driveId: parent.driveId,
      mimeType: 'application/pdf',
      eTag: `"{${id}},1"`,
      createdBy: GUEST_A,
      lastModifiedDateTime: OLD,
      size: content.length,
      content,
      ...file,
      id,
      parentId,
    });
    return id;
  }

  item(id: string): FakeItem {
    const found = this.items.get(id);
    if (!found) throw new Error(`no item ${id}`);
    return found;
  }

  /** The folder path of an item below its drive root, e.g. `Dokumenty księgowe/04_Umowy`. */
  pathOf(id: string): string {
    const segments: string[] = [];
    let current = this.items.get(id);
    while (current && current.parentId !== null) {
      segments.unshift(current.name);
      current = this.items.get(current.parentId);
    }
    return segments.join('/');
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'get' && c.method !== 'stream');
  }

  /** Moves an item elsewhere in its drive, as a person would: a new eTag, same id. */
  relocate(id: string, parentId: string, name?: string): void {
    const item = this.item(id);
    item.parentId = parentId;
    if (name !== undefined) item.name = name;
    item.eTag = `${item.eTag}~`;
  }

  get client(): Client {
    const api = (path: string) => {
      const query: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const call = (method: Call['method'], body?: unknown) =>
        this.respond({ method, path, query, headers, body });
      const request = {
        query(q: Record<string, string>) {
          Object.assign(query, q);
          return request;
        },
        header(key: string, value: string) {
          headers[key] = value;
          return request;
        },
        middlewareOptions: () => request,
        get: () => call('get'),
        getStream: () => call('stream'),
        post: (body: unknown) => call('post', body),
        put: (body: unknown) => call('put', body),
        patch: (body: unknown) => call('patch', body),
        delete: () => call('delete'),
      };
      return request;
    };
    return { api } as unknown as Client;
  }

  private async respond(call: Call): Promise<unknown> {
    this.calls.push(call);
    const key = `${call.method.toUpperCase()} ${call.path}`;
    const next = () => this.answer(call);
    const override = this.overrides.find(([pattern]) => pattern.test(key));
    return override ? override[1](call, next) : next();
  }

  private answer(call: Call): unknown {
    const path = call.path.startsWith(GRAPH) ? call.path.slice(GRAPH.length) : call.path;
    const [route = '', search = ''] = path.split('?');
    let m: RegExpExecArray | null;

    if (call.method === 'get' && (m = /^\/sites\/[^:/]+:(\/sites\/[^/]+)$/.exec(route))) {
      const site = SITES[m[1] ?? ''];
      if (!site) throw graphError(404);
      return { id: siteId(site.collection) };
    }
    if (call.method === 'get' && (m = /^\/sites\/[^,]+,([^,]+),[^/]+\/drives$/.exec(route))) {
      const site = Object.values(SITES).find((s) => s.collection === m?.[1]);
      return { value: site ? [{ id: site.drive, name: 'Dokumenty' }] : [] };
    }
    if (call.method === 'get' && (m = /^\/drives\/([^/]+)\/root:\/(.+)$/.exec(route))) {
      const [driveId = '', encoded = ''] = [m[1], m[2]];
      let current = this.item(`root-${driveId}`);
      for (const segment of encoded.split('/').map(decodeURIComponent)) {
        const child = this.childNamed(current.id, segment);
        if (!child) throw graphError(404);
        current = child;
      }
      return this.json(current);
    }
    if ((m = /^\/drives\/([^/]+)\/items\/([^/:]+)\/children$/.exec(route))) {
      const [driveId = '', parentId = ''] = [m[1], this.resolveId(m[1] ?? '', m[2] ?? '')];
      const parent = this.items.get(parentId);
      if (!parent || parent.driveId !== driveId) throw graphError(404);
      if (call.method === 'post') {
        const { name } = call.body as { name: string };
        if (this.childNamed(parentId, name)) throw graphError(409);
        return this.json(this.item(this.addFolder(driveId, parentId, name)));
      }
      const all = [...this.items.values()].filter((i) => i.parentId === parentId);
      const skip = Number(/\$skiptoken=(\d+)/.exec(search)?.[1] ?? '0');
      const page = all.slice(skip, skip + this.pageSize);
      return {
        value: page.map((i) => this.json(i)),
        ...(skip + this.pageSize < all.length
          ? {
              '@odata.nextLink': `${GRAPH}/drives/${driveId}/items/${parentId}/children?$skiptoken=${skip + this.pageSize}`,
            }
          : {}),
      };
    }
    if (call.method === 'get' && (m = /^\/drives\/([^/]+)\/items\/([^/:]+):\/(.+)$/.exec(route))) {
      const parentId = this.resolveId(m[1] ?? '', m[2] ?? '');
      const child = this.childNamed(parentId, decodeURIComponent(m[3] ?? ''));
      if (!child) throw graphError(404);
      return this.json(child);
    }
    if (
      call.method === 'stream' &&
      (m = /^\/drives\/([^/]+)\/items\/([^/]+)\/content$/.exec(route))
    ) {
      const item = this.items.get(decodeURIComponent(m[2] ?? ''));
      if (!item || item.driveId !== m[1] || item.folder) throw graphError(404);
      return new Response(item.content ?? Buffer.alloc(0)).body;
    }
    if (call.method === 'get' && (m = /^\/drives\/([^/]+)\/items\/([^/:]+)$/.exec(route))) {
      const item = this.items.get(decodeURIComponent(m[2] ?? ''));
      if (!item || item.driveId !== m[1]) throw graphError(404);
      return this.json(item);
    }
    if (call.method === 'patch' && (m = /^\/drives\/([^/]+)\/items\/([^/]+)$/.exec(route))) {
      const driveId = m[1] ?? '';
      const item = this.items.get(decodeURIComponent(m[2] ?? ''));
      if (!item || item.driveId !== driveId) throw graphError(404);
      // As Graph documents for update and move: a stale If-Match is a 412.
      const ifMatch = call.headers['If-Match'];
      if (ifMatch !== undefined && ifMatch !== item.eTag) throw graphError(412);
      const body = call.body as { parentReference?: { id?: string }; name?: string };
      const targetId = body.parentReference?.id ?? item.parentId ?? '';
      const target = this.items.get(targetId);
      if (!target || target.driveId !== driveId || !target.folder) throw graphError(400);
      const name = body.name ?? item.name;
      const clash = this.childNamed(targetId, name);
      if (clash && clash.id !== item.id) throw graphError(409);
      item.parentId = targetId;
      item.name = name;
      item.eTag = `${item.eTag}+`;
      return this.json(item);
    }
    if (call.method === 'get' && (m = /^\/users\/([^/?]+)$/.exec(route))) {
      const user = this.users.get(m[1] ?? '');
      if (!user) throw graphError(404);
      return { userType: user.userType };
    }
    if (call.method === 'get' && (m = /^\/users\/([^/]+)\/memberOf$/.exec(route))) {
      const user = this.users.get(m[1] ?? '');
      if (!user) throw graphError(404);
      return {
        value: user.teams.map((id) => ({
          '@odata.type': '#microsoft.graph.group',
          id,
          resourceProvisioningOptions: ['Team'],
        })),
      };
    }
    throw Object.assign(new Error(`unhandled ${call.method} ${call.path}`), { statusCode: 400 });
  }

  private resolveId(driveId: string, id: string): string {
    return id === 'root' ? `root-${driveId}` : decodeURIComponent(id);
  }

  private childNamed(parentId: string, name: string): FakeItem | undefined {
    return [...this.items.values()].find(
      (i) => i.parentId === parentId && i.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private json(item: FakeItem): InboxItem & Record<string, unknown> {
    return {
      id: item.id,
      name: item.name,
      eTag: item.eTag,
      lastModifiedDateTime: item.lastModifiedDateTime,
      ...(item.folder ? { folder: { childCount: 0 } } : {}),
      ...(item.folder ? {} : { file: { mimeType: item.mimeType }, size: item.size }),
      ...(item.createdBy
        ? { createdBy: { user: { id: item.createdBy } } }
        : { createdBy: { application: { id: 'app' } } }),
      ...(() => {
        const modifier = item.modifiedBy === undefined ? item.createdBy : item.modifiedBy;
        return modifier
          ? { lastModifiedBy: { user: { id: modifier } } }
          : { lastModifiedBy: { application: { id: 'app' } } };
      })(),
      createdDateTime: item.createdDateTime ?? OLD,
      ...(item.parentId === null
        ? { root: {} }
        : { parentReference: { driveId: item.driveId, id: item.parentId } }),
    };
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
}

// ---------------------------------------------------------------------------
// Directory rows, classifications, the logger.
// ---------------------------------------------------------------------------

const NIP_A = '1111111111';

function clientRow(
  listItemId: string,
  sitePath: string,
  over: {
    driveId?: string | null;
    teamId?: string | null;
    rootFolder?: string | null;
    nip?: string;
    isAdmin?: boolean;
  } = {},
): ClientDirectoryEntry {
  const site = SITES[sitePath];
  const driveId = over.driveId === undefined ? site?.drive : over.driveId;
  const teamId = over.teamId === undefined ? `team-${listItemId}` : over.teamId;
  const rootFolder = over.rootFolder === undefined ? CHANNEL : over.rootFolder;
  return {
    listItemId,
    title: `[00${listItemId}] Client ${listItemId}`,
    clientId: `00${listItemId}`,
    nip: over.nip ?? '',
    companyNameAliases: [`Client ${listItemId} Sp. z o.o.`],
    userAadObjectIds: [],
    target: {
      siteHostname: HOST,
      sitePath,
      driveName: 'Dokumenty',
      ...(rootFolder ? { rootFolder } : {}),
      ...(driveId ? { expectedDriveId: driveId } : {}),
    },
    ...(teamId ? { teamId } : {}),
    isAdmin: over.isAdmin ?? false,
    active: true,
  };
}

const rowA = clientRow('11', '/sites/ClientA', { teamId: TEAM_A, nip: NIP_A });
const rowB = clientRow('12', '/sites/ClientB', { teamId: TEAM_B });

function snapshotOf(rows: readonly ClientDirectoryEntry[]): ClientDirectorySnapshot {
  return buildSnapshot(rows, NOW.getTime(), {
    forbiddenSitePaths: ['/sites/BCRGROUP', '/sites/Kwarantanna'],
    allowedSiteHostname: HOST,
  });
}

const invoice: Classification = {
  documentType: 'Faktura zakupu',
  folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
  confidence: 0.93,
  classifier: 'claude',
  fields: { category: 'faktury_zakupu', year: 2026, month: 9, reasoning: 'model free text' },
};

/** Reads the content like the Claude classifier, and like it returns null on any failure. */
function contentReadingClassifier(result: Classification): Classifier {
  return {
    name: 'claude',
    classify: async (ctx: ClassifierContext) => {
      try {
        await ctx.readContent();
        return result;
      } catch {
        return null;
      }
    },
  };
}

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

const noRetry = { retry: { retries: 0, minTimeoutMs: 0 } };

const wiringConfig = {
  clientDirectorySiteId: siteId(BCR_GROUP),
  quarantineSiteHostname: HOST,
  quarantineSitePath: '/sites/Kwarantanna',
  quarantineDriveName: 'Dokumenty',
  quarantineRootFolder: 'Kwarantanna',
};

interface SetupOptions {
  readonly rows?: readonly ClientDirectoryEntry[];
  readonly snapshot?: ClientDirectorySnapshot;
  readonly mode?: ChannelInboxDeps['mode'];
  readonly classify?: jest.Mock;
  readonly classification?: ChannelInboxDeps['classification'];
  readonly deps?: Partial<ChannelInboxDeps>;
  readonly tenant?: FakeTenant;
}

function setup(opts: SetupOptions = {}) {
  const tenant = opts.tenant ?? new FakeTenant();
  const { log, lines } = recordingLogger();
  const classify =
    opts.classify ?? jest.fn(async (_ctx: ClassifierContext): Promise<Classification> => invoice);
  const inbox = new ChannelInbox({
    mode: opts.mode ?? 'enforce',
    directory: { getSnapshot: async () => opts.snapshot ?? snapshotOf(opts.rows ?? [rowA]) },
    sharePointFactory: createSharePointWiring(tenant.client, wiringConfig).clientSharePointFactory,
    users: new UserTypeReader(tenant.client, noRetry),
    membership: new TeamMembershipReader(tenant.client, noRetry),
    classification: opts.classification ?? { classify },
    minAgeMs: 120_000,
    maxFilesPerTick: 20,
    maxDownloadBytes: 10 * 1024 * 1024,
    now: () => NOW,
    log,
    ...opts.deps,
  });
  const events = (name: string) => lines.filter((l) => l['event'] === name);
  const tickLine = () => events('inbox.tick').at(-1) as unknown as InboxTickSummary;
  return { tenant, inbox, lines, classify, events, tickLine };
}

// ---------------------------------------------------------------------------

describe('ChannelInbox: filing a client upload', () => {
  it("moves a guest's upload by id into its taxonomy folder inside the same channel folder", async () => {
    const { tenant, inbox, events } = setup();
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });

    const summary = await inbox.sweep();

    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/01_Faktury/02_Faktury_zakupu/2026/09/faktura.pdf`);
    expect(tenant.item(id).driveId).toBe('drive-a');
    expect(summary).toMatchObject({ mode: 'enforce', rows: 1, candidates: 1, filed: 1, failed: 0 });
    expect(events('inbox.filed')).toEqual([
      expect.objectContaining({
        clientId: '0011',
        listItemId: '11',
        teamId: TEAM_A,
        driveItemId: id,
        category: 'faktury_zakupu',
        nameSuffix: 0,
      }),
    ]);
  });

  it('creates the folder chain under the channel folder, never under the drive root', async () => {
    const { tenant, inbox } = setup();
    tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    await inbox.sweep();

    const folderPosts = tenant.writes().filter((c) => c.method === 'post');
    expect(folderPosts[0]?.path).toBe('/drives/drive-a/items/inbox-a/children');
    expect(folderPosts.map((c) => (c.body as { name: string }).name)).toEqual([
      '01_Faktury',
      '02_Faktury_zakupu',
      '2026',
      '09',
    ]);
    expect(tenant.writes().some((c) => c.path.includes('/items/root/'))).toBe(false);
  });

  it('moves with PATCH by id, If-Match on the listed eTag and conflictBehavior=fail, and never copies, uploads or deletes', async () => {
    const { tenant, inbox } = setup();
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    const listedETag = tenant.item(id).eTag;
    await inbox.sweep();

    const patches = tenant.writes().filter((c) => c.method === 'patch');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.path).toBe(`/drives/drive-a/items/${id}`);
    expect(patches[0]?.headers).toEqual({ 'If-Match': listedETag });
    expect(patches[0]?.query).toEqual({ '@microsoft.graph.conflictBehavior': 'fail' });
    expect(patches[0]?.body).toEqual({
      parentReference: { id: tenant.item(id).parentId },
      name: 'faktura.pdf',
    });
    const other = tenant.writes().filter((c) => c.method !== 'patch' && c.method !== 'post');
    expect(other).toEqual([]);
    expect(tenant.calls.some((c) => /copy/i.test(c.path))).toBe(false);
  });

  it('takes the next free _n name when the target folder already holds the name', async () => {
    const tenant = new FakeTenant();
    const folder = tenant.addFolder('drive-a', 'inbox-a', '04_Umowy');
    const existing = tenant.addFile(folder, { name: 'umowa.pdf', createdBy: STAFF });
    const id = tenant.addFile('inbox-a', { name: 'umowa.pdf' });
    const { inbox, events } = setup({
      tenant,
      classify: jest.fn(async () => ({ ...invoice, fields: { category: 'umowy' } })),
    });

    await inbox.sweep();

    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/04_Umowy/umowa_1.pdf`);
    expect(tenant.pathOf(existing)).toBe(`${CHANNEL}/04_Umowy/umowa.pdf`);
    expect(events('inbox.filed')[0]).toMatchObject({ driveItemId: id, nameSuffix: 1 });
    const names = tenant
      .writes()
      .filter((c) => c.method === 'patch')
      .map((c) => (c.body as { name: string }).name);
    expect(names).toEqual(['umowa.pdf', 'umowa_1.pdf']);
  });

  it('logs nameSuffix for a renamed move', async () => {
    const tenant = new FakeTenant();
    const folder = tenant.addFolder('drive-a', 'inbox-a', '04_Umowy');
    tenant.addFile(folder, { name: 'umowa.pdf', createdBy: STAFF });
    tenant.addFile(folder, { name: 'umowa_1.pdf', createdBy: STAFF });
    const id = tenant.addFile('inbox-a', { name: 'umowa.pdf' });
    const { inbox, events } = setup({
      tenant,
      classify: jest.fn(async () => ({ ...invoice, fields: { category: 'umowy' } })),
    });

    await inbox.sweep();

    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/04_Umowy/umowa_2.pdf`);
    expect(events('inbox.filed')[0]).toMatchObject({ driveItemId: id, nameSuffix: 2 });
  });

  it('primes the classifier with this row’s client identity only, and flips direction from its NIP', async () => {
    const { tenant, inbox, classify } = setup({
      classify: jest.fn(async () => ({
        ...invoice,
        parties: [
          { role: 'seller', nip: NIP_A },
          { role: 'buyer', nip: '2222222222' },
        ],
      })),
    });
    const id = tenant.addFile('inbox-a', { name: 'fv.pdf' });

    await inbox.sweep();

    const ctx = classify.mock.calls[0]?.[0] as ClassifierContext;
    expect(ctx.client).toEqual({ nip: NIP_A, companyName: 'Client 11 Sp. z o.o.' });
    expect(ctx.contentType).toBe('application/pdf');
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/01_Faktury/01_Faktury_sprzedaży/2026/09/fv.pdf`);
  });

  it('builds the folder from the category alone, never from the model’s folder path', async () => {
    const { tenant, inbox } = setup({
      classify: jest.fn(async () => ({
        ...invoice,
        folderPath: '../../Other Client/Shared Documents',
        fields: { category: 'umowy' },
      })),
    });
    const id = tenant.addFile('inbox-a', { name: 'umowa.pdf' });
    await inbox.sweep();
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/04_Umowy/umowa.pdf`);
  });

  it('files the upload of a guest who is also in another Team within this row’s channel', async () => {
    const { tenant, inbox } = setup({ rows: [rowA, rowB] });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf', createdBy: GUEST_AB });

    await inbox.sweep();

    expect(tenant.item(id).driveId).toBe('drive-a');
    expect(tenant.pathOf(id).startsWith(`${CHANNEL}/01_Faktury/`)).toBe(true);
    expect(tenant.writes().some((c) => c.path.includes('drive-b'))).toBe(false);
  });

  it('reads the file by id, only when the classifier asks for it', async () => {
    const { tenant, inbox } = setup({
      classification: new ClassificationService([contentReadingClassifier(invoice)]),
    });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    await inbox.sweep();
    expect(tenant.calls.filter((c) => c.method === 'stream').map((c) => c.path)).toEqual([
      `/drives/drive-a/items/${id}/content`,
    ]);

    const fallbackOnly = setup();
    fallbackOnly.tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    await fallbackOnly.inbox.sweep();
    expect(fallbackOnly.tenant.calls.some((c) => c.method === 'stream')).toBe(false);
  });
});

describe('ChannelInbox: what is never touched', () => {
  it('never touches a file in a subfolder, and never lists below the channel folder', async () => {
    const { tenant, inbox, classify } = setup();
    const filed = tenant.addFolder('drive-a', 'inbox-a', '01_Faktury');
    const inSub = tenant.addFile(filed, { name: 'stara.pdf' });

    const summary = await inbox.sweep();

    expect(tenant.pathOf(inSub)).toBe(`${CHANNEL}/01_Faktury/stara.pdf`);
    expect(tenant.writes()).toEqual([]);
    expect(classify).not.toHaveBeenCalled();
    const listings = tenant.calls.filter((c) => c.path.includes('/children'));
    expect(listings.map((c) => c.path.split('?')[0])).toEqual([
      '/drives/drive-a/items/inbox-a/children',
    ]);
    expect(summary.candidates).toBe(0);
  });

  it('never touches a file at the drive root or in another drive', async () => {
    const { tenant, inbox } = setup({ rows: [rowA] });
    const atRoot = tenant.addFile('root-drive-a', { name: 'root.pdf' });
    const inB = tenant.addFile('inbox-b', { name: 'b.pdf', createdBy: GUEST_A });

    await inbox.sweep();

    expect(tenant.pathOf(atRoot)).toBe('root.pdf');
    expect(tenant.pathOf(inB)).toBe(`${CHANNEL}/b.pdf`);
    expect(tenant.writes()).toEqual([]);
  });

  it('drops a listed child whose parent or drive is not the channel folder', async () => {
    const { tenant, inbox } = setup();
    const elsewhere = tenant.addFile('root-drive-a', { name: 'elsewhere.pdf' });
    // Graph returning an item that is not a direct child must not make it one.
    tenant.overrides.push([
      /^GET \/drives\/drive-a\/items\/inbox-a\/children/,
      (_call, next) => {
        const page = next() as { value: unknown[] };
        const foreign = {
          id: elsewhere,
          name: 'elsewhere.pdf',
          file: { mimeType: 'application/pdf' },
          size: 10,
          eTag: 'x',
          createdBy: { user: { id: GUEST_A } },
          lastModifiedDateTime: OLD,
          parentReference: { driveId: 'drive-b', id: 'inbox-a' },
        };
        return { value: [...page.value, foreign] };
      },
    ]);

    const summary = await inbox.sweep();

    expect(summary.candidates).toBe(0);
    expect(tenant.writes()).toEqual([]);
    expect(tenant.pathOf(elsewhere)).toBe('elsewhere.pdf');
  });

  it.each([
    ['a staff member', STAFF],
    ['a guest of another Team', GUEST_B],
    ['a user who no longer exists', DELETED],
  ])('leaves the upload of %s untouched and unclassified', async (_label, creator) => {
    const { tenant, inbox, classify, events } = setup({ rows: [rowA, rowB] });
    const id = tenant.addFile('inbox-a', { name: 'x.pdf', createdBy: creator });

    const summary = await inbox.sweep();

    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/x.pdf`);
    expect(tenant.writes()).toEqual([]);
    expect(classify).not.toHaveBeenCalled();
    expect(summary.skippedNotClient).toBe(1);
    expect(events('inbox.skipped')).toEqual([
      expect.objectContaining({ listItemId: '11', driveItemId: id }),
    ]);
  });

  // createdBy survives a "Replace": staff dropping a same-named file over a
  // guest's upload leaves the guest as creator and staff's content inside.
  it('leaves a guest’s file that staff replaced: not classified, not read, not moved', async () => {
    const { tenant, inbox, classify, events } = setup({
      classification: new ClassificationService([contentReadingClassifier(invoice)]),
    });
    const id = tenant.addFile('inbox-a', {
      name: 'skan.pdf',
      createdBy: GUEST_A,
      modifiedBy: STAFF,
    });
    const spy = jest.spyOn(ClassificationService.prototype, 'classify');

    const summary = await inbox.sweep();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(classify).not.toHaveBeenCalled();
    expect(tenant.calls.some((c) => c.method === 'stream')).toBe(false);
    expect(tenant.writes()).toEqual([]);
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/skan.pdf`);
    expect(summary.skippedNotClient).toBe(1);
    expect(events('inbox.skipped')).toEqual([
      expect.objectContaining({ driveItemId: id, reason: 'modified_by_other' }),
    ]);
  });

  it.each([
    ['a guest of another Team', GUEST_B],
    ['no user (an application)', null],
    ['a user who no longer exists', DELETED],
  ])('leaves a guest’s file last changed by %s', async (_label, modifier) => {
    const { tenant, inbox, events } = setup({ rows: [rowA, rowB] });
    const id = tenant.addFile('inbox-a', {
      name: 'x.pdf',
      createdBy: GUEST_A,
      modifiedBy: modifier,
    });

    await inbox.sweep();

    expect(tenant.writes()).toEqual([]);
    expect(events('inbox.skipped')[0]).toMatchObject({
      driveItemId: id,
      reason: 'modified_by_other',
    });
  });

  it('files a guest’s file that another guest of the same Team changed', async () => {
    const { tenant, inbox } = setup();
    const id = tenant.addFile('inbox-a', {
      name: 'x.pdf',
      createdBy: GUEST_A,
      modifiedBy: GUEST_AB,
    });
    await inbox.sweep();
    expect(tenant.pathOf(id)).toContain('/01_Faktury/');
  });

  it('waits when the last modifier cannot be read', async () => {
    const { tenant, inbox, events } = setup();
    const id = tenant.addFile('inbox-a', {
      name: 'x.pdf',
      createdBy: GUEST_A,
      modifiedBy: GUEST_AB,
    });
    tenant.overrides.push([
      new RegExp(`^GET /users/${GUEST_AB}\\?`),
      () => {
        throw graphError(503);
      },
    ]);

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ skippedUnverified: 1, skippedNotClient: 0 });
    expect(tenant.writes()).toEqual([]);
    expect(events('inbox.skipped')[0]).toMatchObject({ driveItemId: id, reason: 'unverified' });
  });

  it('logs a skipped file once per worker, however many ticks see it', async () => {
    const { tenant, inbox, events } = setup();
    tenant.addFile('inbox-a', { name: 'x.pdf', createdBy: STAFF });
    await inbox.sweep();
    await inbox.sweep();
    expect(events('inbox.skipped')).toHaveLength(1);
    expect(events('inbox.tick').map((t) => t['skippedNotClient'])).toEqual([1, 1]);
  });

  it('leaves a file whose uploader cannot be read, and reads again next tick', async () => {
    const { tenant, inbox } = setup();
    const id = tenant.addFile('inbox-a', { name: 'x.pdf' });
    let failing = true;
    tenant.overrides.push([
      /^GET \/users\/[^/]+\?\$select=userType$/,
      (_c, next) => {
        if (failing) throw graphError(503);
        return next();
      },
    ]);

    const first = await inbox.sweep();
    expect(first).toMatchObject({ skippedUnverified: 1, failed: 0, filed: 0 });
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/x.pdf`);

    failing = false;
    const second = await inbox.sweep();
    expect(second).toMatchObject({ skippedUnverified: 0, filed: 1 });
  });

  it("leaves a guest's file whose Teams cannot be read, and says Graph's status", async () => {
    const { tenant, inbox, events } = setup();
    const id = tenant.addFile('inbox-a', { name: 'x.pdf' });
    tenant.overrides.push([
      /memberOf/,
      () => {
        throw graphError(403);
      },
    ]);

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ skippedUnverified: 1, failed: 0 });
    expect(tenant.writes()).toEqual([]);
    expect(events('inbox.skipped')[0]).toMatchObject({
      driveItemId: id,
      reason: 'unverified',
      status: 403,
    });
  });

  it('skips files still young, empty, oversized, lock or hidden files, folders, and files with no user creator', async () => {
    const { tenant, inbox, classify } = setup();
    tenant.addFile('inbox-a', { name: 'young.pdf', lastModifiedDateTime: YOUNG });
    tenant.addFile('inbox-a', { name: 'empty.pdf', content: Buffer.alloc(0) });
    tenant.addFile('inbox-a', { name: 'big.pdf', size: 100 * 1024 * 1024 + 1 });
    tenant.addFile('inbox-a', { name: '~$faktura.docx' });
    tenant.addFile('inbox-a', { name: '.hidden' });
    tenant.addFolder('drive-a', 'inbox-a', 'Nowy folder');
    const byApp = tenant.addFile('inbox-a', { name: 'app.pdf' });
    delete tenant.item(byApp).createdBy;

    const summary = await inbox.sweep();

    expect(tenant.writes()).toEqual([]);
    expect(classify).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      candidates: 0,
      skippedYoung: 1,
      skippedIneligible: 4,
      skippedNotClient: 1,
    });
  });

  it('follows @odata.nextLink through every page of the channel folder', async () => {
    const tenant = new FakeTenant();
    tenant.pageSize = 2;
    const ids = [1, 2, 3, 4, 5].map((n) => tenant.addFile('inbox-a', { name: `f${n}.pdf` }));
    const { inbox } = setup({ tenant });

    const summary = await inbox.sweep();

    expect(summary.candidates).toBe(5);
    for (const id of ids) expect(tenant.pathOf(id)).toContain('/01_Faktury/');
  });
});

// The listing is minutes old by the time a later file is moved. A person may
// have filed it by hand, or staff may have moved it out of the channel (for
// example a document of another client, posted by a guest in both Teams)
// meanwhile. The id survives any move within the library; the eTag does not.
describe('ChannelInbox: it acts only on the version it listed', () => {
  it.each([
    ['moved into a sibling channel’s staff-only folder', 'staff-only'],
    ['filed by hand into a subfolder of the channel', 'manual-subfolder'],
  ])('never pulls back a file %s after the listing, and writes nothing', async (_label, where) => {
    const tenant = new FakeTenant();
    const general = tenant.addFolder('drive-a', 'root-drive-a', 'General');
    const staffOnly = tenant.addFolder('drive-a', general, 'Staff only');
    const manual = tenant.addFolder('drive-a', 'inbox-a', 'Ręcznie');
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf', createdBy: GUEST_AB });
    const destination = where === 'staff-only' ? staffOnly : manual;
    const { inbox, events, classify } = setup({
      tenant,
      classify: jest.fn(async () => {
        // Someone moves it while the sweep is classifying it.
        tenant.relocate(id, destination);
        return invoice;
      }),
    });

    const summary = await inbox.sweep();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(tenant.item(id).parentId).toBe(destination);
    expect(tenant.calls.filter((c) => c.method === 'patch')).toEqual([]);
    expect(events('inbox.filed')).toEqual([]);
    expect(events('inbox.failed')).toEqual([]);
    expect(summary).toMatchObject({ filed: 0, failed: 0, skippedChanged: 1 });
    expect(events('inbox.skipped')).toEqual([
      expect.objectContaining({ driveItemId: id, reason: 'changed' }),
    ]);
  });

  it('never downloads or classifies a file that left the inbox after the listing', async () => {
    const tenant = new FakeTenant();
    const staffOnly = tenant.addFolder('drive-a', 'root-drive-a', 'Staff only');
    const id = tenant.addFile('inbox-a', { name: 'b-doc.pdf' });
    tenant.overrides.push([
      /^GET \/drives\/drive-a\/items\/inbox-a\/children/,
      (_c, next) => {
        const page = next();
        tenant.relocate(id, staffOnly);
        return page;
      },
    ]);
    const { inbox, classify } = setup({
      tenant,
      classification: new ClassificationService([contentReadingClassifier(invoice)]),
    });
    const spy = jest.spyOn(ClassificationService.prototype, 'classify');

    const summary = await inbox.sweep();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(classify).not.toHaveBeenCalled();
    expect(tenant.calls.some((c) => c.method === 'stream')).toBe(false);
    expect(tenant.writes()).toEqual([]);
    expect(summary.skippedChanged).toBe(1);
  });

  it('does not rename back a file renamed after the listing', async () => {
    const tenant = new FakeTenant();
    const id = tenant.addFile('inbox-a', { name: 'skan.pdf' });
    const { inbox } = setup({
      tenant,
      classify: jest.fn(async () => {
        tenant.relocate(id, 'inbox-a', 'faktura-wrzesien.pdf');
        return invoice;
      }),
    });

    await inbox.sweep();

    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/faktura-wrzesien.pdf`);
    expect(tenant.writes().filter((c) => c.method === 'patch')).toEqual([]);
  });

  it('does not file a file by its old content once it has been replaced; the next tick reads it again', async () => {
    const tenant = new FakeTenant();
    const id = tenant.addFile('inbox-a', { name: 'skan.pdf' });
    let replaced = false;
    const classify = jest.fn(async () => {
      if (!replaced) {
        replaced = true;
        tenant.item(id).eTag = '"replaced by the guest"';
      }
      return invoice;
    });
    const { inbox } = setup({ tenant, classify });

    const first = await inbox.sweep();
    expect(first).toMatchObject({ filed: 0, skippedChanged: 1, failed: 0 });
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/skan.pdf`);

    const second = await inbox.sweep();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(second.filed).toBe(1);
  });

  it('reads a 412 on the move as changed, and never counts it towards the review fallback', async () => {
    const { tenant, inbox, events } = setup({ deps: { maxAttempts: 1 } });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    tenant.overrides.push([
      /^PATCH /,
      () => {
        throw graphError(412);
      },
    ]);

    const ticks = [await inbox.sweep(), await inbox.sweep()];

    expect(ticks.map((t) => [t.failed, t.skippedChanged, t.sortedToReview])).toEqual([
      [0, 1, 0],
      [0, 1, 0],
    ]);
    expect(events('inbox.failed')).toEqual([]);
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/faktura.pdf`);
  });

  it('holds the review fallback to the listed version too', async () => {
    const tenant = new FakeTenant();
    const elsewhere = tenant.addFolder('drive-a', 'root-drive-a', 'Staff only');
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    const { inbox, events } = setup({ tenant, deps: { maxAttempts: 1 } });
    tenant.overrides.push([
      /^POST \/drives\/drive-a\/items\/inbox-a\/children$/,
      (call, next) => {
        const { name } = call.body as { name: string };
        if (name === '01_Faktury') throw graphError(400);
        // The fallback's folder is being created: someone moves the file now.
        if (name === '98_Nieposortowane') tenant.relocate(id, elsewhere);
        return next();
      },
    ]);

    const summary = await inbox.sweep();

    expect(tenant.item(id).parentId).toBe(elsewhere);
    expect(tenant.calls.filter((c) => c.method === 'patch')).toEqual([]);
    expect(summary).toMatchObject({ failed: 1, skippedChanged: 1, sortedToReview: 0 });
    expect(events('inbox.failed').map((l) => l['stage'])).toEqual(['folder']);
  });
});

describe('ChannelInbox: which rows are swept', () => {
  it('sweeps only bound, routed client rows', async () => {
    const rows = [
      rowA,
      clientRow('20', '/sites/ClientC', { driveId: null }),
      clientRow('21', '/sites/ClientD', { teamId: null }),
      clientRow('22', '/sites/ClientE', { rootFolder: null }),
      clientRow('23', '/sites/BCRGROUP', { driveId: 'drive-g' }),
      clientRow('24', '/sites/Kwarantanna'),
      clientRow('25', '/sites/ClientF', { driveId: 'drive-f', isAdmin: true }),
      { ...clientRow('26', '/sites/ClientB', { teamId: TEAM_B }), active: false },
    ];
    const { tenant, inbox } = setup({ rows });
    tenant.addFile('inbox-b', { name: 'b.pdf', createdBy: GUEST_B });

    const summary = await inbox.sweep();

    expect(summary.rows).toBe(1);
    const elsewhere = tenant.calls.filter((c) =>
      /Client[B-F]|BCRGROUP|drive-[bgq]|inbox-[bgq]/.test(c.path),
    );
    expect(elsewhere).toEqual([]);
  });

  it('sweeps neither of two rows in conflict over one site', async () => {
    const rows = [
      clientRow('30', '/sites/ClientA', { teamId: TEAM_A }),
      clientRow('31', '/sites/ClientA', { teamId: TEAM_B, driveId: 'drive-other' }),
    ];
    const { tenant, inbox } = setup({ rows });
    tenant.addFile('inbox-a', { name: 'a.pdf' });

    const summary = await inbox.sweep();

    expect(summary.rows).toBe(0);
    expect(tenant.calls).toEqual([]);
  });

  it('with INBOX_SWEEP_ROWS, sweeps only the listed rows, and never another client’s channel', async () => {
    const { tenant, inbox } = setup({ rows: [rowA, rowB], deps: { onlyRows: ['12'] } });
    tenant.addFile('inbox-a', { name: 'a.pdf' });
    const inB = tenant.addFile('inbox-b', { name: 'b.pdf', createdBy: GUEST_B });

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ rows: 1, filed: 1 });
    expect(tenant.pathOf(inB)).toContain('/01_Faktury/');
    expect(tenant.calls.filter((c) => /ClientA|drive-a|inbox-a/.test(c.path))).toEqual([]);
  });

  it('never sweeps a listed row the directory does not route to', async () => {
    const unbound = clientRow('20', '/sites/ClientB', { driveId: null, teamId: TEAM_B });
    const { tenant, inbox } = setup({ rows: [rowA, unbound], deps: { onlyRows: ['20'] } });
    tenant.addFile('inbox-b', { name: 'b.pdf', createdBy: GUEST_B });

    const summary = await inbox.sweep();

    expect(summary.rows).toBe(0);
    expect(tenant.calls).toEqual([]);
  });

  it('with an empty INBOX_SWEEP_ROWS, sweeps every routed row', async () => {
    const { inbox } = setup({ rows: [rowA, rowB], deps: { onlyRows: [] } });
    expect((await inbox.sweep()).rows).toBe(2);
  });

  it('with INBOX_CREATED_AFTER, leaves files created before it where they are', async () => {
    const { tenant, inbox, classify } = setup({
      deps: { createdAfterMs: Date.parse('2026-09-26T09:00:00Z') },
    });
    const old = tenant.addFile('inbox-a', {
      name: 'old.pdf',
      createdDateTime: '2026-08-01T10:00:00Z',
    });
    const fresh = tenant.addFile('inbox-a', {
      name: 'new.pdf',
      createdDateTime: '2026-09-26T09:30:00Z',
    });

    const summary = await inbox.sweep();

    expect(tenant.pathOf(old)).toBe(`${CHANNEL}/old.pdf`);
    expect(tenant.pathOf(fresh)).toContain('/01_Faktury/');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ candidates: 1, skippedBeforeCutoff: 1, filed: 1 });
  });

  it('sweeps nothing on an unavailable directory', async () => {
    const unavailable: ClientDirectorySnapshot = { ...snapshotOf([rowA]), health: 'unavailable' };
    const { tenant, inbox, events } = setup({ snapshot: unavailable });
    tenant.addFile('inbox-a', { name: 'a.pdf' });

    const summary = await inbox.sweep();

    expect(summary.rows).toBe(0);
    expect(tenant.calls).toEqual([]);
    expect(events('inbox.directory_unavailable')).toHaveLength(1);
  });

  it.each([
    ['BCR GROUP', '/sites/AlsoLooksLikeAClient'],
    ['the quarantine', '/sites/LooksLikeAClient'],
  ])(
    'refuses a row whose site resolves to %s, before listing or writing anything there',
    async (_label, sitePath) => {
      const row = clientRow('40', sitePath, { teamId: TEAM_A });
      const tenant = new FakeTenant();
      const inboxId = SITES[sitePath]?.drive === 'drive-g' ? 'inbox-g' : 'inbox-q';
      tenant.addFile(inboxId, { name: 'x.pdf' });
      const { inbox, events } = setup({ tenant, rows: [row] });

      const summary = await inbox.sweep();

      expect(summary).toMatchObject({ rows: 1, rowsFailed: 1, candidates: 0 });
      expect(events('inbox.row_failed')[0]).toMatchObject({
        listItemId: '40',
        stage: 'resolve',
        err: expect.objectContaining({ targetErrorKind: 'forbidden_site' }),
      });
      expect(tenant.calls.some((c) => c.path.includes('/children'))).toBe(false);
      expect(tenant.writes()).toEqual([]);
    },
  );

  it('refuses a channel folder that is not in the recorded drive', async () => {
    const row = clientRow('41', '/sites/ClientA', { teamId: TEAM_A, driveId: 'drive-recorded' });
    const { tenant, inbox, events } = setup({ rows: [row] });
    tenant.addFile('inbox-a', { name: 'x.pdf' });

    await inbox.sweep();

    expect(events('inbox.row_failed')[0]).toMatchObject({
      err: expect.objectContaining({ targetErrorKind: 'drive_mismatch' }),
    });
    expect(tenant.writes()).toEqual([]);
  });

  it('goes on with the other rows when one row fails', async () => {
    const rows = [rowA, clientRow('50', '/sites/Gone', { teamId: TEAM_B, driveId: 'drive-x' })];
    const { tenant, inbox } = setup({ rows });
    const id = tenant.addFile('inbox-a', { name: 'a.pdf' });

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ rows: 2, rowsFailed: 1, filed: 1 });
    expect(tenant.pathOf(id)).toContain('/01_Faktury/');
  });
});

describe('ChannelInbox: modes', () => {
  it('shadow classifies and logs what it would move, and writes nothing', async () => {
    const { tenant, inbox, classify, events } = setup({ mode: 'shadow' });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });

    const summary = await inbox.sweep();

    expect(tenant.writes()).toEqual([]);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/faktura.pdf`);
    expect(summary).toMatchObject({ mode: 'shadow', wouldMove: 1, filed: 0 });
    expect(events('inbox.would_move')).toEqual([
      expect.objectContaining({
        clientId: '0011',
        listItemId: '11',
        teamId: TEAM_A,
        driveItemId: id,
        category: 'faktury_zakupu',
        review: false,
      }),
    ]);
  });

  it('shadow logs the move to 98_ that three failures would make, and still writes nothing', async () => {
    const { tenant, inbox, events } = setup({
      mode: 'shadow',
      classify: jest.fn(async () => {
        throw new Error('no classifier result');
      }),
    });
    const id = tenant.addFile('inbox-a', { name: 'x.pdf' });

    await inbox.sweep();
    await inbox.sweep();
    const third = await inbox.sweep();

    expect(third).toMatchObject({ failed: 1, wouldMove: 1 });
    expect(events('inbox.would_move')).toEqual([
      expect.objectContaining({ driveItemId: id, review: true, unclassified: true }),
    ]);
    expect(tenant.writes()).toEqual([]);
  });

  it('ends a tick that fails unexpectedly with one line, and runs the next', async () => {
    let fail = true;
    const tenant = new FakeTenant();
    const { log, lines } = recordingLogger();
    const inbox = new ChannelInbox({
      mode: 'enforce',
      directory: {
        getSnapshot: async () => {
          if (fail) throw new Error('boom');
          return snapshotOf([rowA]);
        },
      },
      sharePointFactory: createSharePointWiring(tenant.client, wiringConfig)
        .clientSharePointFactory,
      users: new UserTypeReader(tenant.client, noRetry),
      membership: new TeamMembershipReader(tenant.client, noRetry),
      classification: { classify: async () => invoice },
      minAgeMs: 0,
      maxFilesPerTick: 20,
      maxDownloadBytes: 1024,
      now: () => NOW,
      log,
    });
    tenant.addFile('inbox-a', { name: 'a.pdf' });

    await inbox.sweep();
    expect(lines.filter((l) => l['event'] === 'inbox.tick_failed')).toEqual([
      expect.objectContaining({ err: { name: 'Error' } }),
    ]);

    fail = false;
    expect((await inbox.sweep()).filed).toBe(1);
  });

  it('off makes no call and logs nothing', async () => {
    const { tenant, inbox, lines } = setup({ mode: 'off' });
    tenant.addFile('inbox-a', { name: 'a.pdf' });
    const summary = await inbox.sweep();
    expect(summary.mode).toBe('off');
    expect(tenant.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('does not start a tick while the last one is still running', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { tenant, inbox, events } = setup({
      classify: jest.fn(async () => {
        await gate;
        return invoice;
      }),
    });
    tenant.addFile('inbox-a', { name: 'a.pdf' });

    const first = inbox.sweep();
    await new Promise((r) => setImmediate(r));
    const second = await inbox.sweep();
    release();
    await first;

    expect(second.filed).toBe(0);
    expect(events('inbox.tick_overlap')).toHaveLength(1);
    expect(events('inbox.tick')).toHaveLength(1);
  });
});

describe('ChannelInbox: manual review and failures', () => {
  it('sends a file the classifier cannot place to 98_Nieposortowane/YYYY/MM inside the channel', async () => {
    const failing: Classifier = {
      name: 'claude',
      classify: async () => {
        throw new Error('model down');
      },
    };
    const { tenant, inbox, events } = setup({
      classification: new ClassificationService([failing, new FallbackClassifier()]),
    });
    const id = tenant.addFile('inbox-a', { name: 'skan.pdf' });

    const summary = await inbox.sweep();

    // The sweep's own month, whatever month the fallback classifier read.
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/98_Nieposortowane/2026/09/skan.pdf`);
    expect(summary).toMatchObject({ sortedToReview: 1, filed: 0 });
    expect(events('inbox.sorted_to_review')[0]).toMatchObject({
      driveItemId: id,
      category: 'nieposortowane',
    });
  });

  it('sends a file too big for the classifier to manual review without reading it whole', async () => {
    const { tenant, inbox } = setup({
      classification: new ClassificationService([
        contentReadingClassifier(invoice),
        new FallbackClassifier(),
      ]),
      deps: { maxDownloadBytes: 8 },
    });
    const id = tenant.addFile('inbox-a', { name: 'duzy.pdf', content: Buffer.alloc(64, 1) });

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ sortedToReview: 1, failed: 0 });
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/98_Nieposortowane/2026/09/duzy.pdf`);
  });

  it('counts a failed download as a failed attempt and leaves the file for the next tick', async () => {
    const { tenant, inbox, events } = setup({
      classification: new ClassificationService([
        contentReadingClassifier(invoice),
        new FallbackClassifier(),
      ]),
    });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    let failing = true;
    tenant.overrides.push([
      /^STREAM /,
      (_c, next) => {
        if (failing) throw graphError(404);
        return next();
      },
    ]);

    const first = await inbox.sweep();
    expect(first).toMatchObject({ failed: 1, sortedToReview: 0, filed: 0 });
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/faktura.pdf`);
    expect(events('inbox.failed')[0]).toMatchObject({
      driveItemId: id,
      stage: 'download',
      attempt: 1,
    });

    failing = false;
    const second = await inbox.sweep();
    expect(second.filed).toBe(1);
    expect(tenant.pathOf(id)).toContain('/01_Faktury/02_Faktury_zakupu/');
  });

  it('after three failed attempts moves the file to 98_ unclassified, classifying it only once', async () => {
    const { tenant, inbox, classify, events } = setup();
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    tenant.overrides.push([
      /^POST \/drives\/drive-a\/items\/inbox-a\/children$/,
      (call, next) => {
        if ((call.body as { name: string }).name === '01_Faktury') throw graphError(400);
        return next();
      },
    ]);

    const ticks = [await inbox.sweep(), await inbox.sweep(), await inbox.sweep()];

    expect(ticks.map((t) => t.failed)).toEqual([1, 1, 1]);
    expect(ticks.map((t) => t.sortedToReview)).toEqual([0, 0, 1]);
    expect(events('inbox.failed').map((l) => [l['stage'], l['attempt']])).toEqual([
      ['folder', 1],
      ['folder', 2],
      ['folder', 3],
    ]);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/98_Nieposortowane/2026/09/faktura.pdf`);
    expect(events('inbox.sorted_to_review')[0]).toMatchObject({
      driveItemId: id,
      category: 'nieposortowane',
      unclassified: true,
    });
  });

  it('leaves the file and logs it when even the move to 98_ fails', async () => {
    const { tenant, inbox, events } = setup({ deps: { maxAttempts: 1 } });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    tenant.overrides.push([
      /^PATCH /,
      () => {
        throw graphError(400);
      },
    ]);

    const first = await inbox.sweep();
    expect(first.failed).toBe(1);
    expect(events('inbox.failed').map((l) => l['stage'])).toEqual(['move', 'review_fallback']);
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/faktura.pdf`);

    // Later ticks go straight to the 98_ move, and log it again.
    const second = await inbox.sweep();
    expect(second.failed).toBe(1);
    expect(events('inbox.failed').at(-1)).toMatchObject({ stage: 'review_fallback' });
  });

  it('refuses a move that Graph reports in another drive or folder', async () => {
    const { tenant, inbox, events } = setup();
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });
    tenant.overrides.push([
      /^PATCH /,
      (_c, next) => ({ ...(next() as object), parentReference: { driveId: 'drive-b', id: 'x' } }),
    ]);

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ filed: 0, failed: 1 });
    expect(events('inbox.failed')[0]).toMatchObject({
      driveItemId: id,
      stage: 'move',
      err: expect.objectContaining({ targetErrorKind: 'drive_mismatch' }),
    });
  });

  it('reuses a classification while the eTag is unchanged, and classifies again when it changes', async () => {
    const { tenant, inbox, classify } = setup({ mode: 'shadow' });
    const id = tenant.addFile('inbox-a', { name: 'faktura.pdf' });

    await inbox.sweep();
    await inbox.sweep();
    expect(classify).toHaveBeenCalledTimes(1);

    tenant.item(id).eTag = '"changed"';
    await inbox.sweep();
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('classifies again once the cached classification is an hour old', async () => {
    let now = NOW;
    const { tenant, inbox, classify } = setup({ mode: 'shadow', deps: { now: () => now } });
    tenant.addFile('inbox-a', { name: 'faktura.pdf' });

    await inbox.sweep();
    now = new Date(NOW.getTime() + 60 * 60 * 1000);
    await inbox.sweep();

    expect(classify).toHaveBeenCalledTimes(2);
  });
});

describe('ChannelInbox: budget and deadline', () => {
  it('takes at most INBOX_MAX_FILES_PER_TICK files a tick; the rest wait', async () => {
    const { tenant, inbox } = setup({ deps: { maxFilesPerTick: 2 } });
    const ids = ['a', 'b', 'c'].map((n) => tenant.addFile('inbox-a', { name: `${n}.pdf` }));

    const first = await inbox.sweep();
    expect(first).toMatchObject({ filed: 2, deferred: 1 });
    expect(ids.filter((id) => tenant.pathOf(id).includes('/01_Faktury/'))).toHaveLength(2);

    const second = await inbox.sweep();
    expect(second).toMatchObject({ filed: 1, deferred: 0 });
  });

  it('starts nothing after the tick deadline', async () => {
    let now = NOW.getTime();
    const { tenant, inbox } = setup({
      deps: { now: () => new Date(now), tickDeadlineMs: 150_000 },
      classify: jest.fn(async () => {
        now += 100_000;
        return invoice;
      }),
    });
    ['a', 'b', 'c'].forEach((n) => tenant.addFile('inbox-a', { name: `${n}.pdf` }));

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ filed: 2, deferred: 1 });
  });

  // A file started just before the deadline must not run the tick past the
  // host's functionTimeout: that restarts the worker, and every upload on it.
  it('does not start classifying a file without the time for it; the file waits, not failed', async () => {
    let now = NOW.getTime();
    const { tenant, inbox, classify, events } = setup({
      deps: { now: () => new Date(now) },
    });
    const id = tenant.addFile('inbox-a', { name: 'a.pdf' });
    tenant.overrides.push([
      /^GET \/users\/[^/]+\?\$select=userType$/,
      (_c, next) => {
        // A slow uploader read: 160 s in, 110 s are left, under the reserve.
        now = NOW.getTime() + INBOX_TICK_HARD_LIMIT_MS - CLASSIFY_RESERVE_MS + 10_000;
        return next();
      },
    ]);

    const summary = await inbox.sweep();

    expect(classify).not.toHaveBeenCalled();
    expect(tenant.calls.some((c) => /\/items\/item-\d+\?/.test(c.path))).toBe(false);
    expect(summary).toMatchObject({ deferred: 1, failed: 0, filed: 0 });
    expect(events('inbox.failed')).toEqual([]);
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/a.pdf`);
  });

  it('does not start the writes of a file classified too late; the next tick moves it without classifying again', async () => {
    let now = NOW.getTime();
    let slow = true;
    const { tenant, inbox, classify } = setup({
      deps: { now: () => new Date(now) },
      classify: jest.fn(async () => {
        if (slow) now += INBOX_TICK_HARD_LIMIT_MS - WRITE_RESERVE_MS + 1;
        return invoice;
      }),
    });
    const id = tenant.addFile('inbox-a', { name: 'a.pdf' });

    const first = await inbox.sweep();
    expect(first).toMatchObject({ deferred: 1, failed: 0, filed: 0 });
    expect(tenant.writes()).toEqual([]);

    slow = false;
    const second = await inbox.sweep();
    expect(second.filed).toBe(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(tenant.pathOf(id)).toContain('/01_Faktury/');
  });

  it('does not start the review fallback’s writes without the time for them', async () => {
    let now = NOW.getTime();
    const { tenant, inbox, events } = setup({
      deps: { now: () => new Date(now), maxAttempts: 1 },
    });
    tenant.addFile('inbox-a', { name: 'a.pdf' });
    tenant.overrides.push([
      /^POST \/drives\/drive-a\/items\/inbox-a\/children$/,
      (call, next) => {
        if ((call.body as { name: string }).name !== '01_Faktury') return next();
        now += INBOX_TICK_HARD_LIMIT_MS;
        throw graphError(400);
      },
    ]);

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ failed: 1, deferred: 0, sortedToReview: 0 });
    expect(events('inbox.failed').map((l) => l['stage'])).toEqual(['folder']);
    expect(tenant.writes().filter((c) => c.method === 'patch')).toEqual([]);
  });

  it('defers a file already failed three times when the tick has no time for its move', async () => {
    let now = NOW.getTime();
    let slowRead = false;
    const { tenant, inbox } = setup({
      deps: {
        now: () => new Date(now),
        maxAttempts: 1,
        users: {
          userTypeOf: async () => {
            if (slowRead) now += INBOX_TICK_HARD_LIMIT_MS - WRITE_RESERVE_MS + 1;
            return 'Guest';
          },
        },
      },
    });
    const id = tenant.addFile('inbox-a', { name: 'a.pdf' });
    tenant.overrides.push([
      /^PATCH /,
      () => {
        throw graphError(400);
      },
    ]);
    await inbox.sweep();
    tenant.overrides.length = 0;
    slowRead = true;

    const summary = await inbox.sweep();

    expect(summary).toMatchObject({ deferred: 1, failed: 0, sortedToReview: 0 });
    expect(tenant.pathOf(id)).toBe(`${CHANNEL}/a.pdf`);
  });

  it('does not let one row with a backlog starve the others', async () => {
    const { tenant, inbox } = setup({ rows: [rowA, rowB], deps: { maxFilesPerTick: 1 } });
    tenant.addFile('inbox-a', { name: 'a1.pdf' });
    tenant.addFile('inbox-a', { name: 'a2.pdf' });
    const inB = tenant.addFile('inbox-b', { name: 'b1.pdf', createdBy: GUEST_B });

    await inbox.sweep();
    await inbox.sweep();

    expect(tenant.pathOf(inB)).toContain('/01_Faktury/');
  });

  it('rotates which row goes first when every row is done', async () => {
    const { tenant, inbox } = setup({ rows: [rowA, rowB] });
    await inbox.sweep();
    await inbox.sweep();
    const firstListing = (tick: number) =>
      tenant.calls.filter((c) => c.path.includes('/children'))[tick * 2]?.path;
    expect(firstListing(0)).toContain('drive-a');
    expect(firstListing(1)).toContain('drive-b');
  });
});

describe('ChannelInbox: logs', () => {
  it('carries ids and counts only: no file name, folder path, title or NIP', async () => {
    const secretName = 'FV_SECRET-PARTNER_1234567890.pdf';
    const { tenant, inbox, lines } = setup({
      rows: [rowA, rowB],
      classification: new ClassificationService([
        contentReadingClassifier({ ...invoice, parties: [{ role: 'buyer', nip: NIP_A }] }),
        new FallbackClassifier(),
      ]),
    });
    const id = tenant.addFile('inbox-a', { name: secretName });
    tenant.addFile('inbox-a', { name: `staff-${secretName}`, createdBy: STAFF });
    tenant.addFile('inbox-b', { name: `other-${secretName}`, createdBy: GUEST_A });
    let failOnce = true;
    tenant.overrides.push([
      new RegExp(`^PATCH .*/${id}$`),
      (_c, next) => {
        if (!failOnce) return next();
        failOnce = false;
        throw graphError(400);
      },
    ]);

    await inbox.sweep();
    await inbox.sweep();

    // Every kind of line was written: a failure, a skip, a filing, two ticks.
    for (const event of ['inbox.failed', 'inbox.skipped', 'inbox.filed']) {
      expect(lines.some((l) => l['event'] === event)).toBe(true);
    }

    const text = JSON.stringify(lines);
    const leaks = [
      'SECRET',
      '1234567890',
      NIP_A,
      CHANNEL,
      'Faktury',
      'Client 11',
      'model free text',
    ].filter((s) => text.includes(s));
    expect(leaks).toEqual([]);
    expect(lines.filter((l) => l['event'] === 'inbox.tick')).toHaveLength(2);
  });

  it('logs one inbox.tick summary with every count', async () => {
    const { tenant, inbox, tickLine } = setup();
    tenant.addFile('inbox-a', { name: 'a.pdf' });
    await inbox.sweep();
    expect(tickLine()).toEqual({
      event: 'inbox.tick',
      msg: 'inbox.tick',
      mode: 'enforce',
      rows: 1,
      candidates: 1,
      filed: 1,
      sortedToReview: 0,
      wouldMove: 0,
      skippedNotClient: 0,
      skippedUnverified: 0,
      skippedYoung: 0,
      skippedIneligible: 0,
      skippedBeforeCutoff: 0,
      skippedChanged: 0,
      deferred: 0,
      failed: 0,
      rowsFailed: 0,
      durationMs: 0,
    });
  });
});

// ---------------------------------------------------------------------------

describe('selectCandidates', () => {
  const file = (over: Partial<InboxItem> & { id: string }): InboxItem => ({
    name: `${over.id}.pdf`,
    size: 10,
    file: { mimeType: 'application/pdf' },
    eTag: 'e',
    createdBy: { user: { id: GUEST_A.toUpperCase() } },
    lastModifiedBy: { user: { id: GUEST_AB.toUpperCase() } },
    createdDateTime: OLD,
    lastModifiedDateTime: OLD,
    ...over,
  });

  it('orders candidates oldest first, then by id, and lower-cases the creator and modifier ids', () => {
    const picked = selectCandidates(
      [
        file({ id: 'b', lastModifiedDateTime: '2026-09-26T09:40:00Z' }),
        file({ id: 'c', lastModifiedDateTime: '2026-09-26T09:30:00Z' }),
        file({ id: 'a', lastModifiedDateTime: '2026-09-26T09:40:00Z' }),
      ],
      { now: NOW, minAgeMs: 120_000 },
    );
    expect(picked.candidates.map((c) => c.item.id)).toEqual(['c', 'a', 'b']);
    expect(picked.candidates[0]).toMatchObject({ creatorId: GUEST_A, modifierId: GUEST_AB });
  });

  it('keeps an empty modifier id when the last change was not a user’s', () => {
    const picked = selectCandidates(
      [
        file({ id: 'a', lastModifiedBy: { user: { id: 'SharePoint App' } } }),
        file({ id: 'b', lastModifiedBy: {} }),
      ],
      { now: NOW, minAgeMs: 0 },
    );
    expect(picked.candidates.map((c) => c.modifierId)).toEqual(['', '']);
  });

  it('treats an unreadable modification time as young', () => {
    const picked = selectCandidates([file({ id: 'a', lastModifiedDateTime: 'soon' })], {
      now: NOW,
      minAgeMs: 0,
    });
    expect(picked).toMatchObject({ candidates: [], young: 1 });
  });

  it('leaves a file without an eTag: nothing could hold a later read or move to it', () => {
    const noETag = file({ id: 'a' });
    delete (noETag as { eTag?: string }).eTag;
    const picked = selectCandidates([noETag, file({ id: 'b', eTag: '' })], {
      now: NOW,
      minAgeMs: 0,
    });
    expect(picked).toMatchObject({ candidates: [], ineligible: 2 });
  });

  it('with a cutoff, leaves files created at or before it, or with no readable creation time', () => {
    const cutoff = Date.parse('2026-09-26T09:00:00Z');
    const picked = selectCandidates(
      [
        file({ id: 'before', createdDateTime: '2026-09-25T12:00:00Z' }),
        file({ id: 'at', createdDateTime: '2026-09-26T09:00:00Z' }),
        file({ id: 'unknown', createdDateTime: 'yesterday' }),
        file({ id: 'after', createdDateTime: '2026-09-26T09:00:01Z' }),
      ],
      { now: NOW, minAgeMs: 0, createdAfterMs: cutoff },
    );
    expect(picked.candidates.map((c) => c.item.id)).toEqual(['after']);
    expect(picked.beforeCutoff).toBe(3);
  });

  it('ignores packages and folders without counting them', () => {
    const picked = selectCandidates(
      [file({ id: 'p', package: { type: 'oneNote' } }), file({ id: 'f', folder: {} })],
      { now: NOW, minAgeMs: 0 },
    );
    expect(picked).toEqual({
      candidates: [],
      young: 0,
      ineligible: 0,
      beforeCutoff: 0,
      noCreator: 0,
    });
  });
});

describe('inboxPlacement', () => {
  const base = { ...invoice, fields: {} };

  it('builds a dated category with its year and month', () => {
    expect(inboxPlacement(invoice, NOW)).toEqual({
      category: 'faktury_zakupu',
      folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
      review: false,
    });
  });

  it.each([
    ['an unknown category', { category: 'evil' }],
    ['no category (the fallback classifier)', {}],
    ['a dated category without a date', { category: 'wyciagi_bankowe' }],
    [
      'a dated category with an impossible month',
      { category: 'wyciagi_bankowe', year: 2026, month: 13 },
    ],
    ['nieposortowane itself', { category: 'nieposortowane', year: 2020, month: 1 }],
  ])('sends %s to review for this month', (_label, fields) => {
    expect(inboxPlacement({ ...base, fields }, NOW)).toEqual({
      category: 'nieposortowane',
      folderPath: reviewFolderPath(NOW),
      review: true,
    });
    expect(reviewFolderPath(NOW)).toBe('98_Nieposortowane/2026/09');
  });
});
