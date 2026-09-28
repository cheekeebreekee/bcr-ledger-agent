import { generateKeyPairSync, sign } from 'node:crypto';
import { ConfigurationBotFrameworkAuthentication } from 'botbuilder';
import { AuthenticationConstants } from 'botframework-connector';
import { JwtTokenExtractor } from 'botframework-connector/lib/auth/jwtTokenExtractor';
import { createBotFrameworkAuth, requireChannelIssuer } from './channelAuth';

// Offline stand-ins for the Bot Framework's and AAD's signing keys: the SDK
// caches OpenID metadata per URL, so both token paths verify against these.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
JwtTokenExtractor.openIdMetadataCache.set(
  AuthenticationConstants.ToBotFromChannelOpenIdMetadataUrl,
  {
    getKey: async (kid: string) =>
      kid === 'channel' ? { key: pem, endorsements: ['msteams'] } : null,
  } as never,
);
JwtTokenExtractor.openIdMetadataCache.set(
  AuthenticationConstants.ToBotFromEmulatorOpenIdMetadataUrl,
  {
    getKey: async (kid: string) => (kid === 'aad' ? { key: pem, endorsements: [] } : null),
  } as never,
);

const BOT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/';
const OPTIONS = {
  MicrosoftAppId: BOT,
  MicrosoftAppPassword: 'not-a-secret',
  MicrosoftAppType: 'SingleTenant',
  MicrosoftAppTenantId: TENANT,
};

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(kid: string, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64url({ alg: 'RS256', typ: 'JWT', kid })}.${b64url({ nbf: now - 60, exp: now + 600, ...claims })}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), privateKey).toString('base64url')}`;
}

function activity(serviceUrl = SERVICE_URL) {
  return {
    type: 'message',
    channelId: 'msteams',
    serviceUrl,
    conversation: { id: 'a:1', conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    from: { id: '29:1', aadObjectId: '33333333-3333-4333-8333-333333333333' },
  } as never;
}

/** What someone holding only the bot secret can mint: an AAD client-credentials token for the bot. */
const emulatorToken = () =>
  token('aad', {
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: BOT,
    appid: BOT,
    ver: '1.0',
    tid: TENANT,
  });

const channelToken = (serviceurl = SERVICE_URL) =>
  token('channel', { iss: 'https://api.botframework.com', aud: BOT, serviceurl });

describe('createBotFrameworkAuth', () => {
  it('accepts a Bot Framework channel token', async () => {
    const auth = createBotFrameworkAuth(OPTIONS);
    const result = await auth.authenticateRequest(activity(), `Bearer ${channelToken()}`);
    expect(result.claimsIdentity.getClaimValue('iss')).toBe('https://api.botframework.com');
  });

  it('refuses an emulator token minted with the bot secret, which the SDK default accepts', async () => {
    // The hole this closes: the SDK's own default lets it through, replying to any serviceUrl.
    const sdkDefault = new ConfigurationBotFrameworkAuthentication(OPTIONS);
    await expect(
      sdkDefault.authenticateRequest(
        activity('https://attacker.example/'),
        `Bearer ${emulatorToken()}`,
      ),
    ).resolves.toBeDefined();

    const auth = createBotFrameworkAuth(OPTIONS);
    await expect(
      auth.authenticateRequest(activity('https://attacker.example/'), `Bearer ${emulatorToken()}`),
    ).rejects.toThrow('Only Bot Framework channel tokens are accepted.');
  });

  it('still refuses a channel token for another serviceUrl', async () => {
    const auth = createBotFrameworkAuth(OPTIONS);
    await expect(
      auth.authenticateRequest(activity('https://attacker.example/'), `Bearer ${channelToken()}`),
    ).rejects.toThrow('ServiceUrl claim do not match');
  });
});

describe('requireChannelIssuer', () => {
  it.each([
    ['an AAD v1 issuer', [{ type: 'iss', value: `https://sts.windows.net/${TENANT}/` }]],
    [
      'an AAD v2 issuer',
      [{ type: 'iss', value: `https://login.microsoftonline.com/${TENANT}/v2.0` }],
    ],
    ['no issuer', [{ type: 'aud', value: BOT }]],
    ['a look-alike', [{ type: 'iss', value: 'https://api.botframework.com.attacker.example' }]],
  ])('refuses %s', async (_name, claims) => {
    await expect(requireChannelIssuer(claims)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('passes the channel issuer', async () => {
    await expect(
      requireChannelIssuer([{ type: 'iss', value: 'https://api.botframework.com' }]),
    ).resolves.toBeUndefined();
  });
});
