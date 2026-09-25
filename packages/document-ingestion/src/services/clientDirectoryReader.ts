import type { Client } from '@microsoft/microsoft-graph-client';
import { createLogger, type ClientDirectoryEntry, type SharePointTarget } from '@bcr/shared';

export interface ClientDirectoryReaderOptions {
  /** Graph site id where the Client Directory list lives. */
  readonly siteId: string;
  /** Graph list id of the Client Directory list. */
  readonly listId: string;
  /** How long the snapshot is cached in-process before refetching (ms). */
  readonly cacheTtlMs: number;
  /**
   * Oldest snapshot still used while refreshes fail (ms). Past this age the
   * directory is treated as unavailable and every upload goes to quarantine.
   */
  readonly maxStaleMs: number;
  /**
   * Site paths no row may route to (BCR GROUP, the quarantine site). Compared
   * case-insensitively, ignoring a trailing slash.
   */
  readonly forbiddenSitePaths: readonly string[];
  /**
   * The tenant's SharePoint host. A row pointing at any other host is
   * excluded — nothing may be filed outside the tenant.
   */
  readonly allowedSiteHostname: string;
  /** Minimum gap between refresh attempts while refreshes keep failing (ms). */
  readonly retryBackoffMs?: number;
  /** Optional clock injection for tests. */
  readonly now?: () => number;
}

/**
 * Why a row takes no part in routing. Rows are excluded, never "fixed up":
 * a row that cannot be trusted routes nobody, and those users' uploads go to
 * quarantine where a person decides.
 */
export type ExcludedRowReason = 'forbidden_target' | 'target_conflict';

/**
 * Immutable in-memory snapshot of the Client Directory.
 *
 * Built in two passes so the result does not depend on row order (the old
 * incremental "delete on second sight" let a third duplicate re-add the key,
 * which is fail-open). Pass one collects every key's rows; pass two admits a
 * key only when exactly one trusted row holds it.
 */
export interface ClientDirectorySnapshot {
  /** Every active, well-formed row, including excluded and admin rows. */
  readonly entries: readonly ClientDirectoryEntry[];
  /** AAD object id (normalized) → the one client row it routes to. */
  readonly byUserAadObjectId: ReadonlyMap<string, ClientDirectoryEntry>;
  /** AAD object ids that appear only on admin (staff) rows. */
  readonly staffUserIds: ReadonlySet<string>;
  /**
   * AAD object ids that appear on more than one row, or on a row excluded for
   * a target conflict. These users are quarantined as `conflict`.
   */
  readonly conflictedUserIds: ReadonlySet<string>;
  /** List item id → why that row routes nobody. */
  readonly excludedRows: ReadonlyMap<string, ExcludedRowReason>;
  /**
   * `fresh`: fetched within the TTL, or a failed refresh fell back to a snapshot
   * younger than `maxStaleMs`. `unavailable`: never fetched, or the last good
   * snapshot is too old — the resolver quarantines everything.
   */
  readonly health: 'fresh' | 'unavailable';
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
  UserAadObjectIds?: string;
  SiteHostname?: string;
  SitePath?: string;
  DriveName?: string;
  RootFolder?: string;
  DriveId?: string;
  TeamId?: string;
  IsAdmin?: boolean;
  Status?: string;
}

export interface GraphListItem {
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
 * promise — the list is fetched at most once per TTL window.
 */
export class ClientDirectoryReader {
  private readonly log = createLogger('ingestion/clientDirectory');
  private readonly now: () => number;
  private readonly retryBackoffMs: number;
  private snapshot: ClientDirectorySnapshot | undefined;
  private inFlight: Promise<ClientDirectorySnapshot> | undefined;
  private lastFailedAttemptAt: number | undefined;

  constructor(
    private readonly graph: Client,
    private readonly opts: ClientDirectoryReaderOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.retryBackoffMs = opts.retryBackoffMs ?? 30_000;
  }

