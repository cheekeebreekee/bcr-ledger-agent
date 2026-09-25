import type { Client } from '@microsoft/microsoft-graph-client';
import { createLogger, type ClientDirectoryEntry, type SharePointTarget } from '@bcr/shared';

export interface ClientDirectoryReaderOptions {
  /** Graph site id where the Client Directory list lives. */
  readonly siteId: string;
  /** Graph list id of the Client Directory list. */
  readonly listId: string;
  /** How long the snapshot is cached in-process before refetching (ms). */
  readonly cacheTtlMs: number;
  /** Optional clock injection for tests. */
  readonly now?: () => number;
}

/**
 * Immutable in-memory snapshot of the Client Directory. Consumers should
 * treat this as a read-only view; the reader will return a fresh snapshot
 * (with rebuilt lookup maps) after the TTL expires.
 */
export interface ClientDirectorySnapshot {
  readonly entries: readonly ClientDirectoryEntry[];
  /** Lookup by digits-only NIP. Populated only for rows with a non-empty NIP. */
  readonly byNip: ReadonlyMap<string, ClientDirectoryEntry>;
  /**
   * Lookup by normalized alias (see {@link normalizeName}). One alias can
   * only ever map to a single entry \u2014 duplicate aliases across clients are
   * dropped from the map (a warning is logged) so a document never files
   * into the wrong client's SharePoint space.
   */
  readonly byCompanyAlias: ReadonlyMap<string, ClientDirectoryEntry>;
  /** Same rules as `byCompanyAlias` but for `PersonNames`. */
  readonly byPersonName: ReadonlyMap<string, ClientDirectoryEntry>;
  /**
   * Lookup by AAD object id (case-insensitive, GUID normalized).
   * Used for user-identity-based routing when the request originates from a
   * 1:1 DM with the bot (no channel context).
   */
  readonly byUserAadObjectId: ReadonlyMap<string, ClientDirectoryEntry>;
  /** Timestamp (ms) when the snapshot was fetched. */
  readonly fetchedAt: number;
}

/**
 * Raw shape of a `Client Directory` list item as returned by
 * `GET /sites/{id}/lists/{id}/items?expand=fields`. Everything is
 * strings-or-undefined; column names are the internal SharePoint names
 * as set at list creation.
 */
interface DirectoryFields {
  Title?: string;
  ClientId?: string;
  NIP?: string;
  CompanyNameAliases?: string;
  PersonNames?: string;
  UserAadObjectIds?: string;
  SiteHostname?: string;
  SitePath?: string;
  DriveName?: string;
  RootFolder?: string;
  IsAdmin?: boolean;
  Status?: string;
}

interface GraphListItem {
  id: string;
  fields?: DirectoryFields;
}

interface GraphListItemsPage {
  value: GraphListItem[];
  '@odata.nextLink'?: string;
}

/**
 * Reads and caches the Client Directory SharePoint list. Cache TTL is
 * intentionally short (minutes) so admins adding/editing rows in the
 * SharePoint UI see the change without redeploying.
 *
 * Concurrent callers during a refresh all share the same in-flight
 * promise \u2014 the list is fetched at most once per TTL window.
 */
export class ClientDirectoryReader {
  private readonly log = createLogger('ingestion/clientDirectory');
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private snapshot: ClientDirectorySnapshot | undefined;
  private inFlight: Promise<ClientDirectorySnapshot> | undefined;

  constructor(
    private readonly graph: Client,
    private readonly opts: ClientDirectoryReaderOptions,
  ) {
    this.cacheTtlMs = opts.cacheTtlMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return the current snapshot, refreshing it if the TTL has expired.
   * Never throws \u2014 on failure, returns the last successful snapshot if
   * one exists, or an empty snapshot otherwise (so uploads still route
   * to the configured fallback bucket).
   */
  async getSnapshot(): Promise<ClientDirectorySnapshot> {
    const cached = this.snapshot;
    if (cached && this.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached;
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = undefined;
      });
    }
    try {
      return await this.inFlight;
    } catch (err) {
      // Fall back to the stale snapshot if we have one \u2014 uploads keep
      // working with the last known-good directory. If we've never
      // fetched successfully, return an empty snapshot so the resolver
      // takes the fallback path.
      this.log.error({ err }, 'directory refresh failed; using stale/empty snapshot');
      return cached ?? emptySnapshot(this.now());
    }
  }

  private async refresh(): Promise<ClientDirectorySnapshot> {
    this.log.info('refreshing Client Directory snapshot');
    const raw = await this.fetchAllItems();
    const entries = raw
      .map(toEntry)
      .filter((e): e is ClientDirectoryEntry => e !== null && e.active);
    const snapshot = buildSnapshot(entries, this.now(), this.log);
    this.snapshot = snapshot;
    this.log.info({ entryCount: entries.length }, 'directory snapshot ready');
    return snapshot;
  }

  private async fetchAllItems(): Promise<GraphListItem[]> {
    const items: GraphListItem[] = [];
    // Explicit `expand=fields` \u2014 without it Graph returns items without
    // any of the custom column values. `select` narrows the payload.
    let path: string | undefined =
      `/sites/${this.opts.siteId}/lists/${this.opts.listId}/items` +
      '?expand=fields&$select=id,fields&$top=200';
    // Graph pagination: follow `@odata.nextLink` until absent. The SDK
    // accepts either a full URL or a relative path here.
    while (path) {
      const page = (await this.graph.api(path).get()) as GraphListItemsPage;
      items.push(...page.value);
      path = page['@odata.nextLink'];
    }
    return items;
  }
}

