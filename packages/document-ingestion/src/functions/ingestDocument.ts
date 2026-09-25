import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import {
  createLogger,
  LedgerAgentError,
  type IngestionBatchResponsePayload,
  type IngestionResponsePayload,
  type Logger,
} from '@bcr/shared';
import { auth, batchIngestor, config } from '../runtime';
import { validateBatchIngestionPayload } from './validation';

const log = createLogger('ingestion/ingestDocument');

// ---------------------------------------------------------------------------
// HTTP trigger
//
// The single-document route (`/api/ingest`) is gone: nothing called it, and
// every extra route on the app that can write to every client's site is
// attack surface.
// ---------------------------------------------------------------------------

app.http('ingestDocumentsBatch', {
  route: 'ingest/batch',
  methods: ['POST'],
  authLevel: 'anonymous', // we validate JWT ourselves
  handler: handleIngestBatch,
});

/**
 * Batch entry point. Classifies and files every document in the request,
 * returning one consolidated table of per-document outcomes. A failure on
 * a single document is captured as a `rejected` item rather than failing
 * the whole batch, so a bad file never blocks the rest.
 */
export async function handleIngestBatch(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const reqLog = log.child({ invocationId: context.invocationId });

  try {
    const caller = await auth.verify(req.headers.get('authorization'), {
      roles: config.expectedRoles,
      appIds: config.botCallerAppIds,
    });
    reqLog.info({ appId: caller.appId }, 'auth ok');

    const raw = (await req.json()) as unknown;
    const payload = validateBatchIngestionPayload(raw, { expectedTenantId: config.azureTenantId });
    const batchLog = reqLog.child({
      activityId: payload.source.activityId,
      documentCount: payload.documents.length,
    });
    batchLog.info('batch received');

    const results = await batchIngestor.ingestBatch(payload, batchLog);
    return {
      status: 200,
      jsonBody: {
        status: 'completed',
        results,
      } satisfies IngestionBatchResponsePayload,
    };
  } catch (err) {
    return handleError(err, reqLog);
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
  reqLog.error({ err }, 'unhandled error');
  return {
    status: 500,
    jsonBody: {
      status: 'rejected',
      error: { code: 'InternalError', message: 'Internal error' },
    } satisfies IngestionResponsePayload,
  };
}
