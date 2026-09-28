import { app, type InvocationContext, type Timer } from '@azure/functions';
import { createLogger } from '@bcr/shared';
import { reviewNotifier } from '../runtime';

const log = createLogger('ingestion/reviewNotify');

/**
 * Every 10 minutes: tell the staff chat which documents wait for review
 * (`services/reviewNotifier.ts`). Off, and returning at once, unless the
 * index writes and `REVIEW_WEBHOOK_URL` resolves to a webhook.
 */
app.timer('reviewNotify', {
  schedule: '0 */10 * * * *',
  runOnStartup: false,
  handler: handleReviewNotify,
});

export async function handleReviewNotify(_timer: Timer, context: InvocationContext): Promise<void> {
  if (!reviewNotifier) return;
  await reviewNotifier.run(log.child({ invocationId: context.invocationId }));
}
