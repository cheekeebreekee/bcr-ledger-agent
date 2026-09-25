import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import {
  createLogger,
  LedgerAgentError,
  ValidationError,
  type UserTargetResponsePayload,
} from '@bcr/shared';
import { auth, clientResolver } from '../runtime';

const log = createLogger('ingestion/userTarget');

/**
 * `GET /api/user-target?userAadObjectId={guid}`
 *
 * Given a Teams user's AAD object id, returns which SharePoint site their
 * client documents live in — used by the bot's Personal Tab to send the
 * user straight to their client's document library.
 *
 * Uses the same JWT auth as `/api/ingest` — callers need the
 * `Documents.Ingest` app role. We're not exposing user→client mapping
 * anonymously because it's a mild information disclosure (an attacker with
 * a valid AAD id could otherwise enumerate which client that user belongs
 * to).
 */
app.http('userTarget', {
  route: 'user-target',
  methods: ['GET'],
  authLevel: 'anonymous', // we validate JWT ourselves
  handler: handleUserTarget,
});

export async function handleUserTarget(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const reqLog = log.child({ invocationId: context.invocationId });

  try {
    const caller = await auth.verify(req.headers.get('authorization'));
    reqLog.info({ appId: caller.appId }, 'auth ok');

    const userAadObjectId = req.query.get('userAadObjectId')?.trim().toLowerCase() ?? '';
    if (!userAadObjectId) {
      throw new ValidationError('userAadObjectId query parameter is required');
    }

    // Reuse the same resolver the ingest pipeline uses so routing stays
    // consistent between "where the bot files a document" and "where the
    // Personal Tab sends the user". Content-based post-classification
    // refinement doesn't apply here (no document to classify).
    const resolved = await clientResolver.resolve({
      // Minimum-viable IngestionSource for the resolver: only the two fields
      // it actually reads. Everything else can be empty for this lookup.
      tenantId: '',
      channelId: '',
      conversationId: '',
      activityId: '',
      teamsChannelId: undefined,
      userAadObjectId,
      userDisplayName: undefined,
    });

    const sharepointWebUrl = buildDriveWebUrl(
      resolved.target.siteHostname,
      resolved.target.sitePath,
      resolved.target.driveName,
    );

    const body: UserTargetResponsePayload = {
      clientId: resolved.clientId,
      title: resolved.title,
      source: resolved.source,
      siteHostname: resolved.target.siteHostname,
      sitePath: resolved.target.sitePath,
      driveName: resolved.target.driveName,
      sharepointWebUrl,
    };

    reqLog.info(
      { userAadObjectId, clientId: body.clientId, source: body.source },
      'user target resolved',
    );

    return {
      status: 200,
      jsonBody: body,
    };
  } catch (err) {
    if (err instanceof LedgerAgentError) {
      reqLog.warn({ err, code: err.code }, 'request rejected');
      return {
        status: err.httpStatus,
        jsonBody: { error: { code: err.code, message: err.message } },
      };
    }
    reqLog.error({ err }, 'unhandled error');
    return {
      status: 500,
      jsonBody: { error: { code: 'InternalError', message: 'Internal error' } },
    };
  }
}

/**
 * Best-effort URL for the drive's default document library view. SharePoint
 * uses different routing conventions per tenant locale:
 *   - English tenants: drive `Documents` → `/Shared Documents`
 *   - Polish tenants:  drive `Dokumenty` → `/Dokumenty`
 * For anything else we fall through to just the site homepage — the user
 * can click through to Documents in the SharePoint sidebar.
 */
function buildDriveWebUrl(siteHostname: string, sitePath: string, driveName: string): string {
  if (!siteHostname || !sitePath) return '';
  const site = `https://${siteHostname}${sitePath}`;
  if (driveName === 'Documents') return `${site}/Shared%20Documents`;
  if (driveName === 'Dokumenty') return `${site}/Dokumenty`;
  return site;
}
