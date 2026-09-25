import { app, type HttpResponseInit } from '@azure/functions';

/**
 * Trivial liveness probe — no auth, no dependencies. Used by Bicep's
 * `healthCheckPath` to mark the slot warm before swap, and by App Insights
 * availability tests.
 *
 * `build.routing` says which routing this build does. Operator tools gate on
 * it: `tools/directory-bindings.mjs apply` only writes guest ids and channel
 * folders into Directory rows once the running build routes by identity only
 * (`--expect-health build.routing=identity-only`). Writing them into rows the
 * old build still reads would feed its content-promotion path.
 */
app.http('health', {
  route: 'health',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (): Promise<HttpResponseInit> => ({
    status: 200,
    jsonBody: {
      status: 'ok',
      service: 'document-ingestion',
      build: { phase: 'p0', routing: 'identity-only' },
      timestamp: new Date().toISOString(),
    },
  }),
});
