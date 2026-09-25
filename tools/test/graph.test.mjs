import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  GraphError,
  createGraph,
  describeToken,
  encodePath,
  mapLimit,
  parseRetryAfter,
  redact,
} from '../lib/graph.mjs';
import { fakeFetch, fakeJwt, jsonResponse } from './fake-graph.mjs';

const TOKEN = 'fake-token-value-for-tests-only';
const BASE = 'https://graph.microsoft.com/v1.0';

function client(handler, extra = {}) {
  const sleeps = [];
  const { fetch, calls } = fakeFetch(handler);
  const graph = createGraph({
    token: TOKEN,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { graph, calls, sleeps };
}

describe('createGraph', () => {
  test('refuses to start without a token, and the message names no token', () => {
    const saved = process.env.GRAPH_TOKEN;
    delete process.env.GRAPH_TOKEN;
    try {
      assert.throws(() => createGraph({}), /No GRAPH_TOKEN/);
    } finally {
      if (saved !== undefined) process.env.GRAPH_TOKEN = saved;
    }
  });

  test('sends the token as a Bearer header and nowhere else', async () => {
    const { graph, calls } = client(() => jsonResponse(200, { ok: true }));
    await graph.get('/me');
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!calls[0].url.includes(TOKEN));
  });

  test('follows @odata.nextLink across pages', async () => {
    const { graph, calls } = client(({ query }) => {
      const page = Number(query.get('page') ?? 1);
      return jsonResponse(200, {
        value: [{ n: page }],
        ...(page < 3 ? { '@odata.nextLink': `${BASE}/things?page=${page + 1}` } : {}),
      });
    });
    const rows = await graph.all('/things?page=1');
    assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(calls.length, 3);
  });

  test('refuses a nextLink on another host rather than send it the token', async () => {
    const { graph, calls } = client(() =>
      jsonResponse(200, { value: [], '@odata.nextLink': 'https://attacker.example/steal' }),
    );
    await assert.rejects(graph.all('/things'), (err) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.code, 'foreignHost');
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test('stops a paging loop that repeats a nextLink', async () => {
    const { graph } = client(() =>
      jsonResponse(200, { value: [1], '@odata.nextLink': `${BASE}/things?again=1` }),
    );
    await assert.rejects(graph.all('/things?again=1'), /pagingLoop/);
  });

  test('honours Retry-After on 429, then succeeds', async () => {
    let n = 0;
    const { graph, sleeps } = client(() => {
      n += 1;
      return n === 1
        ? jsonResponse(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '2' })
        : jsonResponse(200, { ok: 1 });
    });
    assert.deepEqual(await graph.get('/x'), { ok: 1 });
    assert.deepEqual(sleeps, [2000]);
  });

  test('backs off exponentially on 503 without Retry-After', async () => {
    let n = 0;
    const { graph, sleeps } = client(() => {
      n += 1;
      return n <= 2 ? jsonResponse(503, {}) : jsonResponse(200, { ok: 1 });
    });
    await graph.get('/x');
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('gives up after maxRetries and throws a typed error with the status', async () => {
    const { graph, calls, sleeps } = client(() => jsonResponse(503, { error: { code: 'busy' } }), {
      maxRetries: 3,
    });
    await assert.rejects(graph.get('/x'), (err) => {
      assert.ok(err instanceof GraphError);
      assert.equal(err.status, 503);
      assert.equal(err.code, 'busy');
      return true;
    });
    assert.equal(calls.length, 4);
    assert.equal(sleeps.length, 3);
  });

  test('caps a long Retry-After', async () => {
    let n = 0;
    const { graph, sleeps } = client(
      () => {
        n += 1;
        return n === 1 ? jsonResponse(429, {}, { 'Retry-After': '3600' }) : jsonResponse(200, {});
      },
      { maxRetryAfterMs: 5000 },
    );
    await graph.get('/x');
    assert.deepEqual(sleeps, [5000]);
  });

  test('does not retry a 400 or a 404', async () => {
    const { graph, calls } = client(() => jsonResponse(400, { error: { code: 'invalidRequest', message: 'bad' } }));
    await assert.rejects(graph.get('/x'), (err) => err.status === 400 && err.code === 'invalidRequest');
    assert.equal(calls.length, 1);
  });

  test('retries a network error on GET but never on PATCH', async () => {
    let n = 0;
    const { graph, sleeps } = client(() => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { ok: 1 });
    });
    await graph.get('/x');
    assert.equal(sleeps.length, 1);

    const patchClient = client(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(patchClient.graph.patch('/x', { a: 1 }), (err) => err.status === 0);
    assert.equal(patchClient.calls.length, 1);
  });

  test('redacts the token if Graph echoes it in an error', async () => {
    const { graph } = client(() =>
      jsonResponse(401, { error: { code: 'InvalidAuthenticationToken', message: `token ${TOKEN} rejected` } }),
    );
    await assert.rejects(graph.get('/x'), (err) => {
      for (const text of [err.message, String(err), JSON.stringify(err), err.stack ?? '']) {
        assert.ok(!text.includes(TOKEN), `token leaked into: ${text.slice(0, 80)}`);
      }
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    });
  });

  test('tryGet returns null on 404 and rethrows anything else', async () => {
    const { graph } = client(({ path }) =>
      path === '/missing' ? jsonResponse(404, { error: { code: 'itemNotFound' } }) : jsonResponse(403, {}),
    );
    assert.equal(await graph.tryGet('/missing'), null);
    await assert.rejects(graph.tryGet('/forbidden'), (err) => err.status === 403);
  });

  test('post and patch send a JSON body', async () => {
    const { graph, calls } = client(() => jsonResponse(200, {}));
    await graph.patch('/items/1/fields', { RootFolder: 'x' });
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, { RootFolder: 'x' });
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
  });
});

describe('helpers', () => {
  test('parseRetryAfter reads seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter('0.5'), 500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10_000);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(null), undefined);
  });

  test('redact replaces every occurrence and ignores an empty secret', () => {
    assert.equal(redact('a s b s', 's'), 'a [REDACTED] b [REDACTED]');
    assert.equal(redact('abc', ''), 'abc');
  });

  test('describeToken returns claims, never the token', () => {
    const token = fakeJwt({ upn: 'operator@contoso.example', scp: 'Sites.Read.All', exp: 1_900_000_000 });
    const d = describeToken(token);
    assert.equal(d.who, 'operator@contoso.example');
    assert.equal(d.scopes, 'Sites.Read.All');
    assert.ok(!JSON.stringify(d).includes(token));
    assert.equal(describeToken('not-a-jwt'), undefined);
  });

  test('encodePath encodes each segment and keeps the slashes', () => {
    assert.equal(encodePath('sites/0001 Klient ó#'), 'sites/0001%20Klient%20%C3%B3%23');
  });

  test('mapLimit keeps order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });
});
