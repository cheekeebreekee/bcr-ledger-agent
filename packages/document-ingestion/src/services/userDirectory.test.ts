import { RetryHandlerOptions, type Client } from '@microsoft/microsoft-graph-client';
import {
  USER_ACCOUNT_CACHE_TTL_MS,
  UserAccountReadError,
  UserAccountReader,
} from './userDirectory';

const OID = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';
const OID_2 = '0b8c7a2e-51f4-4a7e-9d3e-2f1c6a9b8d70';
/** Synthetic: a client account's UPN is `{NIP}@bcr-group.pl`. */
const UPN = '1111111111@bcr-group.pl';
const MEMBER = { userType: 'Member', userPrincipalName: UPN };

/** A Graph client double: records every GET path and answers it with `handler`. */
function fakeGraph(handler: (path: string) => unknown): { client: Client; paths: string[] } {
  const paths: string[] = [];
  const api = (path: string) => ({
    get: async () => {
      paths.push(path);
      return handler(path);
    },
  });
  return { client: { api } as unknown as Client, paths };
}

const graphError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

const noRetry = { retry: { retries: 0, minTimeoutMs: 0 } };

describe('UserAccountReader.accountOf', () => {
  it('selects userType and userPrincipalName for the lower-cased user id, and returns both', async () => {
    const { client, paths } = fakeGraph(() => ({ ...MEMBER, displayName: 'not read' }));
    await expect(
      new UserAccountReader(client, noRetry).accountOf(` ${OID.toUpperCase()} `),
    ).resolves.toEqual(MEMBER);
    expect(paths).toEqual([`/users/${OID}?$select=userType,userPrincipalName`]);
  });

  it('never asks whether the account may sign in', async () => {
    const { client, paths } = fakeGraph(() => MEMBER);
    await new UserAccountReader(client, noRetry).accountOf(OID);
    expect(paths.join()).not.toMatch(/accountEnabled|assignedLicenses/);
  });

  it('reads a user that does not exist as null, and caches that', async () => {
    const { client, paths } = fakeGraph(() => {
      throw graphError(404);
    });
    const reader = new UserAccountReader(client, noRetry);
    await expect(reader.accountOf(OID)).resolves.toBeNull();
    await expect(reader.accountOf(OID)).resolves.toBeNull();
    expect(paths).toHaveLength(1);
  });

  it('refuses a user id that is not a GUID, without calling Graph', async () => {
    const { client, paths } = fakeGraph(() => MEMBER);
    await expect(new UserAccountReader(client, noRetry).accountOf('../me')).rejects.toBeInstanceOf(
      UserAccountReadError,
    );
    expect(paths).toEqual([]);
  });

  it('reports a failed read with its status, and never caches it', async () => {
    let fail = true;
    const { client, paths } = fakeGraph(() => {
      if (fail) throw graphError(403);
      return MEMBER;
    });
    const reader = new UserAccountReader(client, noRetry);
    await expect(reader.accountOf(OID)).rejects.toMatchObject({
      code: 'UserAccountReadError',
      status: 403,
    });
    fail = false;
    await expect(reader.accountOf(OID)).resolves.toEqual(MEMBER);
    expect(paths).toHaveLength(2);
  });

  it.each([
    ['no userPrincipalName', { userType: 'Member' }],
    ['a userPrincipalName that is not a string', { userType: 'Member', userPrincipalName: 7 }],
    ['a userType that is not a string', { userType: 7, userPrincipalName: UPN }],
    ['no body', undefined],
  ])('refuses a response with %s', async (_label, body) => {
    const { client } = fakeGraph(() => body);
    await expect(new UserAccountReader(client, noRetry).accountOf(OID)).rejects.toBeInstanceOf(
      UserAccountReadError,
    );
  });

  // A legacy account with no type must not wait forever as unverified: the
  // rule reads '' as `not_member`.
  it.each([
    ['null', { userType: null, userPrincipalName: UPN }],
    ['absent', { userPrincipalName: UPN }],
  ])('reads a %s userType as the empty string', async (_label, body) => {
    const { client } = fakeGraph(() => body);
    await expect(new UserAccountReader(client, noRetry).accountOf(OID)).resolves.toEqual({
      userType: '',
      userPrincipalName: UPN,
    });
  });

  it('retries a network failure', async () => {
    let calls = 0;
    const { client } = fakeGraph(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('reset'), { statusCode: -1 });
      return MEMBER;
    });
    const reader = new UserAccountReader(client, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(reader.accountOf(OID)).resolves.toEqual(MEMBER);
  });

  it('caches a success for the TTL, then reads again', async () => {
    let now = 0;
    const { client, paths } = fakeGraph(() => MEMBER);
    const reader = new UserAccountReader(client, { ...noRetry, now: () => now });
    await reader.accountOf(OID);
    now = USER_ACCOUNT_CACHE_TTL_MS - 1;
    await reader.accountOf(OID);
    expect(paths).toHaveLength(1);
    now = USER_ACCOUNT_CACHE_TTL_MS;
    await reader.accountOf(OID);
    expect(paths).toHaveLength(2);
  });

  it('shares one request between concurrent reads of one user', async () => {
    const { client, paths } = fakeGraph(() => MEMBER);
    const reader = new UserAccountReader(client, noRetry);
    await Promise.all([reader.accountOf(OID), reader.accountOf(OID)]);
    expect(paths).toHaveLength(1);
  });

  it('keeps the cache bounded', async () => {
    const { client, paths } = fakeGraph(() => MEMBER);
    const reader = new UserAccountReader(client, { ...noRetry, maxCachedUsers: 1 });
    await reader.accountOf(OID);
    await reader.accountOf(OID_2);
    await reader.accountOf(OID);
    expect(paths).toHaveLength(3);
  });
});

// The channel-inbox sweep's reader: a tick must end inside the timer's
// limit, so the SDK may not sleep through Retry-After; throttling is retried
// here instead, a bounded number of times.
describe('UserAccountReader with sdkRetries: false', () => {
  function recordingGraph(answers: (() => unknown)[]) {
    const middleware: unknown[][] = [];
    const api = () => {
      const seen: unknown[] = [];
      const request = {
        middlewareOptions(options: unknown[]) {
          seen.push(...options);
          return request;
        },
        get: async () => {
          middleware.push(seen);
          const next = answers.shift();
          return next ? next() : MEMBER;
        },
      };
      return request;
    };
    return { client: { api } as unknown as Client, middleware };
  }

  it.each([429, 503, 504])(
    'switches the SDK retries off and retries a %i itself',
    async (status) => {
      const { client, middleware } = recordingGraph([
        () => {
          throw graphError(status);
        },
        () => MEMBER,
      ]);
      const reader = new UserAccountReader(client, {
        sdkRetries: false,
        retry: { retries: 1, minTimeoutMs: 0 },
      });
      await expect(reader.accountOf(OID)).resolves.toEqual(MEMBER);
      expect(middleware).toHaveLength(2);
      for (const options of middleware) {
        expect(options).toEqual([expect.any(RetryHandlerOptions)]);
        expect((options[0] as RetryHandlerOptions).maxRetries).toBe(0);
      }
    },
  );

  it('by default leaves a 429 to the SDK, as the upload path always has', async () => {
    const { client, middleware } = recordingGraph([
      () => {
        throw graphError(429);
      },
    ]);
    const reader = new UserAccountReader(client, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(reader.accountOf(OID)).rejects.toMatchObject({ status: 429 });
    expect(middleware).toEqual([[]]);
  });
});
