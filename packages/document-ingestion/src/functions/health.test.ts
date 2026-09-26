import type { HttpHandler } from '@azure/functions';

const mockHttp = jest.fn();
jest.mock('@azure/functions', () => ({ app: { http: mockHttp } }));

let mockMode: 'enforce' | 'off' = 'enforce';
let mockInbox: 'off' | 'shadow' | 'enforce' = 'off';
jest.mock('../config', () => ({
  loadIngestionConfig: () => ({ membershipCheckMode: mockMode, inboxSweepMode: mockInbox }),
}));

import { handleHealth, healthBody } from './health';

describe('health', () => {
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
      mockInbox = 'off';
      const res = await handleHealth();
      expect(res.status).toBe(200);
      const body = res.jsonBody as ReturnType<typeof healthBody>;
      expect(body.build).toEqual({
        phase: 'p0',
        routing: 'identity-only',
        membershipCheck: m,
        inboxSweep: 'off',
      });
      expect(body.status).toBe('ok');
      expect(body.service).toBe('document-ingestion');
    },
  );

  it.each(['off', 'shadow', 'enforce'] as const)(
    'reports inboxSweep=%s without touching phase or routing',
    async (m) => {
      mockMode = 'enforce';
      mockInbox = m;
      const body = (await handleHealth()).jsonBody as ReturnType<typeof healthBody>;
      expect(body.build).toEqual({
        phase: 'p0',
        routing: 'identity-only',
        membershipCheck: 'enforce',
        inboxSweep: m,
      });
    },
  );

  it('stamps the time it was asked', () => {
    const now = new Date('2026-09-26T10:00:00.000Z');
    expect(healthBody('enforce', 'off', now).timestamp).toBe('2026-09-26T10:00:00.000Z');
  });
});
