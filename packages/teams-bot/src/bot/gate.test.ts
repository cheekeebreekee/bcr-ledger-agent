import { activityTenantId, evaluateGate, type GateActivity, type GateResult, isGuid } from './gate';

// Placeholder GUIDs — not real tenants or users.
const BCR_TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const USER_OID = '33333333-3333-4333-8333-333333333333';

type ConversationKind = 'personal' | 'groupChat' | 'channel';
type TenantKind = 'bcr' | 'foreign';
type OidKind = 'ok' | 'missing' | 'malformed';

function activity(conv: ConversationKind, tenant: TenantKind, oid: OidKind): GateActivity {
  return {
    conversation: { conversationType: conv },
    channelData: { tenant: { id: tenant === 'bcr' ? BCR_TENANT : FOREIGN_TENANT } },
    from: {
      ...(oid === 'ok' ? { aadObjectId: USER_OID } : {}),
      ...(oid === 'malformed' ? { aadObjectId: 'not-a-guid' } : {}),
    },
  };
}

function expected(conv: ConversationKind, tenant: TenantKind, oid: OidKind): GateResult {
  if (conv !== 'personal') return { ok: false, reason: 'conversation_type' };
  if (tenant !== 'bcr') return { ok: false, reason: 'tenant' };
  if (oid !== 'ok') return { ok: false, reason: 'aad_object_id' };
  return { ok: true };
}

const matrix: [ConversationKind, TenantKind, OidKind][] = [];
for (const conv of ['personal', 'groupChat', 'channel'] as const) {
  for (const tenant of ['bcr', 'foreign'] as const) {
    for (const oid of ['ok', 'missing', 'malformed'] as const) {
      matrix.push([conv, tenant, oid]);
    }
  }
}

describe('evaluateGate — conversation × tenant × aadObjectId matrix', () => {
  it.each(matrix)('%s / %s tenant / oid %s', (conv, tenant, oid) => {
    expect(evaluateGate(activity(conv, tenant, oid), BCR_TENANT)).toEqual(
      expected(conv, tenant, oid),
    );
  });

  it('passes exactly one combination of the 18', () => {
    const passing = matrix.filter(([c, t, o]) => evaluateGate(activity(c, t, o), BCR_TENANT).ok);
    expect(passing).toEqual([['personal', 'bcr', 'ok']]);
  });
});

describe('evaluateGate — edge cases', () => {
  const personal = (overrides: Partial<GateActivity>): GateActivity => ({
    conversation: { conversationType: 'personal' },
    channelData: { tenant: { id: BCR_TENANT } },
    from: { aadObjectId: USER_OID },
    ...overrides,
  });

  it('rejects an activity with no conversation at all', () => {
    expect(evaluateGate({}, BCR_TENANT)).toEqual({ ok: false, reason: 'conversation_type' });
  });

  it('rejects a missing conversationType (the emulator and unknown channels)', () => {
    expect(evaluateGate(personal({ conversation: {} }), BCR_TENANT)).toEqual({
      ok: false,
      reason: 'conversation_type',
    });
  });

  it('does not accept a conversationType differing only in case', () => {
    expect(
      evaluateGate(personal({ conversation: { conversationType: 'Personal' } }), BCR_TENANT).ok,
    ).toBe(false);
  });

  it('falls back to conversation.tenantId when channelData has no tenant', () => {
    const act = personal({
      channelData: undefined,
      conversation: { conversationType: 'personal', tenantId: BCR_TENANT },
    });
    expect(evaluateGate(act, BCR_TENANT)).toEqual({ ok: true });
  });

  it('prefers channelData.tenant.id over conversation.tenantId', () => {
    const act = personal({
      channelData: { tenant: { id: FOREIGN_TENANT } },
      conversation: { conversationType: 'personal', tenantId: BCR_TENANT },
    });
    expect(evaluateGate(act, BCR_TENANT)).toEqual({ ok: false, reason: 'tenant' });
  });

  it('rejects when no tenant is present anywhere', () => {
    expect(evaluateGate(personal({ channelData: {} }), BCR_TENANT)).toEqual({
      ok: false,
      reason: 'tenant',
    });
  });

  it('compares tenant GUIDs case-insensitively', () => {
    const act = personal({ channelData: { tenant: { id: BCR_TENANT.toUpperCase() } } });
    expect(evaluateGate(act, BCR_TENANT)).toEqual({ ok: true });
  });

  it('rejects an oid with extra characters around a GUID', () => {
    const act = personal({ from: { aadObjectId: ` ${USER_OID}` } });
    expect(evaluateGate(act, BCR_TENANT)).toEqual({ ok: false, reason: 'aad_object_id' });
  });
});

describe('activityTenantId', () => {
  it.each<[string, unknown]>([
    ['null channelData', null],
    ['string channelData', 'x'],
    ['null tenant', { tenant: null }],
    ['string tenant', { tenant: 'x' }],
    ['numeric tenant id', { tenant: { id: 42 } }],
  ])('ignores %s and falls back to conversation.tenantId', (_label, channelData) => {
    expect(activityTenantId({ channelData, conversation: { tenantId: BCR_TENANT } })).toBe(
      BCR_TENANT,
    );
  });

  it('is undefined when neither source has a tenant', () => {
    expect(activityTenantId({})).toBeUndefined();
  });
});

describe('isGuid', () => {
  it.each([
    [USER_OID, true],
    [USER_OID.toUpperCase(), true],
    ['', false],
    ['33333333333343338333333333333333', false],
    [`{${USER_OID}}`, false],
    [undefined, false],
    [42, false],
  ])('%p → %p', (value, result) => {
    expect(isGuid(value)).toBe(result);
  });
});
