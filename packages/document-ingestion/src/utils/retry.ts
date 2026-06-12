/**
 * Minimal retry helper. We rolled our own to keep the function bundle small
 * and avoid the ESM-only `p-retry`. Supports:
 *   - exponential backoff with jitter
 *   - throwing `AbortRetryError` from the operation to stop retrying
 *
 * @example
 *   const result = await retry(() => fetch('...'), { retries: 3 });
 */

export interface RetryOptions {
  /** Number of *additional* attempts on top of the initial one. Default: 2. */
  readonly retries?: number;
  /** Initial delay before the first retry, in ms. Default: 250. */
  readonly minTimeoutMs?: number;
  /** Multiplier between successive retries. Default: 2 (so 250, 500, 1000, …). */
  readonly factor?: number;
  /** Optional ceiling on a single sleep, in ms. Default: 10_000. */
  readonly maxTimeoutMs?: number;
  /** Jitter multiplier in [0, 1]. Default: 0.2 (so up to ±20%). */
  readonly jitter?: number;
}

/** Throw this inside the operation to immediately stop retrying. */
export class AbortRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortRetryError';
  }
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const minTimeoutMs = opts.minTimeoutMs ?? 250;
  const factor = opts.factor ?? 2;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 10_000;
  const jitter = Math.max(0, Math.min(1, opts.jitter ?? 0.2));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err instanceof AbortRetryError) throw err;
      if (attempt === retries) break;
      const base = Math.min(maxTimeoutMs, minTimeoutMs * Math.pow(factor, attempt));
      const jitterMs = base * jitter * (Math.random() * 2 - 1);
      const delay = Math.max(0, base + jitterMs);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
