import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, RetryHandlerOptions } from '@microsoft/microsoft-graph-client';
import type { Logger } from '@bcr/shared';
import {
  CLIENT_TEAM_MARKER,
  MEMBERSHIP_CACHE_TTL_MS,
  membershipCheckFor,
  TeamMembershipReadError,
  TeamMembershipReader,
  teamIdsIn,
  type TeamMembershipSource,
} from './teamMembership';

const OID = 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48';
const OID_2 = '0b8c7a2e-51f4-4a7e-9d3e-2f1c6a9b8d70';
const TEAM_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const TEAM_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const GROUP = '33333333-cccc-4ccc-8ccc-333333333333';

type Handler = (path: string) => unknown;

/** A Graph client double: records every GET path and answers it with `handler`. */
function fakeGraph(handler: Handler): { client: Client; paths: string[] } {
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
const network = () => Object.assign(new Error('fetch failed'), { statusCode: -1 });

const team = (id: string) => ({
  '@odata.type': '#microsoft.graph.group',
  id,
  resourceProvisioningOptions: ['Team'],
});
const plainGroup = (id: string) => ({
  '@odata.type': '#microsoft.graph.group',
  id,
  resourceProvisioningOptions: [],
});

const noRetry = { retry: { retries: 0, minTimeoutMs: 0 } };
const fastRetry = { retry: { retries: 2, minTimeoutMs: 0, jitter: 0 } };

function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const write = (obj: unknown, msg?: string) =>
    lines.push({ ...(typeof obj === 'object' && obj ? obj : { msg: obj }), msg });
  const log = { info: write, warn: write, error: write, debug: write } as unknown as Logger;
  return { log, lines };
}

