import { app, type HttpResponseInit } from '@azure/functions';

/**
 * Trivial liveness probe — no auth, no dependencies. Used by Bicep's
 * `healthCheckPath` to mark the slot warm before swap, and by App Insights
 * availability tests.
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
      timestamp: new Date().toISOString(),
    },
  }),
});
