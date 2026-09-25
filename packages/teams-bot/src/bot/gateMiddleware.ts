import { ActivityTypes, type Middleware, type TurnContext } from 'botbuilder';
import { type BotConfig, createLogger, type Logger } from '@bcr/shared';
import { evaluateGate } from './gate';
import { GATE_REFUSAL_TEXT } from './cardText';

export type GateMode = BotConfig['botGateMode'];

export interface GateMiddlewareOptions {
  /** The BCR tenant (`MICROSOFT_APP_TENANT_ID`). */
  readonly tenantId: string;
  /** `log`: record and let through. `enforce`: record and stop the turn. */
  readonly mode: GateMode;
  readonly logger?: Pick<Logger, 'warn'>;
}

/**
 * Runs `evaluateGate` on EVERY activity the adapter processes — messages,
 * invokes (Adaptive Card actions, file consent), conversation and
 * installation updates, message edits and reactions — before any bot logic.
 * Registered on the adapter (`adapter.use(...)`), so no activity type can
 * reach `LedgerBot` around it.
 *
 * In `enforce` mode a refused turn ends here: no download, no ingestion call.
 * The bot answers only a refused *message* in a 1:1 chat, with one fixed
 * line; in a group chat or channel it stays silent, so it never speaks into
 * a shared conversation.
 */
export class GateMiddleware implements Middleware {
  private readonly log: Pick<Logger, 'warn'>;

  constructor(private readonly opts: GateMiddlewareOptions) {
    this.log = opts.logger ?? createLogger('bot/gate');
  }

  async onTurn(context: TurnContext, next: () => Promise<void>): Promise<void> {
    const { activity } = context;
    const verdict = evaluateGate(activity, this.opts.tenantId);
    if (verdict.ok) {
      await next();
      return;
    }

    this.log.warn(
      {
        reason: verdict.reason,
        mode: this.opts.mode,
        activityType: activity.type,
        conversationType: activity.conversation?.conversationType,
        activityId: activity.id,
      },
      'bot.gate.rejected',
    );

    if (this.opts.mode === 'log') {
      await next();
      return;
    }

    if (
      activity.type === ActivityTypes.Message &&
      activity.conversation?.conversationType === 'personal'
    ) {
      await context.sendActivity(GATE_REFUSAL_TEXT);
    }
  }
}
