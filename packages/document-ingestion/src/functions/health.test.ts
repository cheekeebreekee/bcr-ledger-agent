import type { HttpHandler } from '@azure/functions';

const mockHttp = jest.fn();
jest.mock('@azure/functions', () => ({ app: { http: mockHttp } }));

let mockMode: 'enforce' | 'off' = 'enforce';
let mockInbox: 'off' | 'shadow' | 'enforce' = 'off';
let mockRows: string[] = [];
let mockIndex: 'off' | 'write' = 'off';
let mockSearch: Record<string, unknown> = {};
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  loadIngestionConfig: () => ({
    membershipCheckMode: mockMode,
    inboxSweepMode: mockInbox,
    inboxSweepRows: mockRows,
    ledgerIndexMode: mockIndex,
    searchMode: 'off',
    searchRows: [],
    searchCallerAppIds: [],
    botCallerAppIds: ['00000000-0000-0000-0000-000000000001'],
    anthropicEnabled: true,
    anthropicApiKey: 'key',
    ...mockSearch,
  }),
}));

import { handleHealth, healthBody } from './health';

describe('health', () => {
  beforeEach(() => {
    mockMode = 'enforce';
    mockInbox = 'off';
    mockRows = [];
    mockIndex = 'off';
    mockSearch = {};
  });

  it('registers GET /api/health anonymously, with handleHealth as the handler', () => {
    expect(mockHttp).toHaveBeenCalledWith(
      'health',
      expect.objectContaining({ route: 'health', methods: ['GET'], authLevel: 'anonymous' }),
    );
    const registered = mockHttp.mock.calls[0]?.[1] as { handler: HttpHandler };
    expect(registered.handler).toBe(handleHealth);
  });

  // The operator tools gate on build.routing === 'identity-only'. Changing
  // phase or routing would stop every apply, or let one through on a build
  // that is not this one.
  it.each(['enforce', 'off'] as const)(
    'keeps phase and routing exactly, and reports membershipCheck=%s',
    async (m) => {
      mockMode = m;
      const res = await handleHealth();
      expect(res.status).toBe(200);
      const body = res.jsonBody as ReturnType<typeof healthBody>;
      expect(body.build).toEqual({
        phase: 'p0',
        routing: 'identity-only',
        clientIdentity: 'nip-member',
        membershipCheck: m,
        inboxSweep: 'off',
        inboxSweepRows: 'all',
        ledgerIndex: 'off',
        search: 'off',
      });
      expect(body.status).toBe('ok');
      expect(body.service).toBe('document-ingestion');
    },
  );

  it.each(['off', 'shadow', 'enforce'] as const)(
    'reports inboxSweep=%s without touching phase or routing',
    async (m) => {
      mockInbox = m;
      const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
      expect(body.build).toEqual({
        phase: 'p0',
        routing: 'identity-only',
        clientIdentity: 'nip-member',
        membershipCheck: 'enforce',
        inboxSweep: m,
        inboxSweepRows: 'all',
        ledgerIndex: 'off',
        search: 'off',
      });
    },
  );

  // The account rule (owner's decision, 28 Sep 2026) is in this build; an
  // operator checks it after the deploy.
  it('says the client identity rule is nip-member, whatever the modes', async () => {
    mockMode = 'off';
    mockInbox = 'enforce';
    const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
    expect(body.build).toMatchObject({
      phase: 'p0',
      routing: 'identity-only',
      clientIdentity: 'nip-member',
    });
  });

  it('reports ledgerIndex=write without touching phase or routing', async () => {
    mockIndex = 'write';
    const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
    expect(body.build).toMatchObject({
      phase: 'p0',
      routing: 'identity-only',
      ledgerIndex: 'write',
    });
  });

  it('says the sweep is limited to listed rows, without naming them', async () => {
    mockInbox = 'shadow';
    mockRows = ['7', '12'];
    const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
    expect(body.build.inboxSweepRows).toBe('listed');
    expect(JSON.stringify(body)).not.toMatch(/"7"|"12"/);
  });

  const searchOn = {
    searchMode: 'on',
    searchCallerAppIds: ['7d0c3f6a-5b1e-4c2d-9e8f-0a1b2c3d4e5f'],
  };

  it.each([
    ['off while SEARCH_MODE is off', {}, 'write', 'off'],
    ['off while the index does not write', searchOn, 'off', 'off'],
    ['all when on for every row', searchOn, 'write', 'all'],
    ['listed when SEARCH_ROWS names rows', { ...searchOn, searchRows: ['10'] }, 'write', 'listed'],
  ] as const)(
    'reports search %s, without touching phase or routing',
    async (_l, over, index, want) => {
      mockSearch = { ...over };
      mockIndex = index;
      const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
      expect(body.build).toMatchObject({ phase: 'p0', routing: 'identity-only', search: want });
      expect(JSON.stringify(body)).not.toMatch(/"10"|7d0c3f6a/);
    },
  );

  it('reports search off when the membership check is off (search has no bypass)', async () => {
    mockSearch = searchOn;
    mockIndex = 'write';
    mockMode = 'off';
    const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
    expect(body.build.search).toBe('off');
  });

  it('stamps the time it was asked', () => {
    const now = new Date('2026-09-26T10:00:00.000Z');
    const build = {
      membershipCheck: 'enforce',
      inboxSweep: 'off',
      inboxSweepRows: 'all',
      ledgerIndex: 'off',
      search: 'off',
    } as const;
    expect(healthBody(build, now).timestamp).toBe('2026-09-26T10:00:00.000Z');
  });
});
