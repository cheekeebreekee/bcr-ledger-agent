import { SEARCH_FLOOD_LIMIT, UserLimiter } from './userLimiter';

const OID = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

function limiter(opts: { limit?: number; windowMs?: number; maxKeys?: number } = {}) {
  let now = 1_000_000;
  const l = new UserLimiter({
    limit: opts.limit ?? 3,
    windowMs: opts.windowMs ?? 60_000,
    ...(opts.maxKeys !== undefined ? { maxKeys: opts.maxKeys } : {}),
    now: () => now,
  });
  return {
    l,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('UserLimiter', () => {
  it('defaults to 20 searches per minute per user', () => {
    expect(SEARCH_FLOOD_LIMIT).toEqual({ limit: 20, windowMs: 60_000 });
  });

  it('allows the limit within the window, then refuses with the wait until a slot frees', () => {
    const { l, advance } = limiter();
    expect([l.take(OID), l.take(OID)]).toEqual([{ ok: true }, { ok: true }]);
    advance(10_000);
    expect(l.take(OID)).toEqual({ ok: true });
    advance(5_000);
    expect(l.take(OID)).toEqual({ ok: false, retryAfterMs: 45_000 });
  });

  it('does not count a refused call', () => {
    const { l, advance } = limiter({ limit: 1 });
    l.take(OID);
    for (let i = 0; i < 5; i += 1) expect(l.take(OID).ok).toBe(false);
    advance(60_000);
    expect(l.take(OID)).toEqual({ ok: true });
  });

  it('slides: a call leaves the window a full window after it was made', () => {
    const { l, advance } = limiter({ limit: 2 });
    l.take(OID);
    advance(30_000);
    l.take(OID);
    advance(29_999);
    expect(l.take(OID).ok).toBe(false);
    advance(1);
    expect(l.take(OID)).toEqual({ ok: true });
  });

  it('counts each user apart, whatever the case of the id', () => {
    const { l } = limiter({ limit: 1 });
    expect(l.take(OID).ok).toBe(true);
    expect(l.take(OID.toUpperCase()).ok).toBe(false);
    expect(l.take(OTHER).ok).toBe(true);
  });

  it('keeps at most maxKeys users, dropping idle ones first', () => {
    const { l, advance } = limiter({ limit: 1, maxKeys: 2 });
    l.take('a');
    advance(61_000);
    l.take('b');
    l.take('c');
    expect(l.size).toBe(2);
    // 'a' was idle and went first; 'b' and 'c' are still limited.
    expect(l.take('b').ok).toBe(false);
    expect(l.take('c').ok).toBe(false);
  });

  it('drops the least recently used key when none is idle', () => {
    const { l } = limiter({ limit: 1, maxKeys: 2 });
    l.take('a');
    l.take('b');
    l.take('c');
    expect(l.size).toBe(2);
    expect(l.take('a').ok).toBe(true);
  });
});
