import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import {
  createLogger,
  LedgerAgentError,
  type IngestionBatchItemResult,
  type IngestionBatchRequestPayload,
  type IngestionBatchResponsePayload,
  type IngestionDocument,
  type IngestionRequestPayload,
  type IngestionResponsePayload,
  type IngestionUploadResult,
  type Logger,
} from '@bcr/shared';
import { loadIngestionConfig } from '../config';
import { AuthMiddleware } from '../auth/authMiddleware';
import { createGraphClient } from '../services/graphClient';
import { SharePointService } from '../services/sharePointService';
import { ClassificationService, FallbackClassifier } from '../services/classificationService';
import { ClaudeClassifier } from '../services/claudeClassifier';
import { validateBatchIngestionPayload, validateIngestionPayload } from './validation';

const log = createLogger('ingestion/ingestDocument');

// ---------------------------------------------------------------------------
// Cold-start wiring. Singletons per Function App worker.
// ---------------------------------------------------------------------------

const config = loadIngestionConfig();

const auth = new AuthMiddleware({
  tenantId: config.azureTenantId,
  expectedAudience: config.expectedAudience,
  expectedRoles: config.expectedRoles,
});

const graph = createGraphClient();

const sharePoint = new SharePointService(graph, {
  siteHostname: config.sharepointSiteHostname,
  sitePath: config.sharepointSitePath,
  driveName: config.sharepointDriveName,
  ...(config.sharepointRootFolder ? { rootFolder: config.sharepointRootFolder } : {}),
});

const classification = new ClassificationService([
  ...(config.anthropicEnabled && config.anthropicApiKey
    ? [
        new ClaudeClassifier({
          apiKey: config.anthropicApiKey,
          model: config.anthropicModel,
          maxContentBytes: config.anthropicMaxContentBytes,
          confidenceThreshold: config.anthropicConfidenceThreshold,
          ...(config.clientCompanyName ? { clientCompanyName: config.clientCompanyName } : {}),
          ...(config.clientNip ? { clientNip: config.clientNip } : {}),
        }),
      ]
    : []),
  new FallbackClassifier(),
]);

// ---------------------------------------------------------------------------
// HTTP trigger
// ---------------------------------------------------------------------------

app.http('ingestDocument', {
  route: 'ingest',
  methods: ['POST'],
  authLevel: 'anonymous', // we validate JWT ourselves
  handler: handleIngest,
});

app.http('ingestDocumentsBatch', {
  route: 'ingest/batch',
  methods: ['POST'],
  authLevel: 'anonymous', // we validate JWT ourselves
  handler: handleIngestBatch,
});

export async function handleIngest(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const reqLog = log.child({ invocationId: context.invocationId });

  try {
    const caller = await auth.verify(req.headers.get('authorization'));
    reqLog.info({ appId: caller.appId }, 'auth ok');

    const raw = (await req.json()) as unknown;
    const payload = validateIngestionPayload(raw);
    const turnLog = reqLog.child({
      filename: payload.filename,
      conversationId: payload.source.conversationId,
      activityId: payload.source.activityId,
    });

    const content = Buffer.from(payload.contentBase64, 'base64');
    turnLog.info({ sizeBytes: content.length }, 'document received');

    const result = await ingest(payload, content, turnLog);
    return {
      status: 200,
      jsonBody: {
        status: 'uploaded',
        result,
      } satisfies IngestionResponsePayload,
    };
  } catch (err) {
    return handleError(err, reqLog);
  }
}

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
    const caller = await auth.verify(req.headers.get('authorization'));
    reqLog.info({ appId: caller.appId }, 'auth ok');

    const raw = (await req.json()) as unknown;
    const payload = validateBatchIngestionPayload(raw);
    const batchLog = reqLog.child({
      conversationId: payload.source.conversationId,
      activityId: payload.source.activityId,
      documentCount: payload.documents.length,
    });
    batchLog.info('batch received');

    const results: IngestionBatchItemResult[] = [];
    for (const document of payload.documents) {
      results.push(await ingestOne(payload, document, batchLog));
    }

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

async function ingestOne(
  payload: IngestionBatchRequestPayload,
  document: IngestionDocument,
  batchLog: Logger,
): Promise<IngestionBatchItemResult> {
  const docLog = batchLog.child({ filename: document.filename });
  try {
    const content = Buffer.from(document.contentBase64, 'base64');
    docLog.info({ sizeBytes: content.length }, 'document received');
    const result = await ingest(
      { ...document, source: payload.source },
      content,
      docLog,
    );
    return { filename: document.filename, status: 'uploaded', result };
  } catch (err) {
    docLog.error({ err }, 'batch document failed');
    const { code, message } =
      err instanceof LedgerAgentError
        ? { code: err.code, message: err.message }
        : { code: 'InternalError', message: 'Internal error' };
    return { filename: document.filename, status: 'rejected', error: { code, message } };
  }
}

async function ingest(
  payload: IngestionRequestPayload,
  content: Buffer,
  reqLog: Logger,
): Promise<IngestionUploadResult> {
  const classified = await classification.classify({
    filename: payload.filename,
    contentType: payload.contentType,
    readContent: async () => content,
  });
  reqLog.info(
    { documentType: classified.documentType, folderPath: classified.folderPath },
    'classified',
  );

  const item = await sharePoint.uploadDocument({
    folderPath: classified.folderPath,
    filename: payload.filename,
    contentType: payload.contentType,
    content,
  });
  reqLog.info({ driveItemId: item.id, webUrl: item.webUrl }, 'uploaded');

  return {
    driveItemId: item.id,
    webUrl: item.webUrl,
    folderPath: classified.folderPath,
    finalFilename: item.name,
    classification: {
      documentType: classified.documentType,
      confidence: classified.confidence,
      classifier: classified.classifier,
      ...(typeof classified.fields.reasoning === 'string'
        ? { reasoning: classified.fields.reasoning }
        : {}),
    },
  };
}

function handleError(err: unknown, reqLog: Logger): HttpResponseInit {
  if (err instanceof LedgerAgentError) {
    reqLog.warn({ err, code: err.code }, 'request rejected');
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
