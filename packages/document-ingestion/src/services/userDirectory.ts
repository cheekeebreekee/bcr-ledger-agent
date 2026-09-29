import type { Client } from '@microsoft/microsoft-graph-client';
import { LedgerAgentError } from '@bcr/shared';
import type { RetryOptions } from '../utils/retry';
import { graphStatus, withGraphRetry, withoutSdkRetries } from './sharePointService';

/** How long a successful read of one user's account is reused (ms). */
export const USER_ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_RETRY: RetryOptions = { retries: 3, minTimeoutMs: 250, factor: 2 };

/** Users whose account is held at once. Far above the number of uploaders in 5 min. */
const DEFAULT_MAX_CACHED_USERS = 1000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What the client account rule reads of a user (`clientAccountVerdict` in
 * `@bcr/shared`): Entra's `userType` (`Member` for the tenant's own accounts,
 * a client's `{NIP}@bcr-group.pl` included; `Guest` for an invited outside
 * account; `''` when Entra has none) and the `userPrincipalName`. The UPN of
 * a client account holds its NIP: it is compared, never logged.
 */
export interface UserAccount {
  readonly userType: string;
  readonly userPrincipalName: string;
}

/**
 * A user's account, or `null` when the user does not exist (any more). Fakes
 * implement it in tests.
 */
export interface UserAccountSource {
  accountOf(userAadObjectId: string): Promise<UserAccount | null>;
}

/**
 * A user's account could not be read. `status` is Graph's HTTP status when
 * there was one. Carries no URL, path, name or UPN.
 */
export class UserAccountReadError extends LedgerAgentError {
  constructor(
    message: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super('UserAccountReadError', message, 502, cause);
  }
}

export interface UserAccountReaderOptions {
  /** Defaults to {@link USER_ACCOUNT_CACHE_TTL_MS}. */
  readonly cacheTtlMs?: number;
  /** Clock (ms). Injected in tests. */
  readonly now?: () => number;
  /** Retry policy for network failures, 500 and 502. Injected short in tests. */
  readonly retry?: RetryOptions;
  readonly maxCachedUsers?: number;
  /**
   * `false`: switch the Graph SDK's own retries off and retry 429/503/504
   * here, with bounded backoff (the channel-inbox sweep, which must end well
   * inside the timer's time limit). Default `true`.
   */
  readonly sdkRetries?: boolean;
}

interface CachedAccount {
  readonly account: UserAccount | null;
  readonly readAt: number;
}

/**
 * Reads a user's account from Entra as the ingestion managed identity:
 * `GET /users/{id}?$select=userType,userPrincipalName` (`userType` is not a
 * default property, so both are selected). `Directory.Read.All`, already
 * granted for the membership check, covers it. It never selects
 * `accountEnabled` and never looks at licences: the ledger is never a lock
 * on a client.
 *
 * Like {@link TeamMembershipReader}: a successful read (a 404 included, as
 * "no such user") is cached per user; a failure is never cached, so the next
 * request asks again; concurrent reads for one user share one request.
 */
export class UserAccountReader implements UserAccountSource {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly retry: RetryOptions;
  private readonly maxCachedUsers: number;
  private readonly sdkRetries: boolean;
  private readonly cache = new Map<string, CachedAccount>();
  private readonly inFlight = new Map<string, Promise<UserAccount | null>>();

  constructor(
    private readonly graph: Client,
    opts: UserAccountReaderOptions = {},
  ) {
    this.ttlMs = opts.cacheTtlMs ?? USER_ACCOUNT_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.maxCachedUsers = opts.maxCachedUsers ?? DEFAULT_MAX_CACHED_USERS;
    this.sdkRetries = opts.sdkRetries ?? true;
  }

  async accountOf(userAadObjectId: string): Promise<UserAccount | null> {
    const oid = userAadObjectId.trim().toLowerCase();
    // It becomes part of a Graph path.
    if (!GUID.test(oid)) throw new UserAccountReadError('Not a user object id');

    const hit = this.cache.get(oid);
    if (hit && this.now() - hit.readAt < this.ttlMs) return hit.account;

    let pending = this.inFlight.get(oid);
    if (!pending) {
      const startedAt = this.now();
      pending = this.read(oid)
        .then((account) => {
          this.remember(oid, { account, readAt: startedAt });
          return account;
        })
        .finally(() => this.inFlight.delete(oid));
      this.inFlight.set(oid, pending);
    }
    return pending;
  }

  private async read(oid: string): Promise<UserAccount | null> {
    let user: { userType?: unknown; userPrincipalName?: unknown } | undefined;
    try {
      const request = () => {
        const r = this.graph.api(`/users/${oid}?$select=userType,userPrincipalName`);
        return (this.sdkRetries ? r : withoutSdkRetries(r)).get() as Promise<typeof user>;
      };
      user = (await withGraphRetry(request, this.retry, {
        sdkRetries: this.sdkRetries,
      })) as typeof user;
    } catch (err) {
      const status = graphStatus(err);
      if (status === 404) return null;
      throw new UserAccountReadError("The user's account could not be read", status, err);
    }
    if (typeof user?.userPrincipalName !== 'string') {
      throw new UserAccountReadError('The user response had no userPrincipalName');
    }
    // A missing type is read as none (`not_member`), never as a failure: one
    // legacy account must not wait forever as `identity_unverified`.
    const userType = user.userType;
    if (userType !== null && userType !== undefined && typeof userType !== 'string') {
      throw new UserAccountReadError('The user response had an unreadable userType');
    }
    return { userType: userType ?? '', userPrincipalName: user.userPrincipalName };
  }

  /** Keeps the cache bounded: expired entries go first, then the oldest. */
  private remember(oid: string, entry: CachedAccount): void {
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
