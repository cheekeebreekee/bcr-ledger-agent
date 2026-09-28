import type { SearchRequestPayload } from '@bcr/shared';
import {
  managedIdentityToken,
  parseSearchResponse,
  SEARCH_TIMEOUT_MS,
  SearchClient,
  type SearchFetcher,
} from './searchClient';

// Placeholder GUIDs — not real tenants or users.
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_OID = '33333333-3333-4333-8333-333333333333';
const QUESTION = 'faktury od Dostawca Tajny z marca';
const TOKEN = 'eyJ.placeholder.token';

const payload: SearchRequestPayload = {
  source: {
    tenantId: TENANT,
    conversationId: 'conv-personal',
    activityId: 'activity-1',
    conversationType: 'personal',
    userAadObjectId: USER_OID,
  },
  query: { kind: 'question', text: QUESTION },
};

const okBody = {
  status: 'ok',
  scopeLabel: 'Firma Testowa',
  filter: { categories: ['faktury_zakupu'] },
  total: 1,
  totalCapped: false,
  items: [
    {
      documentId: 'doc-1',
      status: 'filed',
      category: 'faktury_zakupu',
      documentMonth: '2026-03',
      invoiceNumber: 'FV/1/2026',
      issueDate: '2026-03-02',
      grossAmount: '123.45',
      currency: 'PLN',
      counterpartyName: 'Dostawca',
      counterpartyNip: '1234563218',
      webUrl: 'https://bcr.sharepoint.test/sites/Klient/a.pdf',
    },
  ],
  nextCursor: null,
  notes: [],
};

function respond(statusCode: number, body: unknown) {
  const text = jest.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)));
  const fetcher = jest.fn<ReturnType<SearchFetcher>, Parameters<SearchFetcher>>(async () => ({
    statusCode,
    body: { text },
  }));
  return { fetcher, text };
}

function logger() {
  return { info: jest.fn(), warn: jest.fn() };
}

function client(
  fetcher: SearchFetcher,
  overrides: Partial<ConstructorParameters<typeof SearchClient>[0]> = {},
) {
  const log = logger();
  const acquireToken = jest.fn(async (_signal: AbortSignal) => TOKEN);
  const c = new SearchClient({
    baseUrl: 'https://ingestion.example.test',
    scope: 'api://placeholder/.default',
    fetcher,
    acquireToken,
    logger: log,
    ...overrides,
  });
  return { c, log, acquireToken };
}

describe('SearchClient', () => {
  it('POSTs the payload as it is to /api/search with a bearer token', async () => {
    const { fetcher, text } = respond(200, okBody);
    const { c, acquireToken } = client(fetcher);

    const answer = await c.search(payload);

    expect(answer).toEqual(okBody);
    expect(acquireToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://ingestion.example.test/api/search');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options?.body ?? '')).toEqual(payload);
    expect(text).toHaveBeenCalled();
  });

  it('never logs the question, the token or a body', async () => {
    const { fetcher } = respond(200, okBody);
    const { c, log } = client(fetcher);
    await c.search(payload);
    await client(respond(500, `boom ${QUESTION}`).fetcher).c.search(payload);

    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).not.toContain(QUESTION);
    expect(logged).not.toContain(TOKEN);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200, kind: 'question', status: 'ok' }),
      'search.call',
    );
  });

  it.each([400, 401, 403, 500, 503])('answers unavailable for HTTP %i', async (status) => {
    const { fetcher, text } = respond(status, { error: { code: 'X', message: QUESTION } });
    const { c, log } = client(fetcher);
    expect(await c.search(payload)).toEqual({ status: 'unavailable' });
    expect(text).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: status }),
      'search.http_error',
    );
  });

  it('answers unavailable for a body that is not JSON', async () => {
    const { c, log } = client(respond(200, '<html>').fetcher);
    expect(await c.search(payload)).toEqual({ status: 'unavailable' });
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'search.bad_response');
  });

  it('answers unavailable for JSON outside the contract', async () => {
    const { c, log } = client(respond(200, { status: 'ok' }).fetcher);
    expect(await c.search(payload)).toEqual({ status: 'unavailable' });
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'search.bad_response');
  });

  it('answers unavailable when no token can be had, without calling ingestion', async () => {
    const { fetcher } = respond(200, okBody);
    const { c, log } = client(fetcher, {
      acquireToken: async () => {
        throw new Error('ManagedIdentityCredential: no endpoint');
      },
    });
    expect(await c.search(payload)).toEqual({ status: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timedOut: false, kind: 'question' }),
      'search.call_failed',
    );
  });

  it('gives up after its timeout, aborting the request', async () => {
    let seen: AbortSignal | undefined;
    const fetcher: SearchFetcher = (_url, options) =>
      new Promise((_resolve, reject) => {
        seen = options.signal;
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { c, log } = client(fetcher, { timeoutMs: 10 });
    expect(await c.search(payload)).toEqual({ status: 'unavailable' });
    expect(seen?.aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timedOut: true }),
      'search.call_failed',
    );
  });

  it('gives up on time even when a call ignores the abort', async () => {
    const fetcher: SearchFetcher = () => new Promise(() => undefined);
    const { c } = client(fetcher, { timeoutMs: 10 });
    expect(await c.search(payload)).toEqual({ status: 'unavailable' });
  });

  it('waits 20 s by default', () => {
    expect(SEARCH_TIMEOUT_MS).toBe(20_000);
  });

  it('builds its defaults without calling anything', () => {
    expect(
      () => new SearchClient({ baseUrl: 'https://x.test', scope: 'api://placeholder/.default' }),
    ).not.toThrow();
  });
});

