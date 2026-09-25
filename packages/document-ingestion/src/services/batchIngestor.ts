import { randomUUID } from 'node:crypto';
import {
  LedgerAgentError,
  ValidationError,
  type Classification,
  type ClassifierContext,
  type DirectoryClientResolution,
  type IngestionBatchItemResult,
  type IngestionBatchRequestPayload,
  type IngestionDocument,
  type Logger,
  type QuarantineReason,
  type ResolvedClient,
  type SharePointTarget,
} from '@bcr/shared';
import type { ClientResolver } from './clientResolver';
import { SharePointTargetError, type SharePointService } from './sharePointService';

/**
 * How long a batch may run before the documents not yet started are handed
 * back for a retry. Below the ~230 s the Functions front end allows an HTTP
 * request, so the bot gets an answer for every document instead of a 5xx
 * while the invocation goes on filing behind it (and a resend duplicates).
 */
export const BATCH_DEADLINE_MS = 150_000;

/** The code of a document returned unprocessed because the batch ran out of time. */
export const RETRY_LATER = 'RetryLater';

/** Where documents are written, as a narrow interface so tests can supply fakes. */
export interface SharePointFactoryLike {
  forTarget(
    target: SharePointTarget,
  ): Pick<SharePointService, 'uploadDocument' | 'setListItemFields'>;
}

/** The collaborators, as narrow interfaces so tests can supply fakes. */
export interface BatchIngestorDeps {
  readonly resolver: Pick<ClientResolver, 'resolve' | 'resolvePostClassification' | 'quarantine'>;
  readonly classification: { classify(ctx: ClassifierContext): Promise<Classification> };
  /**
   * For client targets. Refuses a target that resolves to BCR GROUP or to
   * the quarantine site (`forbidden_site`).
   */
  readonly clientSharePointFactory: SharePointFactoryLike;
  /**
   * For the quarantine target only. It must not share the client factory's
   * guard, which would refuse the quarantine site itself.
   */
  readonly quarantineSharePointFactory: SharePointFactoryLike;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Defaults to {@link BATCH_DEADLINE_MS}. */
  readonly batchDeadlineMs?: number;
}

/**
 * Files every document of one Teams activity.
 *
 * The client is decided once per batch from the uploader's identity. Each
 * document then either:
 *  - goes into that client's own space (classified, filed, `uploaded`), or
 *  - goes to the staff-only quarantine (`quarantined`) when the uploader is
 *    not tied to exactly one client, or when the client's space turns out to
 *    be unusable. Quarantined documents are never sent to the model, and the
 *    response for them carries no link, folder or name.
 *
 * A failure on one document is captured as that document's row, so a bad file
 * never blocks the rest. A document not started within the batch deadline is
 * returned `rejected` with {@link RETRY_LATER}, never filed late.
 */
export class BatchIngestor {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly deadlineMs: number;

  constructor(private readonly deps: BatchIngestorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.deadlineMs = deps.batchDeadlineMs ?? BATCH_DEADLINE_MS;
  }

  async ingestBatch(
    payload: IngestionBatchRequestPayload,
    log: Logger,
  ): Promise<IngestionBatchItemResult[]> {
    const startedAt = this.now().getTime();
    const resolved = await this.deps.resolver.resolve(payload.source);
    const batch: BatchContext = {
      batchId: this.newId(),
      uploaderOid: payload.source.userAadObjectId ?? '',
      log,
    };
    log.info(
      resolved.source === 'directory'
        ? {
            resolution: 'directory',
            clientId: resolved.clientId,
            listItemId: resolved.listItemId,
            teamId: resolved.teamId,
          }
        : { resolution: 'quarantine', quarantineReason: resolved.reason },
      'client resolved',
    );

    const results: IngestionBatchItemResult[] = [];
    let notStarted = 0;
    for (const document of payload.documents) {
      if (this.now().getTime() - startedAt >= this.deadlineMs) {
        notStarted += 1;
        results.push({
          filename: document.filename,
          status: 'rejected',
          error: { code: RETRY_LATER, message: rejectionMessage(RETRY_LATER) },
        });
        continue;
      }
      results.push(await this.ingestOne(document, resolved, batch));
    }
    if (notStarted > 0) {
      log.warn(
        {
          event: 'batch.deadline_exceeded',
          notStartedCount: notStarted,
          documentCount: payload.documents.length,
        },
        'batch.deadline_exceeded',
      );
    }
    return results;
  }

  private async ingestOne(
    document: IngestionDocument,
    resolved: ResolvedClient,
    batch: BatchContext,
  ): Promise<IngestionBatchItemResult> {
    const documentId = this.newId();
    const docLog = batch.log.child({ documentId });
    try {
      const content = Buffer.from(document.contentBase64, 'base64');
      docLog.info({ sizeBytes: content.length }, 'document received');

      if (resolved.source === 'quarantine') {
        return await this.quarantineOne(
          document,
          content,
          resolved.reason,
          documentId,
          batch,
          docLog,
        );
      }
      try {
        return await this.fileForClient(document, content, resolved, documentId, docLog);
      } catch (err) {
        // A client whose space can't be written must not lose the document,
        // and must not have it written anywhere else. Hold it for staff.
        if (err instanceof SharePointTargetError || isSharePointFailure(err)) {
          const kind = err instanceof SharePointTargetError ? err.kind : undefined;
          const reason = quarantineReasonFor(kind);
          docLog.warn(
            {
              clientId: resolved.clientId,
              listItemId: resolved.listItemId,
              teamId: resolved.teamId,
              quarantineReason: reason,
              ...(kind ? { targetErrorKind: kind } : {}),
            },
            'client target unusable — holding document in quarantine',
          );
          return await this.quarantineOne(document, content, reason, documentId, batch, docLog);
        }
        throw err;
      }
    } catch (err) {
      docLog.error({ err: describeError(err) }, 'batch document failed');
      const code = err instanceof LedgerAgentError ? err.code : 'InternalError';
      return {
        filename: document.filename,
        status: 'rejected',
        error: { code, message: rejectionMessage(code) },
      };
    }
  }