// ---------------------------------------------------------------------------
// Parsing + normalization helpers (exported for unit tests).
// ---------------------------------------------------------------------------

/**
 * Turn a Graph list item into a normalized `ClientDirectoryEntry`, or
 * `null` if the row is missing the fields required to route anywhere.
 */
export function toEntry(item: GraphListItem): ClientDirectoryEntry | null {
  const f = item.fields ?? {};
  const clientId = strOrEmpty(f.ClientId).trim();
  const title = strOrEmpty(f.Title).trim();
  const siteHostname = strOrEmpty(f.SiteHostname).trim();
  const sitePath = strOrEmpty(f.SitePath).trim();
  const driveName = strOrEmpty(f.DriveName).trim() || 'Documents';
  const isAdmin = f.IsAdmin === true;

  // A row without a client id is unusable \u2014 no way to log/refer to it.
  if (!clientId) return null;

  // Admin rows do not need a SharePoint target (they don't file anywhere
  // by themselves), but every non-admin client row must resolve to one.
  if (!isAdmin && (!siteHostname || !sitePath)) return null;

  const rootFolder = strOrEmpty(f.RootFolder).trim();
  const target: SharePointTarget = {
    siteHostname,
    sitePath,
    driveName,
    ...(rootFolder ? { rootFolder } : {}),
  };

  return {
    listItemId: item.id,
    title: title || clientId,
    clientId,
    nip: normalizeNip(strOrEmpty(f.NIP)),
    companyNameAliases: splitLines(strOrEmpty(f.CompanyNameAliases)),
    personNames: splitLines(strOrEmpty(f.PersonNames)),
    userAadObjectIds: splitLines(strOrEmpty(f.UserAadObjectIds))
      .map(normalizeAadId)
      .filter(Boolean),
    target,
    isAdmin,
    active: (strOrEmpty(f.Status).trim() || 'Active').toLowerCase() === 'active',
  };
}

/**
 * Normalized company/person name key used for content-based routing.
 * Case-folds, strips Unicode diacritics, collapses whitespace, and
 * drops most punctuation. Deliberately NOT fuzzy \u2014 the match must be
 * exact after normalization to avoid ever mis-filing into the wrong
 * client's SharePoint space.
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKD')
    // eslint-disable-next-line no-misleading-character-class -- intentional combining-mark strip
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Digits-only NIP normalization. Returns `''` for junk input. */
export function normalizeNip(input: string): string {
  return input.replace(/\D+/g, '');
}

/**
 * Normalize an AAD object id to a lower-case, whitespace-stripped GUID so
 * lookups are stable regardless of how admins type it into SharePoint.
 * Returns `''` if the input doesn't look like a GUID (dropped from maps).
 */
export function normalizeAadId(input: string): string {
  const t = input.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t) ? t : '';
}

// ---------------------------------------------------------------------------

function buildSnapshot(
  entries: readonly ClientDirectoryEntry[],
  fetchedAt: number,
  log: ReturnType<typeof createLogger>,
): ClientDirectorySnapshot {
  const byNip = new Map<string, ClientDirectoryEntry>();
  const byCompanyAlias = new Map<string, ClientDirectoryEntry>();
  const byPersonName = new Map<string, ClientDirectoryEntry>();
  const byUserAadObjectId = new Map<string, ClientDirectoryEntry>();

  for (const e of entries) {
    if (e.nip) {
      putUnique(byNip, e.nip, e, 'nip', log);
    }
    for (const alias of e.companyNameAliases) {
      const key = normalizeName(alias);
      if (key) putUnique(byCompanyAlias, key, e, 'companyAlias', log);
    }
    for (const name of e.personNames) {
      const key = normalizeName(name);
      if (key) putUnique(byPersonName, key, e, 'personName', log);
    }
    for (const aad of e.userAadObjectIds) {
      if (aad) putUnique(byUserAadObjectId, aad, e, 'userAadObjectId', log);
    }
  }

  return {
    entries,
    byNip,
    byCompanyAlias,
    byPersonName,
    byUserAadObjectId,
    fetchedAt,
  };
}

function putUnique<T extends { clientId: string }>(
  map: Map<string, T>,
  key: string,
  entry: T,
  kind: string,
  log: ReturnType<typeof createLogger>,
): void {
  const existing = map.get(key);
  if (existing && existing.clientId !== entry.clientId) {
    log.warn(
      { kind, key, existing: existing.clientId, incoming: entry.clientId },
      'duplicate directory key across clients \u2014 dropping to prevent mis-routing',
    );
    map.delete(key); // fail-closed: better no match than the wrong client
    return;
  }
  map.set(key, entry);
}

function emptySnapshot(fetchedAt: number): ClientDirectorySnapshot {
  return {
    entries: [],
    byNip: new Map(),
    byCompanyAlias: new Map(),
    byPersonName: new Map(),
    byUserAadObjectId: new Map(),
    fetchedAt,
  };
}

function splitLines(raw: string): readonly string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function strOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
