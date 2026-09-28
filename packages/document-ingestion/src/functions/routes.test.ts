import type { HttpHandler, HttpRequest, InvocationContext } from '@azure/functions';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { AuthMiddleware, SEARCH_ROLE } from '../auth/authMiddleware';

/**
 * The app's HTTP surface, pinned. Every route that takes a user id from the
 * body is listed here with its one caller, and each verifies that caller
 * before it reads a byte of the body. A new route, or one that reads first,
 * fails here before it can ship.
 */

const TENANT = '379013e4-0000-4000-8000-000000000001';
const AUDIENCE = 'api://ingestion-app';
/** The bot app registration (its secret files documents: Documents.Ingest). */
const BOT_APP = '3ee1ba6c-0000-4000-8000-000000000002';
/** The bot Function App's managed identity (Documents.Search). */
const BOT_MI = '7d0c3f6a-5b1e-4c2d-9e8f-0a1b2c3d4e5f';
const OID = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';

const mockHttp = jest.fn();
const mockTimer = jest.fn();
jest.mock('@azure/functions', () => ({ app: { http: mockHttp, timer: mockTimer } }));

let mockAuth: AuthMiddleware;
const mockSearch = jest.fn();
const mockIngest = jest.fn();
jest.mock('../runtime', () => ({
  auth: {
    verify: (header: unknown, policy: unknown) => mockAuth.verify(header as never, policy as never),
  },
  config: {
    azureTenantId: '379013e4-0000-4000-8000-000000000001',
    expectedRoles: ['Documents.Ingest'],
    botCallerAppIds: ['3ee1ba6c-0000-4000-8000-000000000002'],
    searchCallerAppIds: ['7d0c3f6a-5b1e-4c2d-9e8f-0a1b2c3d4e5f'],
  },
  batchIngestor: { ingestBatch: (...a: unknown[]) => mockIngest(...a) },
  clientSearch: { search: (...a: unknown[]) => mockSearch(...a) },
  channelInbox: { mode: 'off' },
  reviewNotifier: undefined,
}));

import '../index';

let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  mockAuth = new AuthMiddleware({
    tenantId: TENANT,
    expectedAudience: AUDIENCE,
    keySet: createLocalJWKSet({ keys: [jwk] }),
  });
});

beforeEach(() => {
  mockSearch.mockReset().mockResolvedValue({ status: 'no_access' });
  mockIngest.mockReset().mockResolvedValue([]);
});

