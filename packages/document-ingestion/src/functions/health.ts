import { app, type HttpResponseInit } from '@azure/functions';
import type { InboxSweepMode, MembershipCheckMode } from '@bcr/shared';
import { loadIngestionConfig } from '../config';

/**
 * Trivial liveness probe — no auth, no calls out. Used by Bicep's
 * `healthCheckPath` to mark the slot warm before swap, and by App Insights
 * availability tests. It reads only the configuration loaded at cold start.
 *
 * `build.routing` says which routing this build does. Operator tools gate on
 * it: `tools/directory-bindings.mjs apply` only writes guest ids and channel
 * folders into Directory rows once the running build routes by identity only
 * (`--expect-health build.routing=identity-only`). Writing them into rows the
 * old build still reads would feed its content-promotion path. Keep `phase`
 * and `routing` exactly as they are.
 *
 * `build.membershipCheck` is `MEMBERSHIP_CHECK_MODE`: `enforce` when a bound
 * uploader must be in their row's Team and no other, `off` when that check is
 * switched off (R46 open). An operator can require it with
 * `--expect-health build.membershipCheck=enforce`.
 *
 * `build.inboxSweep` is `INBOX_SWEEP_MODE`: `off`, `shadow` (reads, and logs
 * what it would move) or `enforce` (moves client uploads inside their channel
 * folder). An operator checks a mode change took effect here before reading
 * the sweep's logs.
 */
app.http('health', {
  route: 'health',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handleHealth,
});

export async function handleHealth(): Promise<HttpResponseInit> {
  const config = loadIngestionConfig();
  return {
    status: 200,
    jsonBody: healthBody(config.membershipCheckMode, config.inboxSweepMode, new Date()),
  };
}

export function healthBody(
  membershipCheck: MembershipCheckMode,
  inboxSweep: InboxSweepMode,
  now: Date,
) {
  return {
    status: 'ok',
    service: 'document-ingestion',
    build: { phase: 'p0', routing: 'identity-only', membershipCheck, inboxSweep },
    timestamp: now.toISOString(),
  } as const;
}
