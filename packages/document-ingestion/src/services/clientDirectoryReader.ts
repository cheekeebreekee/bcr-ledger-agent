import type { Client } from '@microsoft/microsoft-graph-client';
import {
  canonicalSitePath,
  createLogger,
  type ClientDirectoryEntry,
  type SharePointTarget,
} from '@bcr/shared';

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
   * case-insensitively in their canonical spelling (`canonicalSitePath`).
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
 *
 *  - `forbidden_target`: another host, a forbidden site, or a site path that
 *    is not exactly `/sites|teams/<name>`.
 *  - `target_conflict`: another active client row names the same site, the
 *    same DriveId or the same TeamId.
 *  - `unbound_target`: the row lacks RootFolder, DriveId or TeamId, so the
 *    binding tool (`tools/directory-bindings.mjs apply`, which writes all three
 *    together) has not bound it. Such a row would file into the library root,
 *    or route an account the tool never checked.
 */
export type ExcludedRowReason = 'forbidden_target' | 'target_conflict' | 'unbound_target';

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
   * AAD object ids that appear on more than one row, or whose one row was
   * excluded for a target conflict. These users are quarantined as `conflict`.
   */
  readonly conflictedUserIds: ReadonlySet<string>;
  /**
   * AAD object ids whose one row points at a forbidden site (BCR GROUP, the
   * quarantine, another host) or at a site path that is not canonical. These
   * users are quarantined as `forbidden_target`.
   */
  readonly forbiddenUserIds: ReadonlySet<string>;
  /**
   * AAD object ids whose one row the binding tool has not bound (no RootFolder,
   * DriveId or TeamId). These users are quarantined as `unbound_target`.
   */
  readonly unboundUserIds: ReadonlySet<string>;
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
    const excludedByReason: Partial<Record<ExcludedRowReason, number>> = {};
    for (const reason of snapshot.excludedRows.values()) {
      excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
    }
    this.log.info(
      {
        entryCount: entries.length,
        routableUserCount: snapshot.byUserAadObjectId.size,
        excludedRowCount: snapshot.excludedRows.size,
        excludedByReason,
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
  // The path that is checked must be the path that is requested: store the
  // canonical form when there is one. A non-canonical path is kept as typed
  // and excluded by buildSnapshot, so it routes nobody.
  const target: SharePointTarget = {
    siteHostname,
    sitePath: canonicalSitePath(sitePath) ?? sitePath,
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
 * The key two rows are compared on for a target conflict: the site itself.
 * One Team site belongs to one client, so two rows on the same site conflict
 * whatever drive or folder each names — a per-folder key let a second client
 * into the same library through a different RootFolder spelling.
 */
export function siteKey(t: SharePointTarget): string | null {
  const path = canonicalSitePath(t.sitePath);
  return path ? `${t.siteHostname.trim().toLowerCase()}${path.toLowerCase()}` : null;
}

/**
 * Every key a client row claims a place by: its site, and — whatever the
 * site's spelling — the drive and the Team it was bound to. Two rows sharing
 * any one of them are a target conflict.
 */
function targetKeys(e: ClientDirectoryEntry, site: string): string[] {
  const driveId = e.target.expectedDriveId?.trim().toLowerCase();
  const teamId = e.teamId?.trim().toLowerCase();
  return [
    `site|${site}`,
    ...(driveId ? [`drive|${driveId}`] : []),
    ...(teamId ? [`team|${teamId}`] : []),
  ];
}

/**
 * True when the binding tool has bound the row: it records RootFolder,
 * DriveId and TeamId together, so a row missing any one of them was not
 * bound by it (or was edited by hand since) and routes nobody.
 */
export function isBoundRow(e: ClientDirectoryEntry): boolean {
  return Boolean(e.target.rootFolder && e.target.expectedDriveId && e.teamId);
}

/**
 * The client rows the snapshot routes to, whatever user ids they hold: active,
 * not admin, bound, and not excluded (`forbidden_target`, `target_conflict`,
 * `unbound_target`). An unavailable snapshot has none. Ordered by list item id
 * (numerically where it is a number), so callers see a stable order.
 *
 * The channel inbox sweeps exactly these rows' channel folders.
 */
export function boundClientRows(snapshot: ClientDirectorySnapshot): ClientDirectoryEntry[] {
  if (snapshot.health !== 'fresh') return [];
  return snapshot.entries
    .filter(
      (e) => e.active && !e.isAdmin && isBoundRow(e) && !snapshot.excludedRows.has(e.listItemId),
    )
    .sort(compareListItemIds);
}

function compareListItemIds(a: ClientDirectoryEntry, b: ClientDirectoryEntry): number {
  const x = a.listItemId;
  const y = b.listItemId;
  if (/^\d+$/.test(x) && /^\d+$/.test(y) && x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
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
 *  - A row pointing at a forbidden site, another host, or a site path that is
 *    not canonical is excluded (`forbidden_target`).
 *  - Rows on the same site, or with the same DriveId or TeamId, are all
 *    excluded (`target_conflict`), whatever drive or folder each names: two
 *    clients in one library is a leak by construction, and the ids catch it
 *    whatever the path's spelling.
 *  - Any other client row the binding tool has not bound (no RootFolder,
 *    DriveId or TeamId) is excluded (`unbound_target`).
 *  - A user id on exactly one row routes: to that row if it is a client row,
 *    to "staff" if it is an admin row. On two or more rows — two clients, or
 *    a client and an admin row — it routes nowhere (`conflict`). A user id on
 *    a row excluded for a target conflict is a conflict too.
 *  - A NIP or ClientId shared by rows only raises an alert: neither routes
 *    anything any more, and excluding a real client over a test row sharing
 *    its NIP would quarantine a live client for no safety gain.
 */
export function buildSnapshot(
  entries: readonly ClientDirectoryEntry[],
  fetchedAt: number,
  opts: BuildSnapshotOptions,
): ClientDirectorySnapshot {
  const forbidden = new Set(
    opts.forbiddenSitePaths
      .map((p) => canonicalSitePath(p)?.toLowerCase())
      .filter((p): p is string => Boolean(p)),
  );
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
      const path = canonicalSitePath(e.target.sitePath)?.toLowerCase();
      const key = siteKey(e.target);
      if (host !== allowedHost || !path || !key || forbidden.has(path)) {
        excludedRows.set(e.listItemId, 'forbidden_target');
      } else {
        for (const k of targetKeys(e, key)) push(rowsByTarget, k, e.listItemId);
      }
      if (e.nip) push(rowsByNip, e.nip, e.listItemId);
    }
    push(rowsByClientId, e.clientId, e.listItemId);
    for (const oid of new Set(e.userAadObjectIds)) {
      if (oid) push(rowsByUser, oid, e);
    }
  }

  const reportedTargetConflicts = new Set<string>();
  for (const ids of rowsByTarget.values()) {
    if (ids.length > 1) {
      for (const id of ids) excludedRows.set(id, 'target_conflict');
      // Rows sharing a site and a drive are one conflict, reported once.
      const report = JSON.stringify(ids);
      if (!reportedTargetConflicts.has(report)) {
        reportedTargetConflicts.add(report);
        opts.onConflict?.('target', ids);
      }
    }
  }
  for (const e of entries) {
    if (!e.isAdmin && !excludedRows.has(e.listItemId) && !isBoundRow(e)) {
      excludedRows.set(e.listItemId, 'unbound_target');
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
  const forbiddenUserIds = new Set<string>();
  const unboundUserIds = new Set<string>();

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
    const excluded = excludedRows.get(row.listItemId);
    if (row.isAdmin) {
      staffUserIds.add(oid);
    } else if (excluded === 'forbidden_target') {
      forbiddenUserIds.add(oid);
    } else if (excluded === 'unbound_target') {
      unboundUserIds.add(oid);
    } else if (excluded) {
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
    forbiddenUserIds,
    unboundUserIds,
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
    forbiddenUserIds: new Set(),
    unboundUserIds: new Set(),
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