  private async fileForClient(
    document: IngestionDocument,
    content: Buffer,
    client: DirectoryClientResolution,
    documentId: string,
    docLog: Logger,
  ): Promise<IngestionBatchItemResult> {
    // Prime the classifier with the bound client's own identity so it can
    // tell sales from purchases. Only this client's identity is ever sent.
    const classified = await this.deps.classification.classify({
      filename: document.filename,
      contentType: document.contentType,
      readContent: async () => content,
      ...(client.nip || client.companyName
        ? { client: { nip: client.nip, companyName: client.companyName } }
        : {}),
    });
    const post = this.deps.resolver.resolvePostClassification(client, classified);
    const category = String(post.classification.fields.category ?? '');

    const item = await this.deps.clientSharePointFactory.forTarget(client.target).uploadDocument({
      folderPath: post.classification.folderPath,
      filename: document.filename,
      contentType: document.contentType,
      content,
    });
    docLog.info(
      {
        event: 'document.filed',
        documentId,
        clientId: client.clientId,
        listItemId: client.listItemId,
        teamId: client.teamId,
        category,
        driveItemId: item.id,
        ...(post.directionCorrection ? { directionCorrection: post.directionCorrection } : {}),
      },
      'document.filed',
    );

    return {
      filename: document.filename,
      status: 'uploaded',
      result: {
        driveItemId: item.id,
        webUrl: item.webUrl,
        folderPath: post.classification.folderPath,
        finalFilename: item.name,
        classification: {
          documentType: post.classification.documentType,
          categoryId: category,
          confidence: post.classification.confidence,
          classifier: post.classification.classifier,
        },
      },
    };
  }

  private async quarantineOne(
    document: IngestionDocument,
    content: Buffer,
    reason: QuarantineReason,
    documentId: string,
    batch: BatchContext,
    docLog: Logger,
  ): Promise<IngestionBatchItemResult> {
    const target = this.deps.resolver.quarantine(reason).target;
    const now = this.now();
    const folderPath = [
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      batch.batchId,
    ].join('/');

    const sharePoint = this.deps.quarantineSharePointFactory.forTarget(target);
    let item;
    try {
      item = await sharePoint.uploadDocument({
        folderPath,
        filename: document.filename,
        contentType: document.contentType,
        content,
      });
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      docLog.error(
        { event: 'document.quarantine_failed', err: describeError(err), quarantineReason: reason },
        'document.quarantine_failed',
      );
      throw new LedgerAgentError('QuarantineFailed', 'The document could not be stored', 502, err);
    }

    // The staff who triage this item decide by who sent it, not by what the
    // document says — so the uploader travels with the file.
    await sharePoint.setListItemFields(item.id, {
      UploaderOid: batch.uploaderOid,
      QuarantineReason: reason,
      OriginalFilename: document.filename,
      DocumentId: documentId,
    });
    docLog.info(
      {
        event: 'document.quarantined',
        documentId,
        quarantineReason: reason,
        uploaderOid: batch.uploaderOid,
        driveItemId: item.id,
      },
      'document.quarantined',
    );
    return { filename: document.filename, status: 'quarantined' };
  }
}

interface BatchContext {
  readonly batchId: string;
  readonly uploaderOid: string;
  readonly log: Logger;
}

/**
 * Why a client document is held when its target fails. A resolved site that
 * is BCR GROUP or the quarantine is an incident indicator, kept apart from a
 * missing grant; a drive that no longer matches the row means the Directory
 * is out of date.
 */
function quarantineReasonFor(kind: SharePointTargetError['kind'] | undefined): QuarantineReason {
  switch (kind) {
    case 'forbidden_site':
      return 'forbidden_target';
    case 'drive_mismatch':
      return 'stale_directory';
    default:
      return 'target_unwritable';
  }
}

function isSharePointFailure(err: unknown): boolean {
  return err instanceof LedgerAgentError && err.code === 'SharePointError';
}

/**
 * The message returned for a rejected document. Generic on purpose: the bot
 * renders its own Polish text by code, and nothing from Graph, the model or
 * another client's context should travel back to the uploader.
 */
function rejectionMessage(code: string): string {
  switch (code) {
    case 'ValidationError':
      return 'The document was not accepted (type, name or size)';
    case 'QuarantineFailed':
    case 'SharePointError':
      return 'The document could not be stored; try again later';
    case RETRY_LATER:
      return 'The document was not processed in time; send it again';
    default:
      return 'The document could not be processed';
  }
}

/** Error name/code/status only — messages from Graph can carry paths. */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof LedgerAgentError) {
    return { name: err.name, code: err.code, httpStatus: err.httpStatus };
  }
  if (err instanceof Error) return { name: err.name };
  return { type: typeof err };
}
