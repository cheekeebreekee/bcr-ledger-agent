import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { ForbiddenError, UnauthorizedError } from '@bcr/shared';
import { AuthMiddleware, SEARCH_ROLE, type CallerPolicy } from './authMiddleware';

const TENANT = '379013e4-0000-4000-8000-000000000001';
const AUDIENCE = 'api://ingestion-app';
const BOT_APP = '3ee1ba6c-0000-4000-8000-000000000002';
const OTHER_APP = '9d1e2f3a-0000-4000-8000-000000000003';

const policy: CallerPolicy = { roles: ['Documents.Ingest'], appIds: [BOT_APP] };

let privateKey: CryptoKey;
let auth: AuthMiddleware;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  auth = new AuthMiddleware({
    tenantId: TENANT,
    expectedAudience: AUDIENCE,
    keySet: createLocalJWKSet({ keys: [jwk] }),
  });
});

async function token(claims: Record<string, unknown>, opts: { issuer?: string; audience?: string } = {}) {
  return new SignJWT({ tid: TENANT, roles: ['Documents.Ingest'], appid: BOT_APP, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? `https://sts.windows.net/${TENANT}/`)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject('sp-object-id')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('AuthMiddleware.verify', () => {
  it('accepts the bot app with the ingest role', async () => {
    const caller = await auth.verify(`Bearer ${await token({})}`, policy);
    expect(caller).toEqual({
      subject: 'sp-object-id',
      appId: BOT_APP,
      tenantId: TENANT,
      roles: ['Documents.Ingest'],
    });
  });

  it('reads the caller from azp on v2 tokens', async () => {
    const t = await token(
      { appid: undefined, azp: BOT_APP },
      { issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` },
    );
    await expect(auth.verify(`Bearer ${t}`, policy)).resolves.toMatchObject({ appId: BOT_APP });
  });

  it('matches app ids case-insensitively', async () => {
    const t = await token({ appid: BOT_APP.toUpperCase() });
    await expect(auth.verify(`Bearer ${t}`, policy)).resolves.toBeDefined();
  });

  it.each([
    ['no header', undefined],
    ['a non-Bearer scheme', 'Basic abc'],
    ['a Bearer scheme without a token', 'Bearer'],
  ])('rejects %s with 401', async (_label, header) => {
    await expect(auth.verify(header, policy)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token for another audience', async () => {
    const t = await token({}, { audience: 'api://someone-else' });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token from another issuer', async () => {
    const t = await token({}, { issuer: 'https://sts.windows.net/other-tenant/' });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token whose tid is another tenant', async () => {
    const t = await token({ tid: '11111111-1111-1111-1111-111111111111' });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a caller without the role with 403', async () => {
    const t = await token({ roles: ['Something.Else'] });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a caller whose roles claim is not a list', async () => {
    const t = await token({ roles: 'Documents.Ingest' });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(ForbiddenError);
  });

  // The role alone used to be enough: any app granted Documents.Ingest could
  // assert any user id and file into that user's client.
  it('rejects the right role held by an app that is not on the allow-list', async () => {
    const t = await token({ appid: OTHER_APP });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a token with no app id at all', async () => {
    const t = await token({ appid: undefined });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// Search is pinned to the bot Function App's managed identity with its own
// role; the bot registration's secret (Documents.Ingest, the bot's app id)
// files documents and must never read them.
describe('AuthMiddleware.verify: the search route and the batch route', () => {
  const BOT_MI = '7d0c3f6a-5b1e-4c2d-9e8f-0a1b2c3d4e5f';
  const searchPolicy: CallerPolicy = { roles: [SEARCH_ROLE], appIds: [BOT_MI] };
  const miToken = () => token({ appid: BOT_MI, roles: [SEARCH_ROLE] });

  it('names the role Documents.Search', () => {
    expect(SEARCH_ROLE).toBe('Documents.Search');
  });

  it("accepts the bot managed identity's token with Documents.Search on the search route", async () => {
    await expect(auth.verify(`Bearer ${await miToken()}`, searchPolicy)).resolves.toMatchObject({
      appId: BOT_MI,
      roles: [SEARCH_ROLE],
    });
  });

  it("refuses the bot secret's token (Documents.Ingest, the bot app id) on the search route", async () => {
    const t = await token({});
    await expect(auth.verify(`Bearer ${t}`, searchPolicy)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses the bot app id even if it held Documents.Search', async () => {
    const t = await token({ roles: [SEARCH_ROLE] });
    await expect(auth.verify(`Bearer ${t}`, searchPolicy)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses the managed identity's token on the batch route", async () => {
    await expect(auth.verify(`Bearer ${await miToken()}`, policy)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses the managed identity with the ingest role on the batch route (app id not listed)', async () => {
    const t = await token({ appid: BOT_MI, roles: ['Documents.Ingest'] });
    await expect(auth.verify(`Bearer ${t}`, policy)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses every caller while SEARCH_CALLER_APP_IDS is empty', async () => {
    await expect(
      auth.verify(`Bearer ${await miToken()}`, { roles: [SEARCH_ROLE], appIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('AuthMiddleware default key set', () => {
  it('builds a remote JWKS for the tenant when none is injected', () => {
    expect(() => new AuthMiddleware({ tenantId: TENANT, expectedAudience: AUDIENCE })).not.toThrow();
  });
});
