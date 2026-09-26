import type { Client } from '@microsoft/microsoft-graph-client';
import { createLogger, LedgerAgentError, type Logger, type MembershipCheckMode } from '@bcr/shared';
import type { RetryOptions } from '../utils/retry';
import { graphStatus, withGraphRetry } from './sharePointService';

/** How long a successful read of one user's Teams is reused (ms). */
export const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_RETRY: RetryOptions = { retries: 3, minTimeoutMs: 250, factor: 2 };

/** Users whose Teams are held at once. Far above the number of guests who upload in 5 min. */
const DEFAULT_MAX_CACHED_USERS = 1000;

/** At `$top=999` a page, 20 pages is more groups than any guest of this tenant is in. */
const DEFAULT_MAX_PAGES = 20;

const GRAPH_ORIGIN = 'https://graph.microsoft.com/';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The description onboarding gives a client Team's group. Must match
 * `BCR_TEAM_DESCRIPTION` in `tools/lib/bindings.mjs`, so the runtime counts
 * every group the binding tool counts as a Team.
 */
export const CLIENT_TEAM_MARKER = /^\s*BCR\s+Group\s*[—–-]/i;

/** What the resolver needs: the Teams a user is in. Fakes implement it in tests. */
export interface TeamMembershipSource {
  /** Lower-cased Team (group) ids. Rejects when they cannot be read. */
  teamsOf(userAadObjectId: string): Promise<ReadonlySet<string>>;
}

/**
 * The user's Teams could not be read. `status` is Graph's HTTP status when
 * there was one (403: the grant is missing or not yet in the token; 404: no
 * such user). Carries no URL, path or name.
 */
export class TeamMembershipReadError extends LedgerAgentError {
  constructor(
    message: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super('TeamMembershipReadError', message, 502, cause);
  }
}

export interface TeamMembershipReaderOptions {
  /** Defaults to {@link MEMBERSHIP_CACHE_TTL_MS}. */
  readonly cacheTtlMs?: number;
  /** Clock (ms). Injected in tests. */
  readonly now?: () => number;
  /** Retry policy for network failures, 500 and 502. Injected short in tests. */
  readonly retry?: RetryOptions;
  readonly maxCachedUsers?: number;
  readonly maxPages?: number;
}

/** One entry of `/users/{id}/memberOf`: a group, a directory role or an administrative unit. */
export interface MemberOfEntry {
  readonly '@odata.type'?: unknown;
  readonly id?: unknown;
  readonly description?: unknown;
  readonly resourceProvisioningOptions?: unknown;
}

interface MemberOfPage {
  readonly value?: unknown;
  readonly '@odata.nextLink'?: unknown;
}

interface CachedTeams {
  readonly teams: ReadonlySet<string>;
  readonly readAt: number;
}

/**
 * Reads which Teams a user is a direct member of, from Entra ID:
 * `GET /users/{id}/memberOf?$select=id,description,resourceProvisioningOptions`,
 * every page. Which groups are Teams follows the rule
 * `tools/directory-bindings.mjs` applies when it binds a guest (see
 * {@link teamIdsIn}), so the tool and the runtime agree on who is in which
 * Team. The description is read only for that rule; it is never logged.
 *
 * Why Entra and not `/users/{id}/joinedTeams` (which would need only
 * `Team.ReadBasic.All`): onboarding adds a guest to a client's Team through
 * its group (`POST /groups/{id}/members/$ref`). Entra has that membership at
 * once; Microsoft documents that a member added outside Teams "can take up to
 * 24 hours" to be reflected in Teams, and `joinedTeams` reads Teams. A check
 * that lags a day leaves open the window it exists to close. Its behaviour
 * for guests and its paging are also undocumented. The OData cast
 * (`/memberOf/microsoft.graph.group`) is not used either: Microsoft documents
 * it as needing `ConsistencyLevel: eventual`, an index that can trail recent
 * changes. Directory roles and administrative units are skipped here instead.
 *
 * Needs the Graph application permission `Directory.Read.All`, the least
 * privileged one Microsoft Learn lists for another user's `memberOf`
 * (infrastructure/identity/grant-ingestion-membership-read.sh).
 *
 * A successful read is cached per user for {@link MEMBERSHIP_CACHE_TTL_MS};
 * a failed one is never cached, so the next upload asks again. Concurrent
 * reads for one user share one request.
 */
export class TeamMembershipReader implements TeamMembershipSource {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly retry: RetryOptions;
  private readonly maxCachedUsers: number;
  private readonly maxPages: number;
  private readonly cache = new Map<string, CachedTeams>();
  private readonly inFlight = new Map<string, Promise<ReadonlySet<string>>>();

