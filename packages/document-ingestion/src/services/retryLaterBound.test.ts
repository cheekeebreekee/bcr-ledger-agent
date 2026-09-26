import {
  countsAgainstDocument,
  doublingBackoff,
  RETRY_REASONS_ABOUT_THE_DOCUMENT,
  RetryLaterBound,
} from './retryLaterBound';

const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const MIN = 60_000;

describe('countsAgainstDocument', () => {
  it.each(['timeout', 'server_error', 'connection'])(
    'counts %s: the document may cause it',
    (r) => {
      expect(countsAgainstDocument(r)).toBe(true);
    },
  );

  // The 26 September evaluation: 529s parked classifiable documents in 98_.
  it.each(['rate_limited', 'overloaded', 'unavailable', 'conflict', 'anything_else'])(
    'never counts %s: capacity or configuration, not the document',
    (r) => {
      expect(countsAgainstDocument(r)).toBe(false);
    },
  );

  it('names exactly the three reasons', () => {
    expect([...RETRY_REASONS_ABOUT_THE_DOCUMENT].sort()).toEqual([
      'connection',
      'server_error',
      'timeout',
    ]);
  });
});

describe('RetryLaterBound', () => {
  it('counts only the reasons about the document, up to the bound', () => {
    const bound = new RetryLaterBound({ maxAttempts: 3 });
    expect(bound.record('k', 'overloaded', 529, T0)).toEqual({
      counted: false,
      attempts: 0,
      exhausted: false,
    });
    expect(bound.record('k', 'timeout', undefined, T0)).toMatchObject({
      counted: true,
      attempts: 1,
      exhausted: false,
    });
    expect(bound.record('k', 'rate_limited', 429, T0)).toMatchObject({
      counted: false,
      attempts: 1,
    });
    expect(bound.record('k', 'server_error', 500, T0)).toMatchObject({ attempts: 2 });
    expect(bound.exhausted('k', T0)).toBeUndefined();
    expect(bound.record('k', 'connection', undefined, T0)).toEqual({
      counted: true,
      attempts: 3,
      exhausted: true,
    });
    expect(bound.exhausted('k', T0)).toEqual({ attempts: 3, reason: 'connection' });
  });

  it('never exhausts on capacity or configuration answers, however many', () => {
    const bound = new RetryLaterBound({ maxAttempts: 2 });
    for (let i = 0; i < 50; i += 1) {
      expect(bound.record('k', i % 2 ? 'overloaded' : 'unavailable', 529, T0).exhausted).toBe(
        false,
      );
    }
    expect(bound.exhausted('k', T0)).toBeUndefined();
    expect(bound.size).toBe(0);
  });

  it('keeps the status of the last counted answer', () => {
    const bound = new RetryLaterBound({ maxAttempts: 2 });
    bound.record('k', 'timeout', undefined, T0);
    bound.record('k', 'server_error', 502, T0);
    expect(bound.exhausted('k', T0)).toEqual({ attempts: 2, reason: 'server_error', status: 502 });
  });

  it('waits out the backoff after a counted answer, and never once exhausted', () => {
    const bound = new RetryLaterBound({
      maxAttempts: 3,
      backoffMs: doublingBackoff(10 * MIN, 120 * MIN),
    });
    expect(bound.record('k', 'timeout', undefined, T0)).toMatchObject({
      notBefore: T0 + 10 * MIN,
    });
    expect(bound.isWaiting('k', T0 + 9 * MIN)).toBe(true);
    expect(bound.isWaiting('k', T0 + 10 * MIN)).toBe(false);
    expect(bound.record('k', 'timeout', undefined, T0 + 10 * MIN)).toMatchObject({
      notBefore: T0 + 30 * MIN,
    });
    const last = bound.record('k', 'timeout', undefined, T0 + 30 * MIN);
    expect(last).toEqual({ counted: true, attempts: 3, exhausted: true });
    expect(bound.isWaiting('k', T0 + 31 * MIN)).toBe(false);
    // An uncounted answer starts no wait.
    expect(bound.record('other', 'overloaded', 529, T0)).not.toHaveProperty('notBefore');
    expect(bound.isWaiting('other', T0)).toBe(false);
  });

  it('keeps keys apart, and forgets one on request', () => {
    const bound = new RetryLaterBound({ maxAttempts: 2 });
    bound.record('item|v1', 'timeout', undefined, T0);
    expect(bound.record('item|v2', 'timeout', undefined, T0).attempts).toBe(1);
    bound.forget('item|v1');
    expect(bound.record('item|v1', 'timeout', undefined, T0).attempts).toBe(1);
  });

  it('starts again once the window since the first counted answer has passed', () => {
    const bound = new RetryLaterBound({ maxAttempts: 3, windowMs: 24 * 60 * MIN });
    bound.record('k', 'timeout', undefined, T0);
    bound.record('k', 'timeout', undefined, T0 + 60 * MIN);
    expect(bound.record('k', 'timeout', undefined, T0 + 24 * 60 * MIN).attempts).toBe(1);
    expect(bound.isWaiting('k', T0 + 48 * 60 * MIN)).toBe(false);
    expect(bound.exhausted('k', T0 + 48 * 60 * MIN)).toBeUndefined();
  });

  it('remembers at most 1000 documents, dropping the oldest', () => {
    const bound = new RetryLaterBound({ maxAttempts: 2 });
    for (let i = 0; i <= 1000; i += 1) bound.record(`k${i}`, 'timeout', undefined, T0);
    expect(bound.size).toBe(1000);
    expect(bound.record('k0', 'timeout', undefined, T0).attempts).toBe(1);
    expect(bound.record('k1000', 'timeout', undefined, T0).attempts).toBe(2);
  });

  it('treats a bound below 1 as 1', () => {
    const bound = new RetryLaterBound({ maxAttempts: 0 });
    expect(bound.maxAttempts).toBe(1);
    expect(bound.record('k', 'timeout', undefined, T0).exhausted).toBe(true);
  });
});

describe('doublingBackoff', () => {
  it('doubles from the base and stops at the cap', () => {
    const backoff = doublingBackoff(10 * MIN, 120 * MIN);
    expect([1, 2, 3, 4, 5, 6].map((n) => backoff(n) / MIN)).toEqual([10, 20, 40, 80, 120, 120]);
    expect(backoff(0)).toBe(10 * MIN);
  });
});