  /**
   * Return the current snapshot, refreshing it if the TTL has expired.
   * Never throws. When a refresh fails, the last good snapshot is used only
   * while it is younger than `maxStaleMs`; after that an `unavailable`
   * snapshot is returned so nothing routes on data that may have been
   * corrected (a revoked user, a repointed row) since it was read.
   */
  async getSnapshot(): Promise<ClientDirectorySnapshot> {
    const now = this.now();
    const cached = this.snapshot;
    if (cached && now - cached.fetchedAt < this.opts.cacheTtlMs) {
      return cached;
    }
    // While refreshes keep failing, don't start a full list read on every
    // request — that turns Graph throttling into a self-inflicted outage.
    if (this.lastFailedAttemptAt !== undefined && now - this.lastFailedAttemptAt < this.retryBackoffMs) {
      return this.fallbackFor(cached, now);
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = undefined;
      });
    }
    try {
      const fresh = await this.inFlight;
      this.lastFailedAttemptAt = undefined;
      return fresh;
    } catch (err) {
      this.lastFailedAttemptAt = this.now();
      this.log.error({ err }, 'directory refresh failed');
      return this.fallbackFor(cached, this.now());
    }
  }

  private fallbackFor(
    cached: ClientDirectorySnapshot | undefined,
    now: number,
  ): ClientDirectorySnapshot {
    if (cached && now - cached.fetchedAt < this.opts.maxStaleMs) {
      return cached;
    }
    this.log.warn(
      { snapshotAgeMs: cached ? now - cached.fetchedAt : null },
      'directory unavailable or too stale — every upload goes to quarantine',
    );
    return unavailableSnapshot(now);
  }

  private async refresh(): Promise<ClientDirectorySnapshot> {
    this.log.info('refreshing Client Directory snapshot');
    const raw = await this.fetchAllItems();
    const entries = raw
      .map(toEntry)
      .filter((e): e is ClientDirectoryEntry => e !== null && e.active);
    const snapshot = buildSnapshot(entries, this.now(), {
      forbiddenSitePaths: this.opts.forbiddenSitePaths,
      allowedSiteHostname: this.opts.allowedSiteHostname,
      onConflict: (kind, listItemIds) =>
        // Ids only: a key can be a person's AAD id, and a NIP names a company.
        this.log.warn({ event: 'directory.conflict', kind, listItemIds }, 'directory.conflict'),
    });
    this.snapshot = snapshot;
    this.log.info(
      {
        entryCount: entries.length,
        routableUserCount: snapshot.byUserAadObjectId.size,
        excludedRowCount: snapshot.excludedRows.size,
      },
      'directory snapshot ready',
    );
    return snapshot;
  }

  private async fetchAllItems(): Promise<GraphListItem[]> {
    const items: GraphListItem[] = [];
    // Explicit `expand=fields` — without it Graph returns items without
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

  // A row without a client id is unusable — no way to log/refer to it.
  if (!clientId) return null;

  // Admin rows do not need a SharePoint target (they don't file anywhere
  // by themselves), but every non-admin client row must resolve to one.
  if (!isAdmin && (!siteHostname || !sitePath)) return null;

  const rootFolder = strOrEmpty(f.RootFolder).trim();
  const expectedDriveId = strOrEmpty(f.DriveId).trim();
  const teamId = strOrEmpty(f.TeamId).trim();
  const target: SharePointTarget = {
    siteHostname,
    sitePath,
    driveName,
    ...(rootFolder ? { rootFolder } : {}),
    ...(expectedDriveId ? { expectedDriveId } : {}),
  };

  return {
    listItemId: item.id,
    title: title || clientId,
    clientId,
    nip: normalizeNip(strOrEmpty(f.NIP)),
    companyNameAliases: splitLines(strOrEmpty(f.CompanyNameAliases)),
    userAadObjectIds: splitLines(strOrEmpty(f.UserAadObjectIds))
      .map(normalizeAadId)
      .filter(Boolean),
    target,
    ...(teamId ? { teamId } : {}),
    isAdmin,
    active: (strOrEmpty(f.Status).trim() || 'Active').toLowerCase() === 'active',
  };
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

/**
 * Canonical form of a routing target, so two rows naming the same place in
 * different spellings are recognised as the same target. Hostnames are
 * case-insensitive; SharePoint site and folder paths are compared
 * case-insensitively too, because two rows differing only in case would
 * still write into the same library.
 */
export function normalizeTarget(t: SharePointTarget): string {
  return [
    t.siteHostname.trim().toLowerCase(),
    normalizeSitePath(t.sitePath),
    t.driveName.trim().toLowerCase(),
    (t.rootFolder ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase(),
  ].join('|');
}

export function normalizeSitePath(p: string): string {
  return `/${p.trim().replace(/^\/+|\/+$/g, '')}`.toLowerCase();
}

export interface BuildSnapshotOptions {
  readonly forbiddenSitePaths: readonly string[];
  readonly allowedSiteHostname: string;
  readonly onConflict?: (kind: ConflictKind, listItemIds: readonly string[]) => void;
}

export type ConflictKind = 'userAadObjectId' | 'target' | 'nip' | 'clientId';

/**
 * Build the routing maps. Order-independent: the same set of rows gives the
 * same maps in any order.
 *
 * Rules:
 *  - A row pointing at a forbidden site or another host is excluded
 *    (`forbidden_target`).
 *  - Rows sharing a normalized target are all excluded (`target_conflict`):
 *    two clients in one library is a leak by construction.
 *  - A user id on exactly one row routes: to that row if it is a client row,
 *    to "staff" if it is an admin row. On two or more rows — two clients, or
 *    a client and an admin row — it routes nowhere (`conflict`). A user id on
 *    an excluded client row is a conflict too.
 *  - A NIP or ClientId shared by rows only raises an alert: neither routes
 *    anything any more, and excluding a real client over a test row sharing
 *    its NIP would quarantine a live client for no safety gain.
 */
export function buildSnapshot(
  entries: readonly ClientDirectoryEntry[],
  fetchedAt: number,
  opts: BuildSnapshotOptions,
): ClientDirectorySnapshot {
  const forbidden = new Set(opts.forbiddenSitePaths.map(normalizeSitePath));
  const allowedHost = opts.allowedSiteHostname.trim().toLowerCase();
  const excludedRows = new Map<string, ExcludedRowReason>();

  // Pass 1: collect every key's rows.
  const rowsByTarget = new Map<string, string[]>();
  const rowsByUser = new Map<string, ClientDirectoryEntry[]>();
  const rowsByNip = new Map<string, string[]>();
  const rowsByClientId = new Map<string, string[]>();

  for (const e of entries) {
    if (!e.isAdmin) {
      const host = e.target.siteHostname.trim().toLowerCase();
      if (host !== allowedHost || forbidden.has(normalizeSitePath(e.target.sitePath))) {
        excludedRows.set(e.listItemId, 'forbidden_target');
      } else {
        push(rowsByTarget, normalizeTarget(e.target), e.listItemId);
      }
      if (e.nip) push(rowsByNip, e.nip, e.listItemId);
    }
    push(rowsByClientId, e.clientId, e.listItemId);
    for (const oid of new Set(e.userAadObjectIds)) {
      if (oid) push(rowsByUser, oid, e);
    }
  }

  for (const ids of rowsByTarget.values()) {
    if (ids.length > 1) {
      for (const id of ids) excludedRows.set(id, 'target_conflict');
      opts.onConflict?.('target', ids);
    }
  }
  for (const ids of rowsByNip.values()) {
    if (ids.length > 1) opts.onConflict?.('nip', ids);
  }
  for (const ids of rowsByClientId.values()) {
    if (ids.length > 1) opts.onConflict?.('clientId', ids);
  }

  // Pass 2: admit each user id only when exactly one trusted row holds it.
  const byUserAadObjectId = new Map<string, ClientDirectoryEntry>();
  const staffUserIds = new Set<string>();
  const conflictedUserIds = new Set<string>();

  for (const [oid, rows] of rowsByUser) {
    if (rows.length > 1) {
      conflictedUserIds.add(oid);
      opts.onConflict?.(
        'userAadObjectId',
        rows.map((r) => r.listItemId),
      );
      continue;
    }
    const [row] = rows;
    if (!row) continue;
    if (row.isAdmin) {
      staffUserIds.add(oid);
    } else if (excludedRows.has(row.listItemId)) {
      conflictedUserIds.add(oid);
    } else {
      byUserAadObjectId.set(oid, row);
    }
  }

  return {
    entries,
    byUserAadObjectId,
    staffUserIds,
    conflictedUserIds,
    excludedRows,
    health: 'fresh',
    fetchedAt,
  };
}

function unavailableSnapshot(fetchedAt: number): ClientDirectorySnapshot {
  return {
    entries: [],
    byUserAadObjectId: new Map(),
    staffUserIds: new Set(),
    conflictedUserIds: new Set(),
    excludedRows: new Map(),
    health: 'unavailable',
    fetchedAt,
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
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