  constructor(
    private readonly graph: Client,
    opts: TeamMembershipReaderOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? MEMBERSHIP_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.maxCachedUsers = opts.maxCachedUsers ?? DEFAULT_MAX_CACHED_USERS;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  async teamsOf(userAadObjectId: string): Promise<ReadonlySet<string>> {
    const oid = userAadObjectId.trim().toLowerCase();
    // Validated upstream; checked again because it becomes part of a Graph path.
    if (!GUID.test(oid)) throw new TeamMembershipReadError('Not a user object id');

    const hit = this.cache.get(oid);
    if (hit && this.now() - hit.readAt < this.ttlMs) return hit.teams;

    let pending = this.inFlight.get(oid);
    if (!pending) {
      const startedAt = this.now();
      pending = this.read(oid)
        .then((teams) => {
          this.remember(oid, { teams, readAt: startedAt });
          return teams;
        })
        .finally(() => this.inFlight.delete(oid));
      this.inFlight.set(oid, pending);
    }
    return pending;
  }

  private async read(oid: string): Promise<ReadonlySet<string>> {
    const teams = new Set<string>();
    let path: string | undefined =
      `/users/${oid}/memberOf?$select=id,description,resourceProvisioningOptions&$top=999`;
    let pages = 0;
    while (path !== undefined) {
      pages += 1;
      if (pages > this.maxPages) {
        throw new TeamMembershipReadError('The user has more memberships than can be checked');
      }
      const current: string = path;
      let page: MemberOfPage;
      try {
        page =
          (await withGraphRetry(
            () => this.graph.api(current).get() as Promise<MemberOfPage>,
            this.retry,
          )) ?? {};
      } catch (err) {
        throw new TeamMembershipReadError(
          "The user's memberships could not be read",
          graphStatus(err),
          err,
        );
      }
      if (!Array.isArray(page.value)) {
        throw new TeamMembershipReadError('The membership response had no value');
      }
      for (const id of teamIdsIn(page.value as readonly MemberOfEntry[])) teams.add(id);
      path = nextLinkOf(page);
    }
    return teams;
  }

  /** Keeps the cache bounded: expired entries go first, then the oldest. */
  private remember(oid: string, entry: CachedTeams): void {
    this.cache.delete(oid);
    if (this.cache.size >= this.maxCachedUsers) {
      const now = this.now();
      for (const [key, value] of this.cache) {
        if (now - value.readAt >= this.ttlMs) this.cache.delete(key);
      }
      const oldest = this.cache.keys().next();
      if (this.cache.size >= this.maxCachedUsers && !oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(oid, entry);
  }
}

/**
 * The lower-cased ids of the Teams among one page of `memberOf`.
 *
 *  - Directory roles and administrative units are not Teams, and skipped.
 *  - A group is a Team when its `resourceProvisioningOptions` contains `Team`,
 *    or when its description carries onboarding's client-Team marker
 *    (`BCR Group —`), as the binding tool also counts it.
 *  - A group whose options were not returned at all cannot be told apart from
 *    a Team, so it counts as one: an unknown may quarantine, never route. (An
 *    entry without `@odata.type` is treated as a group for the same reason.)
 *  - A Team without a readable id makes the whole read fail: it cannot be
 *    compared with the row's TeamId.
 */
export function teamIdsIn(entries: readonly MemberOfEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const type = entry['@odata.type'];
    if (typeof type === 'string' && type.toLowerCase() !== '#microsoft.graph.group') continue;
    const options = entry.resourceProvisioningOptions;
    const isTeam =
      !Array.isArray(options) ||
      options.some((o) => String(o).toLowerCase() === 'team') ||
      (typeof entry.description === 'string' && CLIENT_TEAM_MARKER.test(entry.description));
    if (!isTeam) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : '';
    if (!GUID.test(id)) {
      throw new TeamMembershipReadError('A Team membership has no readable id');
    }
    ids.push(id);
  }
  return ids;
}

/** The next page, which must be on Graph itself; anything else ends the read as a failure. */
function nextLinkOf(page: MemberOfPage): string | undefined {
  const next = page['@odata.nextLink'];
  if (next === undefined || next === null) return undefined;
  if (typeof next !== 'string' || !next.startsWith(GRAPH_ORIGIN)) {
    throw new TeamMembershipReadError('The membership response pointed outside Graph');
  }
  return next;
}

/**
 * How the resolver checks membership. `enforce` needs a source; `off` has
 * none, so there is nothing to call by mistake.
 */
export type MembershipCheck =
  | { readonly mode: 'enforce'; readonly source: TeamMembershipSource }
  | { readonly mode: 'off' };

/**
 * The resolver's membership check for a configured mode. `off` reopens R46,
 * so it is said out loud once per cold start (`membership.check_off`).
 */
export function membershipCheckFor(
  mode: MembershipCheckMode,
  source: TeamMembershipSource,
  log: Logger = createLogger('ingestion/teamMembership'),
): MembershipCheck {
  if (mode === 'off') {
    log.warn(
      { event: 'membership.check_off' },
      'MEMBERSHIP_CHECK_MODE=off: uploads route without checking the uploader is in their ' +
        "row's Team only (R46 is open). Emergency use only; set it back to enforce.",
    );
    return { mode: 'off' };
  }
  return { mode: 'enforce', source };
}