describe('managedIdentityToken', () => {
  it('asks the credential for the ingestion scope, passing the abort signal', async () => {
    const getToken = jest.fn(async () => ({ token: TOKEN, expiresOnTimestamp: 0 }));
    const signal = new AbortController().signal;
    const token = await managedIdentityToken('api://placeholder/.default', { getToken })(signal);
    expect(token).toBe(TOKEN);
    expect(getToken).toHaveBeenCalledWith('api://placeholder/.default', { abortSignal: signal });
  });

  it('throws when the credential returns no token', async () => {
    const getToken = jest.fn(async () => null);
    await expect(
      managedIdentityToken('api://placeholder/.default', { getToken })(
        new AbortController().signal,
      ),
    ).rejects.toThrow(/no token/);
  });
});

describe('parseSearchResponse', () => {
  it.each(['help', 'no_access', 'unavailable', 'disabled'])(
    'keeps only the status of %s',
    (status) => {
      expect(parseSearchResponse({ status, reason: 'membership_mismatch', extra: 1 })).toEqual({
        status,
      });
    },
  );

  it('keeps not_understood with a known reason only', () => {
    expect(parseSearchResponse({ status: 'not_understood', reason: 'unsupported' })).toEqual({
      status: 'not_understood',
      reason: 'unsupported',
    });
    expect(parseSearchResponse({ status: 'not_understood', reason: 'why' })).toBeNull();
  });

  it('keeps rate_limited with a finite, non-negative wait only', () => {
    expect(parseSearchResponse({ status: 'rate_limited', retryAfterSeconds: 60 })).toEqual({
      status: 'rate_limited',
      retryAfterSeconds: 60,
    });
    for (const retryAfterSeconds of [-1, '60', null, Number.POSITIVE_INFINITY]) {
      expect(parseSearchResponse({ status: 'rate_limited', retryAfterSeconds })).toBeNull();
    }
  });

  it('rebuilds an ok answer from its known fields only', () => {
    const parsed = parseSearchResponse({
      ...okBody,
      clientId: 'x',
      items: [{ ...okBody.items[0], uploadedByOid: USER_OID, confidence: 0.4 }],
      notes: ['nip_dropped', 'nip_dropped', 'surprise'],
    });
    expect(parsed).toEqual({ ...okBody, notes: ['nip_dropped'] });
    expect(JSON.stringify(parsed)).not.toMatch(/uploadedByOid|confidence|clientId/);
  });

  it('reads missing optional values as null and drops an overlong link', () => {
    const parsed = parseSearchResponse({
      ...okBody,
      nextCursor: undefined,
      notes: undefined,
      items: [
        {
          documentId: 'doc-1',
          status: 'in_review',
          category: 'nieposortowane',
          webUrl: `https://x.test/${'a'.repeat(2048)}`,
        },
      ],
    });
    expect(parsed).toMatchObject({
      nextCursor: null,
      notes: [],
      items: [
        {
          documentMonth: null,
          invoiceNumber: null,
          issueDate: null,
          grossAmount: null,
          currency: null,
          counterpartyName: null,
          counterpartyNip: null,
          webUrl: null,
        },
      ],
    });
  });

  it.each<[string, unknown]>([
    ['not an object', 'ok'],
    ['an unknown status', { status: 'maybe' }],
    ['a filter outside the schema', { ...okBody, filter: { clientId: 'x' } }],
    ['a scope label that is not text', { ...okBody, scopeLabel: 5 }],
    ['a negative total', { ...okBody, total: -1 }],
    ['a fractional total', { ...okBody, total: 1.5 }],
    ['no totalCapped', { ...okBody, totalCapped: undefined }],
    ['items that are not a list', { ...okBody, items: {} }],
    ['more items than a page', { ...okBody, items: Array(11).fill(okBody.items[0]) }],
    ['an item that is not an object', { ...okBody, items: ['x'] }],
    ['an item without an id', { ...okBody, items: [{ ...okBody.items[0], documentId: 1 }] }],
    ['an item with an unknown status', { ...okBody, items: [{ ...okBody.items[0], status: 'x' }] }],
    ['an unknown category', { ...okBody, items: [{ ...okBody.items[0], category: 'tajne' }] }],
    ['a field that is not text', { ...okBody, items: [{ ...okBody.items[0], grossAmount: 12.5 }] }],
    [
      'an overlong field',
      { ...okBody, items: [{ ...okBody.items[0], counterpartyName: 'x'.repeat(1001) }] },
    ],
    ['a link that is not text', { ...okBody, items: [{ ...okBody.items[0], webUrl: 1 }] }],
    ['an empty cursor', { ...okBody, nextCursor: '' }],
    ['an overlong cursor', { ...okBody, nextCursor: 'c'.repeat(257) }],
  ])('refuses %s', (_label, value) => {
    expect(parseSearchResponse(value)).toBeNull();
  });
});
