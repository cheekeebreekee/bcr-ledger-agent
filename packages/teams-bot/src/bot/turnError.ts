import type { TurnContext } from 'botbuilder';
import type { Logger } from '@bcr/shared';
import { TURN_ERROR_TEXT } from './cardText';

/**
 * Builds the adapter's `onTurnError`. The error is logged in full; the user
 * sees one fixed Polish line with no error text, and only in a 1:1 chat —
 * the bot never speaks into a group chat or channel, even to apologise.
 * A failure to send the apology is logged and swallowed: it must not turn
 * one failed turn into an unhandled rejection.
 */
export function createTurnErrorHandler(
  log: Pick<Logger, 'error'>,
): (context: TurnContext, error: Error) => Promise<void> {
  return async (context, error) => {
    const { activity } = context;
    log.error(
      { err: error, activityId: activity.id, activityType: activity.type },
      'unhandled turn error',
    );
    if (activity.conversation?.conversationType !== 'personal') return;
    try {
      await context.sendActivity(TURN_ERROR_TEXT);
    } catch (sendErr) {
      log.error({ err: sendErr, activityId: activity.id }, 'failed to send turn-error reply');
    }
  };
}
