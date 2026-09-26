/**
 * "Retry later" is not a classification result, and a transient failure must
 * never park a classifiable document in `98_`. But it cannot be forever
 * either: a document the model cannot read inside the 45 s timeout (a long
 * scan), or one the API answers with a 500 every time, would be retried on
 * every tick and resent by the bot user forever, and never reach a person.
 *
 * So each retry-later answer is sorted by its reason:
 *
 *  - **counted against the document** — `timeout`, `server_error` (a 5xx
 *    other than 529) and `connection`: the document itself may be the cause.
 *    After a bound, the document is filed for review with `RETRY_EXHAUSTED`
 *    (the acceptance policy's reason), with the last reason and status kept
 *    for the logs;
 *  - **never counted** — `rate_limited` (429), `overloaded` (529),
 *    `unavailable` (401–404) and `conflict` (409): the service's capacity or
 *    the account's configuration, never the document. However long they last,
 *    they never send a document to review.
 */
export const RETRY_REASONS_ABOUT_THE_DOCUMENT: ReadonlySet<string> = new Set([
  'timeout',
  'server_error',
  'connection',
]);

/** Whether a retry-later reason counts towards a document's bound. */
export function countsAgainstDocument(reason: string): boolean {
  return RETRY_REASONS_ABOUT_THE_DOCUMENT.has(reason);
}

/** Documents whose retry-later history is remembered at once. */
const MAX_TRACKED = 1000;

export interface RetryLaterBoundOptions {
  /** Counted retry-laters after which a document goes to review. At least 1. */
  readonly maxAttempts: number;
  /**
   * How long a document waits after its `n`-th counted retry-later before it
   * is tried again (0: no wait). Only counted answers wait.
   */
  readonly backoffMs?: (attempts: number) => number;
  /** A history older than this (from its first counted answer) starts again. */
  readonly windowMs?: number;
}

/** What one retry-later answer means for its document. */
export interface RetryLaterVerdict {
  /** Whether this answer counted towards the bound. */
  readonly counted: boolean;
  /** Counted answers so far, this one included. */
  readonly attempts: number;
  /** The bound is reached: file the document for review now. */
  readonly exhausted: boolean;
  /** When it may be tried again (epoch ms); `undefined` when it need not wait. */
  readonly notBefore?: number;
}

/** The last counted answer of a document. */
export interface RetryLaterLast {
  readonly attempts: number;
  readonly reason: string;
  readonly status?: number;
}

interface Entry extends RetryLaterLast {
  readonly firstAt: number;
  readonly notBefore: number;
}

/**
 * The retry-later history of documents, by a key the caller chooses: in the
 * channel inbox one version of one file (`driveItemId|eTag`), on the bot path
 * the client and the content's hash. In memory, per worker, bounded: a worker
 * restart forgets it, which only means a few more attempts.
 */
export class RetryLaterBound {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: RetryLaterBoundOptions) {}

  get maxAttempts(): number {
    return Math.max(1, this.opts.maxAttempts);
  }

  /** Records one retry-later answer for `key` at `nowMs`. */
  record(
    key: string,
    reason: string,
    status: number | undefined,
    nowMs: number,
  ): RetryLaterVerdict {
    const previous = this.current(key, nowMs);
    if (!countsAgainstDocument(reason)) {
      return { counted: false, attempts: previous?.attempts ?? 0, exhausted: false };
    }
    const attempts = (previous?.attempts ?? 0) + 1;
    const wait = Math.max(0, this.opts.backoffMs?.(attempts) ?? 0);
    const entry: Entry = {
      attempts,
      reason,
      ...(status !== undefined ? { status } : {}),
      firstAt: previous?.firstAt ?? nowMs,
      notBefore: nowMs + wait,
    };
    this.remember(key, entry);
    const exhausted = attempts >= this.maxAttempts;
    return {
      counted: true,
      attempts,
      exhausted,
      ...(!exhausted && wait > 0 ? { notBefore: entry.notBefore } : {}),
    };
  }

  /** Whether `key` is waiting out its backoff at `nowMs` (never once exhausted). */
  isWaiting(key: string, nowMs: number): boolean {
    const entry = this.current(key, nowMs);
    return entry !== undefined && entry.attempts < this.maxAttempts && nowMs < entry.notBefore;
  }

  /** The last counted answer, when `key` has reached the bound. */
  exhausted(key: string, nowMs: number): RetryLaterLast | undefined {
    const entry = this.current(key, nowMs);
    if (!entry || entry.attempts < this.maxAttempts) return undefined;
    return {
      attempts: entry.attempts,
      reason: entry.reason,
      ...(entry.status !== undefined ? { status: entry.status } : {}),
    };
  }

  /** The document was classified, filed or changed: its history no longer applies. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private current(key: string, nowMs: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.opts.windowMs !== undefined && nowMs - entry.firstAt >= this.opts.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key);
    if (this.entries.size >= MAX_TRACKED) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, entry);
  }
}

/** Doubling from `baseMs`, at most `maxMs`: 10, 20, 40, 80 min, … */
export function doublingBackoff(baseMs: number, maxMs: number): (attempts: number) => number {
  return (attempts) => Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}
