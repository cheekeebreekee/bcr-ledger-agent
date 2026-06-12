import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import {
  createLogger,
  LedgerAgentError,
  type IngestionRequestPayload,
  type IngestionResponsePayload,
  type Logger,
} from '@bcr/shared';
import { loadIngestionConfig } from '../config';
import { AuthMiddleware } from '../auth/authMiddleware';
import { createGraphClient } from '../services/graphClient';
import { SharePointService } from '../services/sharePointService';
import {
  ClassificationService,
  FallbackClassifier,
  FilenameRegexClassifier,
} from '../services/classificationService';
import { DocumentIntelligenceClassifier } from '../services/documentIntelligenceClassifier';
import { validateIngestionPayload } from './validation';

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
  new FilenameRegexClassifier(),
  ...(config.documentIntelligenceEnabled &&
  config.documentIntelligenceEndpoint &&
  config.documentIntelligenceKey
    ? [
        new DocumentIntelligenceClassifier({
          endpoint: config.documentIntelligenceEndpoint,
          apiKey: config.documentIntelligenceKey,
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

async function ingest(
  payload: IngestionRequestPayload,
  content: Buffer,
  reqLog: Logger,
): Promise<NonNullable<IngestionResponsePayload['result']>> {
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