async function token(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ tid: TENANT, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://sts.windows.net/${TENANT}/`)
    .setAudience(AUDIENCE)
    .setSubject('sp-object-id')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

const botSecretToken = () => token({ appid: BOT_APP, roles: ['Documents.Ingest'] });
const botMiToken = () => token({ appid: BOT_MI, roles: [SEARCH_ROLE] });
const foreignTenantToken = () =>
  token({ appid: BOT_MI, roles: [SEARCH_ROLE], tid: '11111111-1111-1111-1111-111111111111' });

interface Registration {
  readonly route: string;
  readonly methods: readonly string[];
  readonly authLevel: string;
  readonly handler: HttpHandler;
}

function registered(): Record<string, Registration> {
  return Object.fromEntries(
    mockHttp.mock.calls.map(([name, options]) => [name as string, options as Registration]),
  );
}

function request(authorization: string | undefined, body: unknown) {
  const json = jest.fn(async () => body);
  const headers = new Headers(authorization ? { authorization } : {});
  return { req: { headers, json } as unknown as HttpRequest, json };
}

const context = { invocationId: 'inv-1' } as InvocationContext;

const searchBody = {
  source: {
    tenantId: TENANT,
    conversationId: 'conv-1',
    activityId: 'act-1',
    conversationType: 'personal',
    userAadObjectId: OID,
  },
  query: { kind: 'question', text: 'faktury z marca' },
};

describe('the HTTP routes', () => {
  it('are exactly health, the batch upload and client search', () => {
    expect(Object.keys(registered()).sort()).toEqual([
      'clientSearch',
      'health',
      'ingestDocumentsBatch',
    ]);
    expect(mockTimer.mock.calls.map(([name]) => name).sort()).toEqual([
      'inboxSweep',
      'reviewNotify',
    ]);
  });

  it('pin each route, method and auth level', () => {
    const routes = Object.fromEntries(
      Object.entries(registered()).map(([name, r]) => [name, [r.route, r.methods, r.authLevel]]),
    );
    expect(routes).toEqual({
      health: ['health', ['GET'], 'anonymous'],
      // Anonymous at the host on purpose: each verifies the JWT itself.
      ingestDocumentsBatch: ['ingest/batch', ['POST'], 'anonymous'],
      clientSearch: ['search', ['POST'], 'anonymous'],
    });
  });
});

describe('every route that reads a body verifies its caller first', () => {
  const search = () => registered()['clientSearch']!.handler;
  const batch = () => registered()['ingestDocumentsBatch']!.handler;

  it.each([
    ['no Authorization header', async () => undefined, 401],
    ['a non-Bearer header', async () => 'Basic abc', 401],
    [
      "the bot secret's token (Documents.Ingest, bot app id)",
      async () => `Bearer ${await botSecretToken()}`,
      403,
    ],
    ['a token from another tenant', async () => `Bearer ${await foreignTenantToken()}`, 401],
    [
      'the managed identity without the role',
      async () => `Bearer ${await token({ appid: BOT_MI, roles: ['Documents.Ingest'] })}`,
      403,
    ],
  ])('search refuses %s without reading the body', async (_label, header, status) => {
    const { req, json } = request(await header(), searchBody);
    const res = await search()(req, context);
    expect(res.status).toBe(status);
    expect(json).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it.each([
    ['no Authorization header', async () => undefined, 401],
    ["the bot managed identity's search token", async () => `Bearer ${await botMiToken()}`, 403],
    ['a token from another tenant', async () => `Bearer ${await foreignTenantToken()}`, 401],
  ])('the batch upload refuses %s without reading the body', async (_label, header, status) => {
    const { req, json } = request(await header(), {});
    const res = await batch()(req, context);
    expect(res.status).toBe(status);
    expect(json).not.toHaveBeenCalled();
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("search reads the body once for the managed identity's token, and answers with the service", async () => {
    mockSearch.mockResolvedValue({ status: 'disabled' });
    const { req, json } = request(`Bearer ${await botMiToken()}`, {
      ...searchBody,
      source: { ...searchBody.source, userAadObjectId: OID.toUpperCase() },
    });
    const res = await search()(req, context);
    expect(res).toEqual({ status: 200, jsonBody: { status: 'disabled' } });
    expect(json).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch.mock.calls[0]![0]).toEqual(searchBody);
  });

  it('search answers 400 to a body that names a client, before the service', async () => {
    const { req } = request(`Bearer ${await botMiToken()}`, { ...searchBody, clientId: '0002' });
    const res = await search()(req, context);
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ status: 'rejected', error: { code: 'ValidationError' } });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('search answers 400, not 500, to a body that is not JSON', async () => {
    const json = jest.fn(async () => {
      throw new SyntaxError('Unexpected token');
    });
    const req = {
      headers: new Headers({ authorization: `Bearer ${await botMiToken()}` }),
      json,
    } as unknown as HttpRequest;
    const res = await search()(req, context);
    expect(res.status).toBe(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('search answers a generic 500 to anything unexpected, with no detail', async () => {
    mockSearch.mockRejectedValue(new Error('boom: Kowalski'));
    const { req } = request(`Bearer ${await botMiToken()}`, searchBody);
    const res = await search()(req, context);
    expect(res).toEqual({
      status: 500,
      jsonBody: { status: 'rejected', error: { code: 'InternalError', message: 'Internal error' } },
    });
  });

  it("the batch upload still reads the body for the bot secret's token", async () => {
    const { req, json } = request(`Bearer ${await botSecretToken()}`, {});
    const res = await batch()(req, context);
    expect(json).toHaveBeenCalledTimes(1);
    // An empty body is refused by validation, after auth.
    expect(res.status).toBe(400);
  });
});
