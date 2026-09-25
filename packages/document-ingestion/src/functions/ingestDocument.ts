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
  type ResolvedClient,
} from '@bcr/shared';
import {
  auth,
  classification,
  clientResolver,
  sharePointFactory,
} from '../runtime';
import { validateBatchIngestionPayload, validateIngestionPayload } from './validation';

const log = createLogger('ingestion/ingestDocument');

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
      teamsChannelId: payload.source.teamsChannelId,
    });

    const content = Buffer.from(payload.contentBase64, 'base64');
    turnLog.info({ sizeBytes: content.length }, 'document received');

    const resolved = await clientResolver.resolve(payload.source);
    turnLog.info(
      {
        clientId: resolved.clientId,
        title: resolved.title,
        resolution: resolved.source,
        matchedBy: resolved.matchedBy,
        siteHostname: resolved.target.siteHostname,
        sitePath: resolved.target.sitePath,
      },
      'client resolved',
    );

    const result = await ingest(payload, content, turnLog, resolved);
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
      teamsChannelId: payload.source.teamsChannelId,
      documentCount: payload.documents.length,
    });
    batchLog.info('batch received');

    // Resolve the target client once per batch (all docs in a batch share
    // a Teams activity, so they all belong to the same client).
    const resolved = await clientResolver.resolve(payload.source);
    batchLog.info(
      {
        clientId: resolved.clientId,
        title: resolved.title,
        resolution: resolved.source,
        matchedBy: resolved.matchedBy,
        siteHostname: resolved.target.siteHostname,
        sitePath: resolved.target.sitePath,
      },
      'client resolved',
    );

    const results: IngestionBatchItemResult[] = [];
    for (const document of payload.documents) {
      results.push(await ingestOne(payload, document, batchLog, resolved));
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
  resolved: ResolvedClient,
): Promise<IngestionBatchItemResult> {
  const docLog = batchLog.child({ filename: document.filename });
  try {
    const content = Buffer.from(document.contentBase64, 'base64');
    docLog.info({ sizeBytes: content.length }, 'document received');
    const result = await ingest(
      { ...document, source: payload.source },
      content,
      docLog,
      resolved,
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
  preResolved: ResolvedClient,
): Promise<IngestionUploadResult> {
  // Pass the pre-resolved client identity into the classifier so Claude can
  // decide invoice direction confidently. When pre-resolution was fallback,
  // we omit the hint \u2014 direction is derived post-hoc from extracted parties.
  const classifierClient =
    preResolved.source === 'directory' && (preResolved.nip || preResolved.companyName)
      ? { nip: preResolved.nip, companyName: preResolved.companyName }
      : undefined;

  const classified = await classification.classify({
    filename: payload.filename,
    contentType: payload.contentType,
    readContent: async () => content,
    ...(classifierClient ? { client: classifierClient } : {}),
  });
  reqLog.info(
    {
      documentType: classified.documentType,
      folderPath: classified.folderPath,
      partyCount: classified.parties?.length ?? 0,
    },
    'classified',
  );

  // Post-classification refinement: content-based promotion + direction flip.
  const post = await clientResolver.resolvePostClassification(preResolved, classified);
  if (post.promotedFromFallback || post.directionCorrection) {
    reqLog.info(
      {
        clientId: post.client.clientId,
        title: post.client.title,
        resolution: post.client.source,
        matchedBy: post.client.matchedBy,
        siteHostname: post.client.target.siteHostname,
        sitePath: post.client.target.sitePath,
        promotedFromFallback: post.promotedFromFallback,
        directionCorrection: post.directionCorrection,
        folderPath: post.classification.folderPath,
      },
      'client refined post-classification',
    );
  }

  const sharePoint = sharePointFactory.forTarget(post.client.target);
  const item = await sharePoint.uploadDocument({
    folderPath: post.classification.folderPath,
    filename: payload.filename,
    contentType: payload.contentType,
    content,
  });
  reqLog.info({ driveItemId: item.id, webUrl: item.webUrl }, 'uploaded');

  return {
    driveItemId: item.id,
    webUrl: item.webUrl,
    folderPath: post.classification.folderPath,
    finalFilename: item.name,
    classification: {
      documentType: post.classification.documentType,
      categoryId: String(post.classification.fields.category ?? ''),
      confidence: post.classification.confidence,
      classifier: post.classification.classifier,
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
