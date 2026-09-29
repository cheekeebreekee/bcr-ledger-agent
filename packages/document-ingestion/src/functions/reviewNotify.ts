import { app, type InvocationContext, type Timer } from '@azure/functions';
import { createLogger } from '@bcr/shared';
import { reviewNoticesOff, reviewNotifier } from '../runtime';
import { runReviewNotices } from '../services/reviewNotifier';

const log = createLogger('ingestion/reviewNotify');

/**
 * Every 10 minutes: tell the staff chat which documents wait for review
 * (`services/reviewNotifier.ts`). Off, and returning at once, unless the
 * index writes and `REVIEW_WEBHOOK_URL` resolves to a webhook; a webhook
 * setting that did not resolve is said on every run (`review_notice.off`).
 */
app.timer('reviewNotify', {
  schedule: '0 */10 * * * *',
  runOnStartup: false,
  handler: handleReviewNotify,
});

export async function handleReviewNotify(_timer: Timer, context: InvocationContext): Promise<void> {
  await runReviewNotices(
    reviewNotifier,
    reviewNoticesOff,
    log.child({ invocationId: context.invocationId }),
  );
}
