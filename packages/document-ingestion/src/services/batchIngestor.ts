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

/** The collaborators, as narrow interfaces so tests can supply fakes. */
export interface BatchIngestorDeps {
  readonly resolver: Pick<ClientResolver, 'resolve' | 'resolvePostClassification' | 'quarantine'>;
  readonly classification: { classify(ctx: ClassifierContext): Promise<Classification> };
  readonly sharePointFactory: {
    forTarget(target: SharePointTarget): Pick<SharePointService, 'uploadDocument' | 'setListItemFields'>;
  };
  readonly now?: () => Date;
  readonly newId?: () => string;
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
 * never blocks the rest.
 */
export class BatchIngestor {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: BatchIngestorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async ingestBatch(
    payload: IngestionBatchRequestPayload,
    log: Logger,
  ): Promise<IngestionBatchItemResult[]> {
    const resolved = await this.deps.resolver.resolve(payload.source);
    const batch: BatchContext = {
      batchId: this.newId(),
      uploaderOid: payload.source.userAadObjectId ?? '',
      log,
    };
    log.info(
      resolved.source === 'directory'
        ? { resolution: 'directory', clientId: resolved.clientId, listItemId: resolved.listItemId }
        : { resolution: 'quarantine', quarantineReason: resolved.reason },
      'client resolved',
    );

    const results: IngestionBatchItemResult[] = [];
    for (const document of payload.documents) {
      results.push(await this.ingestOne(document, resolved, batch));
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
        return await this.quarantineOne(document, content, resolved.reason, documentId, batch, docLog);
      }
      try {
        return await this.fileForClient(document, content, resolved, documentId, docLog);
      } catch (err) {
        // A client whose space can't be written must not lose the document,
        // and must not have it written anywhere else. Hold it for staff.
        if (err instanceof SharePointTargetError || isSharePointFailure(err)) {
          const reason: QuarantineReason =
            err instanceof SharePointTargetError && err.kind === 'drive_mismatch'
              ? 'stale_directory'
              : 'target_unwritable';
          docLog.warn(
            { clientId: resolved.clientId, listItemId: resolved.listItemId, quarantineReason: reason },
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

    const item = await this.deps.sharePointFactory.forTarget(client.target).uploadDocument({
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

    const sharePoint = this.deps.sharePointFactory.forTarget(target);
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
