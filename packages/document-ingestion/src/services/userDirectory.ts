import type { Client } from '@microsoft/microsoft-graph-client';
import { LedgerAgentError } from '@bcr/shared';
import type { RetryOptions } from '../utils/retry';
import { graphStatus, withGraphRetry } from './sharePointService';

/** How long a successful read of one user's type is reused (ms). */
export const USER_TYPE_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_RETRY: RetryOptions = { retries: 3, minTimeoutMs: 250, factor: 2 };

/** Users whose type is held at once. Far above the number of uploaders in 5 min. */
const DEFAULT_MAX_CACHED_USERS = 1000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Entra's `userType` of a user: `Guest` for an invited outside account,
 * `Member` for the tenant's own people. `null` when the user does not exist
 * (any more). Fakes implement it in tests.
 */
export interface UserTypeSource {
  userTypeOf(userAadObjectId: string): Promise<string | null>;
}

/**
 * A user's type could not be read. `status` is Graph's HTTP status when there
 * was one. Carries no URL, path or name.
 */
export class UserTypeReadError extends LedgerAgentError {
  constructor(
    message: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super('UserTypeReadError', message, 502, cause);
  }
}

export interface UserTypeReaderOptions {
  /** Defaults to {@link USER_TYPE_CACHE_TTL_MS}. */
  readonly cacheTtlMs?: number;
  /** Clock (ms). Injected in tests. */
  readonly now?: () => number;
  /** Retry policy for network failures, 500 and 502. Injected short in tests. */
  readonly retry?: RetryOptions;
  readonly maxCachedUsers?: number;
}

interface CachedType {
  readonly userType: string | null;
  readonly readAt: number;
}

/**
 * Reads a user's `userType` from Entra as the ingestion managed identity:
 * `GET /users/{id}?$select=userType` (not a default property, so it must be
 * selected). `Directory.Read.All`, already granted for the membership check,
 * covers it.
 *
 * Like {@link TeamMembershipReader}: a successful read (a 404 included, as
 * "no such user") is cached per user; a failure is never cached, so the next
 * sweep asks again; concurrent reads for one user share one request.
 */
export class UserTypeReader implements UserTypeSource {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly retry: RetryOptions;
  private readonly maxCachedUsers: number;
  private readonly cache = new Map<string, CachedType>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly graph: Client,
    opts: UserTypeReaderOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? USER_TYPE_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.maxCachedUsers = opts.maxCachedUsers ?? DEFAULT_MAX_CACHED_USERS;
  }

  async userTypeOf(userAadObjectId: string): Promise<string | null> {
    const oid = userAadObjectId.trim().toLowerCase();
    // It becomes part of a Graph path.
    if (!GUID.test(oid)) throw new UserTypeReadError('Not a user object id');

    const hit = this.cache.get(oid);
    if (hit && this.now() - hit.readAt < this.ttlMs) return hit.userType;

    let pending = this.inFlight.get(oid);
    if (!pending) {
      const startedAt = this.now();
      pending = this.read(oid)
        .then((userType) => {
          this.remember(oid, { userType, readAt: startedAt });
          return userType;
        })
        .finally(() => this.inFlight.delete(oid));
      this.inFlight.set(oid, pending);
    }
    return pending;
  }

  private async read(oid: string): Promise<string | null> {
    let user: { userType?: unknown } | undefined;
    try {
      user = (await withGraphRetry(
        () => this.graph.api(`/users/${oid}?$select=userType`).get() as Promise<typeof user>,
        this.retry,
      )) as typeof user;
    } catch (err) {
      const status = graphStatus(err);
      if (status === 404) return null;
      throw new UserTypeReadError("The user's type could not be read", status, err);
    }
    if (typeof user?.userType !== 'string') {
      throw new UserTypeReadError('The user response had no userType');
    }
    return user.userType;
  }

  /** Keeps the cache bounded: expired entries go first, then the oldest. */
  private remember(oid: string, entry: CachedType): void {
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