describe('TeamMembershipReader.teamsOf', () => {
  it("reads the user's direct memberships from Entra, with the options that mark a Team", async () => {
    const { client, paths } = fakeGraph(() => ({ value: [team(TEAM_A)] }));
    const teams = await new TeamMembershipReader(client, noRetry).teamsOf(OID);
    expect([...teams]).toEqual([TEAM_A]);
    expect(paths).toEqual([
      `/users/${OID}/memberOf?$select=id,description,resourceProvisioningOptions&$top=999`,
    ]);
  });

  it('lower-cases the user id in the path and the Team ids in the result', async () => {
    const { client, paths } = fakeGraph(() => ({ value: [team(TEAM_A.toUpperCase())] }));
    const teams = await new TeamMembershipReader(client, noRetry).teamsOf(` ${OID.toUpperCase()} `);
    expect([...teams]).toEqual([TEAM_A]);
    expect(paths[0]).toContain(`/users/${OID}/`);
  });

  it('follows @odata.nextLink to the last page', async () => {
    const next = `https://graph.microsoft.com/v1.0/users/${OID}/memberOf?$skiptoken=abc`;
    const { client, paths } = fakeGraph((path) =>
      path === next
        ? { value: [team(TEAM_B)] }
        : { value: [team(TEAM_A), plainGroup(GROUP)], '@odata.nextLink': next },
    );
    const teams = await new TeamMembershipReader(client, noRetry).teamsOf(OID);
    expect([...teams].sort()).toEqual([TEAM_A, TEAM_B]);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toBe(next);
  });

  it('returns an empty set for a user in no Team', async () => {
    const { client } = fakeGraph(() => ({ value: [plainGroup(GROUP)] }));
    const teams = await new TeamMembershipReader(client, noRetry).teamsOf(OID);
    expect(teams.size).toBe(0);
  });

  it('refuses a nextLink that leaves Graph, rather than sending the token there', async () => {
    const { client, paths } = fakeGraph(() => ({
      value: [team(TEAM_A)],
      '@odata.nextLink': 'https://example.com/steal',
    }));
    await expect(new TeamMembershipReader(client, noRetry).teamsOf(OID)).rejects.toBeInstanceOf(
      TeamMembershipReadError,
    );
    expect(paths).toHaveLength(1);
  });

  it('stops after maxPages, as a failure', async () => {
    const next = `https://graph.microsoft.com/v1.0/users/${OID}/memberOf?$skiptoken=loop`;
    const { client, paths } = fakeGraph(() => ({ value: [], '@odata.nextLink': next }));
    await expect(
      new TeamMembershipReader(client, { ...noRetry, maxPages: 3 }).teamsOf(OID),
    ).rejects.toBeInstanceOf(TeamMembershipReadError);
    expect(paths).toHaveLength(3);
  });

  it('fails on a page without a value array', async () => {
    const { client } = fakeGraph(() => ({}));
    await expect(new TeamMembershipReader(client, noRetry).teamsOf(OID)).rejects.toBeInstanceOf(
      TeamMembershipReadError,
    );
  });

  it('fails on an empty response body', async () => {
    const { client } = fakeGraph(() => undefined);
    await expect(new TeamMembershipReader(client, noRetry).teamsOf(OID)).rejects.toBeInstanceOf(
      TeamMembershipReadError,
    );
  });

  it('refuses a user id that is not a GUID, without calling Graph', async () => {
    const { client, paths } = fakeGraph(() => ({ value: [] }));
    await expect(
      new TeamMembershipReader(client, noRetry).teamsOf('../groups/x'),
    ).rejects.toBeInstanceOf(TeamMembershipReadError);
    expect(paths).toEqual([]);
  });

  describe('retry', () => {
    it.each([
      ['a network failure', network],
      ['500', () => graphError(500)],
      ['502', () => graphError(502)],
    ])('retries %s, then succeeds', async (_label, failure) => {
      let calls = 0;
      const { client } = fakeGraph(() => {
        calls += 1;
        if (calls === 1) throw failure();
        return { value: [team(TEAM_A)] };
      });
      const teams = await new TeamMembershipReader(client, fastRetry).teamsOf(OID);
      expect([...teams]).toEqual([TEAM_A]);
      expect(calls).toBe(2);
    });

    // The SDK's RetryHandler has already retried 429/503/504; 403 and 404
    // will not change on a second try within the request.
    it.each([403, 404, 429, 503])('does not retry %i, and reports the status', async (status) => {
      const { client, paths } = fakeGraph(() => {
        throw graphError(status);
      });
      const err = await new TeamMembershipReader(client, fastRetry).teamsOf(OID).catch((e) => e);
      expect(err).toBeInstanceOf(TeamMembershipReadError);
      expect((err as TeamMembershipReadError).status).toBe(status);
      expect(paths).toHaveLength(1);
    });

    it('gives up after its retries, as a failure with the last status', async () => {
      const { client, paths } = fakeGraph(() => {
        throw graphError(502);
      });
      const err = await new TeamMembershipReader(client, fastRetry).teamsOf(OID).catch((e) => e);
      expect(err).toMatchObject({ status: 502 });
      expect(paths).toHaveLength(3);
    });

    it('carries no URL or path in its message', async () => {
      const { client } = fakeGraph(() => {
        throw Object.assign(new Error(`GET /users/${OID}/memberOf failed`), { statusCode: 403 });
      });
      const err = (await new TeamMembershipReader(client, noRetry)
        .teamsOf(OID)
        .catch((e) => e)) as TeamMembershipReadError;
      expect(err.message).not.toContain(OID);
      expect(err.code).toBe('TeamMembershipReadError');
    });
  });

  describe('cache', () => {
    function counting(value: () => unknown) {
      let calls = 0;
      const { client } = fakeGraph(() => {
        calls += 1;
        return value();
      });
      return { client, calls: () => calls };
    }

    it('reuses a successful read for the same user within the TTL (hit)', async () => {
      let now = 1_000;
      const g = counting(() => ({ value: [team(TEAM_A)] }));
      const reader = new TeamMembershipReader(g.client, { ...noRetry, now: () => now });
      await reader.teamsOf(OID);
      now += MEMBERSHIP_CACHE_TTL_MS - 1;
      await reader.teamsOf(OID.toUpperCase());
      expect(g.calls()).toBe(1);
    });

    it('reads again for another user (miss)', async () => {
      const g = counting(() => ({ value: [team(TEAM_A)] }));
      const reader = new TeamMembershipReader(g.client, noRetry);
      await reader.teamsOf(OID);
      await reader.teamsOf(OID_2);
      expect(g.calls()).toBe(2);
    });

    it('reads again once the TTL has passed (expiry), and sees the new Team', async () => {
      let now = 1_000;
      let teams = [team(TEAM_A)];
      const g = counting(() => ({ value: teams }));
      const reader = new TeamMembershipReader(g.client, {
        ...noRetry,
        now: () => now,
        cacheTtlMs: 60_000,
      });
      expect([...(await reader.teamsOf(OID))]).toEqual([TEAM_A]);
      teams = [team(TEAM_A), team(TEAM_B)];
      now += 60_000;
      expect([...(await reader.teamsOf(OID))].sort()).toEqual([TEAM_A, TEAM_B]);
      expect(g.calls()).toBe(2);
    });

    it('never caches a failure: the next upload asks again', async () => {
      let fail = true;
      const g = counting(() => {
        if (fail) throw graphError(403);
        return { value: [team(TEAM_A)] };
      });
      const reader = new TeamMembershipReader(g.client, noRetry);
      await expect(reader.teamsOf(OID)).rejects.toMatchObject({ status: 403 });
      fail = false;
      expect([...(await reader.teamsOf(OID))]).toEqual([TEAM_A]);
      expect(g.calls()).toBe(2);
    });

    it('shares one request between concurrent reads for the same user', async () => {
      const g = counting(() => ({ value: [team(TEAM_A)] }));
      const reader = new TeamMembershipReader(g.client, noRetry);
      const [a, b] = await Promise.all([reader.teamsOf(OID), reader.teamsOf(OID)]);
      expect(a).toBe(b);
      expect(g.calls()).toBe(1);
    });

    it('stays bounded: expired users go first, then the oldest', async () => {
      let now = 0;
      const g = counting(() => ({ value: [] }));
      const reader = new TeamMembershipReader(g.client, {
        ...noRetry,
        now: () => now,
        cacheTtlMs: 100,
        maxCachedUsers: 3,
      });
      const oid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
      await reader.teamsOf(oid(1));
      now = 10;
      await reader.teamsOf(oid(2));
      now = 90;
      await reader.teamsOf(oid(3));
      // Full. By 115, 1 and 2 have expired: both go to make room for 4, and 3 stays.
      now = 115;
      await reader.teamsOf(oid(4));
      await reader.teamsOf(oid(3));
      expect(g.calls()).toBe(4);
      // There is room again, for 1.
      await reader.teamsOf(oid(1));
      expect(g.calls()).toBe(5);
      // Full, none expired: the oldest (3) makes room for 5.
      await reader.teamsOf(oid(5));
      await reader.teamsOf(oid(4));
      expect(g.calls()).toBe(6);
      await reader.teamsOf(oid(3));
      expect(g.calls()).toBe(7);
    });
  });
});

