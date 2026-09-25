import { type Activity, type ConversationAccount, TestAdapter } from 'botbuilder';
import { GATE_REFUSAL_TEXT } from './cardText';
import { type GateMode, GateMiddleware } from './gateMiddleware';

// Placeholder GUIDs — not real tenants or users.
const BCR_TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const USER_OID = '33333333-3333-4333-8333-333333333333';

type ConversationKind = 'personal' | 'groupChat' | 'channel';
type TenantKind = 'bcr' | 'foreign';
type OidKind = 'ok' | 'missing' | 'malformed';

interface Scenario {
  readonly conv: ConversationKind;
  readonly tenant: TenantKind;
  readonly oid: OidKind;
}

function buildActivity(s: Scenario, overrides: Partial<Activity> = {}): Partial<Activity> {
  const conversation: ConversationAccount = {
    id: `conv-${s.conv}`,
    name: '',
    isGroup: s.conv !== 'personal',
    conversationType: s.conv,
  };
  return {
    type: 'message',
    text: 'hej',
    channelId: 'msteams',
    conversation,
    channelData: { tenant: { id: s.tenant === 'bcr' ? BCR_TENANT : FOREIGN_TENANT } },
    from: {
      id: 'user-1',
      name: 'Użytkownik',
      ...(s.oid === 'ok' ? { aadObjectId: USER_OID } : {}),
      ...(s.oid === 'malformed' ? { aadObjectId: 'user@example.com' } : {}),
    },
    ...overrides,
  };
}

async function runTurn(mode: GateMode, activity: Partial<Activity>) {
  const warn = jest.fn();
  const logic = jest.fn(async () => undefined);
  const adapter = new TestAdapter(logic);
  adapter.use(new GateMiddleware({ tenantId: BCR_TENANT, mode, logger: { warn } }));
  await adapter.processActivity(activity);
  return { warn, reachedBot: logic.mock.calls.length > 0, sent: adapter.activeQueue };
}

function expectedReason(s: Scenario): string | undefined {
  if (s.conv !== 'personal') return 'conversation_type';
  if (s.tenant !== 'bcr') return 'tenant';
  if (s.oid !== 'ok') return 'aad_object_id';
  return undefined;
}

const matrix: [string, Scenario, GateMode][] = [];
for (const conv of ['personal', 'groupChat', 'channel'] as const) {
  for (const tenant of ['bcr', 'foreign'] as const) {
    for (const oid of ['ok', 'missing', 'malformed'] as const) {
      for (const mode of ['log', 'enforce'] as const) {
        matrix.push([
          `${conv} / ${tenant} tenant / oid ${oid} / ${mode}`,
          { conv, tenant, oid },
          mode,
        ]);
      }
    }
  }
}

describe('GateMiddleware — message matrix (conversation × tenant × oid × mode)', () => {
  it.each(matrix)('%s', async (_label, scenario, mode) => {
    const { warn, reachedBot, sent } = await runTurn(mode, buildActivity(scenario));
    const reason = expectedReason(scenario);

    if (reason === undefined) {
      expect(reachedBot).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      return;
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason, mode, activityType: 'message' }),
      'bot.gate.rejected',
    );

    if (mode === 'log') {
      // Log mode records the rejection and lets the turn through untouched.
      expect(reachedBot).toBe(true);
      expect(sent).toHaveLength(0);
      return;
    }

    expect(reachedBot).toBe(false);
    if (scenario.conv === 'personal') {
      // A refused 1:1 message gets exactly one fixed line.
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toBe(GATE_REFUSAL_TEXT);
    } else {
      // Never a word into a group chat or channel.
      expect(sent).toHaveLength(0);
    }
  });
});

describe('GateMiddleware — non-message activity types', () => {
  const groupChat: Scenario = { conv: 'groupChat', tenant: 'bcr', oid: 'ok' };
  const foreignPersonal: Scenario = { conv: 'personal', tenant: 'foreign', oid: 'ok' };
  const goodPersonal: Scenario = { conv: 'personal', tenant: 'bcr', oid: 'ok' };

  it('drops an Adaptive Card action invoke from a group chat in enforce mode', async () => {
    const invoke = buildActivity(groupChat, {
      type: 'invoke',
      name: 'adaptiveCard/action',
      value: { action: { type: 'Action.Execute', verb: 'retry' } },
    });
    const { warn, reachedBot, sent } = await runTurn('enforce', invoke);
    expect(reachedBot).toBe(false);
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'conversation_type', activityType: 'invoke' }),
      'bot.gate.rejected',
    );
  });

  it.each<[string, Partial<Activity>]>([
    ['fileConsent/invoke', { type: 'invoke', name: 'fileConsent/invoke' }],
    ['conversationUpdate', { type: 'conversationUpdate', membersAdded: [{ id: 'u', name: '' }] }],
    ['installationUpdate', { type: 'installationUpdate', action: 'add' }],
    ['messageUpdate', { type: 'messageUpdate', text: 'edited' }],
    ['messageReaction', { type: 'messageReaction', reactionsAdded: [{ type: 'like' }] }],
  ])('drops %s from a foreign tenant silently in enforce mode', async (_label, overrides) => {
    const { warn, reachedBot, sent } = await runTurn(
      'enforce',
      buildActivity(foreignPersonal, overrides),
    );
    expect(reachedBot).toBe(false);
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'tenant', mode: 'enforce' }),
      'bot.gate.rejected',
    );
  });

  it('lets a well-formed personal invoke through', async () => {
    const invoke = buildActivity(goodPersonal, { type: 'invoke', name: 'adaptiveCard/action' });
    const { warn, reachedBot } = await runTurn('enforce', invoke);
    expect(reachedBot).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs ids and codes only — no names, text or tenant ids', async () => {
    const { warn } = await runTurn('log', buildActivity(foreignPersonal));
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(fields).sort()).toEqual(
      ['activityId', 'activityType', 'conversationType', 'mode', 'reason'].sort(),
    );
    expect(JSON.stringify(fields)).not.toContain(FOREIGN_TENANT);
  });

  it('uses the shared logger when none is injected', async () => {
    const adapter = new TestAdapter(async () => undefined);
    adapter.use(new GateMiddleware({ tenantId: BCR_TENANT, mode: 'enforce' }));
    await adapter.processActivity(buildActivity(groupChat));
    expect(adapter.activeQueue).toHaveLength(0);
  });
});
