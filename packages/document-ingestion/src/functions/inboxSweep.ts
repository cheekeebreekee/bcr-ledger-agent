import { app, type InvocationContext, type Timer } from '@azure/functions';
import { createLogger } from '@bcr/shared';
import { channelInbox } from '../runtime';

const log = createLogger('ingestion/inboxSweep');

/**
 * Every 2 minutes: sweep each bound client's channel folder
 * ("Dokumenty księgowe") and file the client's uploads inside it. The logic
 * is `services/channelInbox.ts`; this is wiring only.
 *
 * A timer trigger runs as a singleton across the app's instances (a storage
 * lease), and a tick that is still running delays the next. `INBOX_SWEEP_MODE`
 * is `off` unless set, and then the tick returns at once.
 */
app.timer('inboxSweep', {
  schedule: '0 */2 * * * *',
  runOnStartup: false,
  handler: handleInboxSweep,
});

export async function handleInboxSweep(_timer: Timer, context: InvocationContext): Promise<void> {
  if (channelInbox.mode === 'off') return;
  await channelInbox.sweep(log.child({ invocationId: context.invocationId }));
}