// The channel-inbox sweep has its own reader: a tick must end inside the
// timer's limit, so the SDK may not sleep through Retry-After. The upload
// path's reader keeps the SDK's retries.
describe('TeamMembershipReader with sdkRetries: false', () => {
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
          return next ? next() : { value: [team(TEAM_A)] };
        },
      };
      return request;
    };
    return { client: { api } as unknown as Client, middleware };
  }

  it.each([429, 503, 504])('switches the SDK retries off and retries a %i itself', async (status) => {
    const { client, middleware } = recordingGraph([
      () => {
        throw graphError(status);
      },
    ]);
    const reader = new TeamMembershipReader(client, {
      sdkRetries: false,
      retry: { retries: 1, minTimeoutMs: 0 },
    });
    await expect(reader.teamsOf(OID)).resolves.toEqual(new Set([TEAM_A]));
    expect(middleware).toHaveLength(2);
    for (const options of middleware) {
      expect((options[0] as RetryHandlerOptions).maxRetries).toBe(0);
    }
  });

  it('by default leaves a 503 to the SDK, as the upload path always has', async () => {
    const { client, middleware } = recordingGraph([
      () => {
        throw graphError(503);
      },
    ]);
    const reader = new TeamMembershipReader(client, { retry: { retries: 1, minTimeoutMs: 0 } });
    await expect(reader.teamsOf(OID)).rejects.toMatchObject({ status: 503 });
    expect(middleware).toEqual([[]]);
  });
});

