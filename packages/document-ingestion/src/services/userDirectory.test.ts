import { RetryHandlerOptions, type Client } from '@microsoft/microsoft-graph-client';
import { USER_TYPE_CACHE_TTL_MS, UserTypeReadError, UserTypeReader } from './userDirectory';

const OID = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';
const OID_2 = '0b8c7a2e-51f4-4a7e-9d3e-2f1c6a9b8d70';

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

describe('UserTypeReader.userTypeOf', () => {
  it('selects userType for the lower-cased user id', async () => {
    const { client, paths } = fakeGraph(() => ({ userType: 'Guest' }));
    await expect(
      new UserTypeReader(client, noRetry).userTypeOf(` ${OID.toUpperCase()} `),
    ).resolves.toBe('Guest');
    expect(paths).toEqual([`/users/${OID}?$select=userType`]);
  });

  it('reads a user that does not exist as null, and caches that', async () => {
    const { client, paths } = fakeGraph(() => {
      throw graphError(404);
    });
    const reader = new UserTypeReader(client, noRetry);
    await expect(reader.userTypeOf(OID)).resolves.toBeNull();
    await expect(reader.userTypeOf(OID)).resolves.toBeNull();
    expect(paths).toHaveLength(1);
  });

  it('refuses a user id that is not a GUID, without calling Graph', async () => {
    const { client, paths } = fakeGraph(() => ({ userType: 'Guest' }));
    await expect(new UserTypeReader(client, noRetry).userTypeOf('../me')).rejects.toBeInstanceOf(
      UserTypeReadError,
    );
    expect(paths).toEqual([]);
  });

  it('reports a failed read with its status, and never caches it', async () => {
    let fail = true;
    const { client, paths } = fakeGraph(() => {
      if (fail) throw graphError(403);
      return { userType: 'Member' };
    });
    const reader = new UserTypeReader(client, noRetry);
    await expect(reader.userTypeOf(OID)).rejects.toMatchObject({ status: 403 });
    fail = false;
    await expect(reader.userTypeOf(OID)).resolves.toBe('Member');
    expect(paths).toHaveLength(2);
  });

  it('refuses a response without a userType', async () => {
    const { client } = fakeGraph(() => ({}));
    await expect(new UserTypeReader(client, noRetry).userTypeOf(OID)).rejects.toBeInstanceOf(
      UserTypeReadError,
    );
  });

  it('retries a network failure', async () => {
    let calls = 0;
    const { client } = fakeGraph(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('reset'), { statusCode: -1 });
      return { userType: 'Guest' };
    });
    const reader = new UserTypeReader(client, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(reader.userTypeOf(OID)).resolves.toBe('Guest');
  });

  it('caches a success for the TTL, then reads again', async () => {
    let now = 0;
    const { client, paths } = fakeGraph(() => ({ userType: 'Guest' }));
    const reader = new UserTypeReader(client, { ...noRetry, now: () => now });
    await reader.userTypeOf(OID);
    now = USER_TYPE_CACHE_TTL_MS - 1;
    await reader.userTypeOf(OID);
    expect(paths).toHaveLength(1);
    now = USER_TYPE_CACHE_TTL_MS;
    await reader.userTypeOf(OID);
    expect(paths).toHaveLength(2);
  });

  it('shares one request between concurrent reads of one user', async () => {
    const { client, paths } = fakeGraph(() => ({ userType: 'Guest' }));
    const reader = new UserTypeReader(client, noRetry);
    await Promise.all([reader.userTypeOf(OID), reader.userTypeOf(OID)]);
    expect(paths).toHaveLength(1);
  });

  it('keeps the cache bounded', async () => {
    const { client, paths } = fakeGraph(() => ({ userType: 'Guest' }));
    const reader = new UserTypeReader(client, { ...noRetry, maxCachedUsers: 1 });
    await reader.userTypeOf(OID);
    await reader.userTypeOf(OID_2);
    await reader.userTypeOf(OID);
    expect(paths).toHaveLength(3);
  });
});

// The channel-inbox sweep's reader: a tick must end inside the timer's
// limit, so the SDK may not sleep through Retry-After; throttling is retried
// here instead, a bounded number of times.
describe('UserTypeReader with sdkRetries: false', () => {
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
          return next ? next() : { userType: 'Guest' };
        },
      };
      return request;
    };
    return { client: { api } as unknown as Client, middleware };
  }

  it('switches the SDK retries off and retries a 429 itself', async () => {
    const { client, middleware } = recordingGraph([
      () => {
        throw graphError(429);
      },
      () => ({ userType: 'Guest' }),
    ]);
    const reader = new UserTypeReader(client, {
      sdkRetries: false,
      retry: { retries: 1, minTimeoutMs: 0 },
    });
    await expect(reader.userTypeOf(OID)).resolves.toBe('Guest');
    expect(middleware).toHaveLength(2);
    for (const options of middleware) {
      expect(options).toEqual([expect.any(RetryHandlerOptions)]);
      expect((options[0] as RetryHandlerOptions).maxRetries).toBe(0);
    }
  });

  it('by default leaves a 429 to the SDK, as the upload path always has', async () => {
    const { client, middleware } = recordingGraph([
      () => {
        throw graphError(429);
      },
    ]);
    const reader = new UserTypeReader(client, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(reader.userTypeOf(OID)).rejects.toMatchObject({ status: 429 });
    expect(middleware).toEqual([[]]);
  });
});
