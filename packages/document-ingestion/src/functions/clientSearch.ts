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
  type IngestionResponsePayload,
  type Logger,
  type SearchResponsePayload,
} from '@bcr/shared';
import { SEARCH_ROLE } from '../auth/authMiddleware';
import { auth, clientSearch, config } from '../runtime';
import { validateSearchPayload } from './validation';

const log = createLogger('ingestion/clientSearch');

// ---------------------------------------------------------------------------
// HTTP trigger
//
// The second route that takes a user id from the body (the other is
// /api/ingest/batch). It is pinned to one caller: the bot Function App's
// managed identity, holding `Documents.Search` (`SEARCH_CALLER_APP_IDS`). The
// bot registration's secret has neither the role nor the app id, so it can
// file documents but never read them. The logic is services/clientSearch.ts.
// ---------------------------------------------------------------------------

app.http('clientSearch', {
  route: 'search',
  methods: ['POST'],
  authLevel: 'anonymous', // we validate JWT ourselves
  handler: handleClientSearch,
});

/**
 * One search: the caller is verified before the body is read, the body is
 * checked strictly, and the service answers (it never throws). Every answer
 * of the service is a 200; a refused caller or body keeps the house 4xx shape.
 */
export async function handleClientSearch(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const reqLog = log.child({ invocationId: context.invocationId, route: 'search' });

  try {
    const caller = await auth.verify(req.headers.get('authorization'), {
      roles: [SEARCH_ROLE],
      appIds: config.searchCallerAppIds,
    });
    reqLog.info({ appId: caller.appId }, 'auth ok');

    const payload = validateSearchPayload(await readJson(req), {
      expectedTenantId: config.azureTenantId,
    });
    const answer = await clientSearch.search(
      payload,
      reqLog.child({ activityId: payload.source.activityId }),
    );
    return { status: 200, jsonBody: answer satisfies SearchResponsePayload };
  } catch (err) {
    return handleError(err, reqLog);
  }
}

/** The body as JSON; one that does not parse is the caller's error (400), not ours. */
async function readJson(req: HttpRequest): Promise<unknown> {
  try {
    return (await req.json()) as unknown;
  } catch {
    throw new ValidationError('Invalid search payload: the body is not JSON');
  }
}

function handleError(err: unknown, reqLog: Logger): HttpResponseInit {
  if (err instanceof LedgerAgentError) {
    reqLog.warn({ code: err.code, httpStatus: err.httpStatus }, 'request rejected');
    return {
      status: err.httpStatus,
      jsonBody: {
        status: 'rejected',
        error: { code: err.code, message: err.message },
      } satisfies IngestionResponsePayload,
    };
  }
  // The name only: nothing of the request is logged.
  reqLog.error(
    { err: err instanceof Error ? { name: err.name } : { type: typeof err } },
    'unhandled error',
  );
  return {
    status: 500,
    jsonBody: {
      status: 'rejected',
      error: { code: 'InternalError', message: 'Internal error' },
    } satisfies IngestionResponsePayload,
  };
}