describe('teamIdsIn', () => {
  it('keeps groups whose options contain Team, in any case', () => {
    expect(
      teamIdsIn([
        team(TEAM_A),
        { ...plainGroup(TEAM_B), resourceProvisioningOptions: ['team'] },
        plainGroup(GROUP),
      ]),
    ).toEqual([TEAM_A, TEAM_B]);
  });

  // The runtime and the binding tool must count the same groups as Teams, or
  // a client account the tool binds could be held at upload, or the other way round.
  it("uses the binding tool's client-Team marker, character for character", () => {
    const tool = readFileSync(join(__dirname, '../../../../tools/lib/bindings.mjs'), 'utf8');
    const match = /export const BCR_TEAM_DESCRIPTION = \/(.+)\/([a-z]*);/.exec(tool);
    expect(match?.slice(1)).toEqual([CLIENT_TEAM_MARKER.source, CLIENT_TEAM_MARKER.flags]);
  });

  // The binding tool counts these too (BCR_TEAM_DESCRIPTION in tools/lib/bindings.mjs).
  it.each(['BCR Group — 0002 Client', '  bcr group - 0002', 'BCR Group – 0002'])(
    'counts a group carrying the client-Team marker %j as a Team, whatever its options',
    (description) => {
      expect(teamIdsIn([{ ...plainGroup(GROUP), description }])).toEqual([GROUP]);
    },
  );

  it('does not count a group that only mentions BCR Group later in its description', () => {
    expect(
      teamIdsIn([{ ...plainGroup(GROUP), description: 'Mailing list for BCR Group — all' }]),
    ).toEqual([]);
  });

  it('skips directory roles and administrative units', () => {
    expect(
      teamIdsIn([
        { '@odata.type': '#microsoft.graph.directoryRole', id: TEAM_B },
        { '@odata.type': '#microsoft.graph.administrativeUnit', id: GROUP },
        team(TEAM_A),
      ]),
    ).toEqual([TEAM_A]);
  });

  // Fail closed: an unknown may quarantine an upload, never route one.
  it('counts a group whose options were not returned as a Team', () => {
    expect(teamIdsIn([{ '@odata.type': '#microsoft.graph.group', id: GROUP }])).toEqual([GROUP]);
    expect(teamIdsIn([{ id: GROUP, resourceProvisioningOptions: null }])).toEqual([GROUP]);
  });

  it('fails the read on a Team without a readable id', () => {
    expect(() => teamIdsIn([{ '@odata.type': '#microsoft.graph.group' }])).toThrow(
      TeamMembershipReadError,
    );
    expect(() => teamIdsIn([{ ...team(TEAM_A), id: 'not-a-guid' }])).toThrow(
      TeamMembershipReadError,
    );
  });

  it('does not need an id on a group that is not a Team', () => {
    expect(
      teamIdsIn([{ '@odata.type': '#microsoft.graph.group', resourceProvisioningOptions: [] }]),
    ).toEqual([]);
  });
});

describe('membershipCheckFor', () => {
  const source: TeamMembershipSource = { teamsOf: async () => new Set<string>() };

  it('enforces by default, silently', () => {
    const { log, lines } = recordingLogger();
    expect(membershipCheckFor('enforce', source, log)).toEqual({ mode: 'enforce', source });
    expect(lines).toEqual([]);
  });

  it('says out loud, at cold start, that off reopens R46', () => {
    const { log, lines } = recordingLogger();
    expect(membershipCheckFor('off', source, log)).toEqual({ mode: 'off' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'membership.check_off' });
    expect(String(lines[0]?.['msg'])).toContain('R46');
  });

  it('logs through its own area when no logger is given', () => {
    expect(membershipCheckFor('off', source)).toEqual({ mode: 'off' });
  });
});
