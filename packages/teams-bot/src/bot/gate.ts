/**
 * The bot gate (P0-3): decides whether an incoming activity may reach the
 * bot's logic at all. Pure and SDK-agnostic on purpose — it reads a
 * structural subset of a Bot Framework `Activity`, so the Microsoft 365
 * Agents SDK port only has to re-wire the middleware, not the rule.
 *
 * An activity passes only if ALL of these hold:
 *   1. it comes from a 1:1 (`personal`) conversation — group chats and team
 *      channels are shared spaces where a document or a reply would be seen
 *      by people who are not its owner;
 *   2. it comes from the BCR tenant (guests are homed in it too);
 *   3. the sender has an AAD object id shaped like a GUID — routing is
 *      identity-based, so an activity without a verifiable identity can
 *      never be tied to exactly one client.
 *
 * The checks run in that order and the first failure is the reported reason.
 */

export type GateReason = 'conversation_type' | 'tenant' | 'aad_object_id';

export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: GateReason };

/** The fields of an activity the gate reads. A Bot Framework `Activity` satisfies it. */
export interface GateActivity {
  readonly conversation?: {
    readonly conversationType?: string;
    readonly tenantId?: string;
  };
  /** Teams puts the tenant in `channelData.tenant.id`; typed loosely as the SDK does. */
  readonly channelData?: unknown;
  readonly from?: {
    readonly aadObjectId?: string;
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID.test(value);
}

/**
 * The tenant an activity claims to come from: Teams' `channelData.tenant.id`,
 * else `conversation.tenantId`. The same expression feeds `source.tenantId`
 * in the ingestion request, so the gate and ingestion check the same value.
 */
export function activityTenantId(activity: GateActivity): string | undefined {
  const tenantFromChannelData = readChannelDataTenantId(activity.channelData);
  return tenantFromChannelData ?? activity.conversation?.tenantId;
}

export function evaluateGate(activity: GateActivity, expectedTenantId: string): GateResult {
  if (activity.conversation?.conversationType !== 'personal') {
    return { ok: false, reason: 'conversation_type' };
  }

  const tenantId = activityTenantId(activity);
  if (!tenantId || tenantId.toLowerCase() !== expectedTenantId.toLowerCase()) {
    return { ok: false, reason: 'tenant' };
  }

  if (!isGuid(activity.from?.aadObjectId)) {
    return { ok: false, reason: 'aad_object_id' };
  }

  return { ok: true };
}

function readChannelDataTenantId(channelData: unknown): string | undefined {
  if (typeof channelData !== 'object' || channelData === null) return undefined;
  const tenant = (channelData as { tenant?: unknown }).tenant;
  if (typeof tenant !== 'object' || tenant === null) return undefined;
  const id = (tenant as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}
