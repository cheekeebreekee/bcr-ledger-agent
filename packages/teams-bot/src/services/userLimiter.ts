/**
 * A per-worker flood guard for search: at most `limit` calls per `windowMs`
 * per key (the sender's AAD object id), over a sliding window.
 *
 * It is the cheapest of the search limits and the only one in the bot: it
 * stops a burst before it costs a token, an HTTP call or a quota row. The
 * durable limits (per user and per client, across workers) are ingestion's,
 * in `ledger.search_queries`. State is in memory, per worker, and bounded:
 * at most `maxKeys` keys are kept, the least recently added dropped first.
 */

export interface UserLimiterOptions {
  /** Calls allowed per key within the window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Most keys kept at once. Default 10 000. */
  readonly maxKeys?: number;
  /** Clock for tests; epoch milliseconds. */
  readonly now?: () => number;
}

export type LimiterVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Milliseconds until the oldest counted call leaves the window. */
      readonly retryAfterMs: number;
    };

/** The bot's default: 20 searches per minute per user, per worker. */
export const SEARCH_FLOOD_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export class UserLimiter {
  private readonly calls = new Map<string, number[]>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly opts: UserLimiterOptions) {
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Counts one call for `key` if the window has room; a refused call is not counted. */
  take(key: string): LimiterVerdict {
    const now = this.now();
    const normalised = key.toLowerCase();
    const recent = (this.calls.get(normalised) ?? []).filter((t) => now - t < this.opts.windowMs);

    if (recent.length >= this.opts.limit) {
      this.calls.set(normalised, recent);
      const oldest = recent[0] as number;
      return { ok: false, retryAfterMs: Math.max(0, oldest + this.opts.windowMs - now) };
    }

    recent.push(now);
    // Re-inserting moves the key to the end, so eviction drops the idlest first.
    this.calls.delete(normalised);
    this.calls.set(normalised, recent);
    this.evict(now);
    return { ok: true };
  }

  /** Keys currently held; for tests. */
  get size(): number {
    return this.calls.size;
  }

  private evict(now: number): void {
    if (this.calls.size <= this.maxKeys) return;
    for (const [key, times] of this.calls) {
      if (times.every((t) => now - t >= this.opts.windowMs)) this.calls.delete(key);
    }
    for (const key of this.calls.keys()) {
      if (this.calls.size <= this.maxKeys) break;
      this.calls.delete(key);
    }
  }
}
