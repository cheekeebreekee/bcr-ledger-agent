import type { HttpHandler } from '@azure/functions';

const mockHttp = jest.fn();
jest.mock('@azure/functions', () => ({ app: { http: mockHttp } }));

let mockMode: 'enforce' | 'off' = 'enforce';
let mockInbox: 'off' | 'shadow' | 'enforce' = 'off';
let mockRows: string[] = [];
jest.mock('../config', () => ({
  loadIngestionConfig: () => ({
    membershipCheckMode: mockMode,
    inboxSweepMode: mockInbox,
    inboxSweepRows: mockRows,
  }),
}));

import { handleHealth, healthBody } from './health';

describe('health', () => {
  beforeEach(() => {
    mockMode = 'enforce';
    mockInbox = 'off';
    mockRows = [];
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
        membershipCheck: m,
        inboxSweep: 'off',
        inboxSweepRows: 'all',
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
        membershipCheck: 'enforce',
        inboxSweep: m,
        inboxSweepRows: 'all',
      });
    },
  );

  it('says the sweep is limited to listed rows, without naming them', async () => {
    mockInbox = 'shadow';
    mockRows = ['7', '12'];
    const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
    expect(body.build.inboxSweepRows).toBe('listed');
    expect(JSON.stringify(body)).not.toMatch(/"7"|"12"/);
  });

  it('stamps the time it was asked', () => {
    const now = new Date('2026-09-26T10:00:00.000Z');
    const build = { membershipCheck: 'enforce', inboxSweep: 'off', inboxSweepRows: 'all' } as const;
    expect(healthBody(build, now).timestamp).toBe('2026-09-26T10:00:00.000Z');
  });
});
