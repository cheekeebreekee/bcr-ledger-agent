import { app, type HttpResponseInit } from '@azure/functions';
import { buildMyDocsResponse } from '../tab/myDocsPage';

/**
 * `GET /api/mydocs` — a static "where are my documents" page (P0-5).
 *
 * The Personal Tab is gone from the manifest; the route remains so installs
 * of the old app version get a page instead of a 404. It deliberately takes
 * no input: the request (and its query string) is never read, and nothing is
 * looked up. See `tab/myDocsPage.ts`.
 */
app.http('mydocs', {
  route: 'mydocs',
  methods: ['GET'],
  authLevel: 'anonymous', // Called by Teams inside a personal tab iframe.
  handler: handleMyDocs,
});

export async function handleMyDocs(): Promise<HttpResponseInit> {
  return buildMyDocsResponse();
}
