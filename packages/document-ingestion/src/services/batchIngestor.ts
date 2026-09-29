import { createHash, randomUUID } from 'node:crypto';
import {
  CLIENT_ACCOUNT_REQUIRED,
  LedgerAgentError,
  ValidationError,
  type ClassifierContext,
  type DirectoryClientResolution,
  type IngestionBatchItemResult,
  type IngestionBatchRequestPayload,
  type IngestionDocument,
  type Logger,
  type QuarantineReason,
  type QuarantineResolution,
  type SharePointTarget,
} from '@bcr/shared';
import {
  decisionLogFields,
  retryExhaustedDecision,
  type AcceptanceDecision,
} from './acceptancePolicy';
import type { ClassificationOutcome } from './classificationService';
import type { ClientResolver } from './clientResolver';
import { INDEX_OFF, recordFiling, type DocumentIndex } from './documentIndex';
import { RetryLaterBound, type RetryLaterLast } from './retryLaterBound';
import { SharePointTargetError, type SharePointService } from './sharePointService';

/**
 * How long a batch may run before the documents not yet started are handed
 * back for a retry. Below the ~230 s the Functions front end allows an HTTP
 * request, so the bot gets an answer for every document instead of a 5xx
 * while the invocation goes on filing behind it (and a resend duplicates).
 */
export const BATCH_DEADLINE_MS = 150_000;

/**
 * The code of a document returned unprocessed: the batch ran out of time
 * before it started, or the classifier could not answer now (429, 529, 5xx,
 * a timeout). Such a document is never filed, not even for review.
 */
export const RETRY_LATER = 'RetryLater';

/**
 * "Retry later" answers the same document (same client, same bytes) may get
 * for a reason it may cause itself (a timeout, a 5xx, a lost connection)
 * before it is filed for review with `RETRY_EXHAUSTED` instead: the third
 * send of a document the model cannot read in time is filed, not refused
 * again. 429, 529 and 401–404 never count (`retryLaterBound.ts`).
 */
export const MAX_RETRY_LATER_ATTEMPTS = 3;

/** How long those answers are remembered, from the first. */
export const RETRY_LATER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Where documents are written, as a narrow interface so tests can supply fakes. */
export interface SharePointFactoryLike {
  forTarget(
    target: SharePointTarget,
  ): Pick<SharePointService, 'uploadDocument' | 'setListItemFields'>;
}

/** The collaborators, as narrow interfaces so tests can supply fakes. */
export interface BatchIngestorDeps {
  readonly resolver: Pick<ClientResolver, 'resolve' | 'quarantine'>;
  /** Classification, the acceptance policy included: where to file, or retry later. */
  readonly classification: {
    classify(ctx: ClassifierContext, now?: Date): Promise<ClassificationOutcome>;
  };
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
  /**
   * The document index (`LEDGER_INDEX_MODE`). Told about every document filed
   * into a client's space, after the upload; never about a quarantined one.
   * It never throws. Defaults to off.
   */
  readonly index?: DocumentIndex;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Defaults to {@link BATCH_DEADLINE_MS}. */
  readonly batchDeadlineMs?: number;
  /** Defaults to {@link MAX_RETRY_LATER_ATTEMPTS}. */
  readonly maxRetryLaterAttempts?: number;
}

/**
 * Files every document of one Teams activity.
 *
 * The client is decided once per batch from the uploader's identity. When
 * the uploader is not a client account (a guest, a non-Member, a deleted
 * user, or an account that could not be read), the whole batch is refused
 * before anything is decoded: every document is `rejected`
 * ({@link CLIENT_ACCOUNT_REQUIRED}, or {@link RETRY_LATER} when the account
 * could not be read), and nothing is stored, classified or indexed — not
 * even in the quarantine. Otherwise each document either:
 *  - goes into that client's own space (classified, filed, `uploaded`), or
 *  - goes to the staff-only quarantine (`quarantined`) when the Member is
 *    not tied to exactly one client, or when the client's space turns out to
 *    be unusable. Quarantined documents are never sent to the model, and the
 *    response for them carries no link, folder or name.
 *
 * A failure on one document is captured as that document's row, so a bad file
 * never blocks the rest. A document not started within the batch deadline, or
 * one the classifier could not answer for now, is returned `rejected` with
 * {@link RETRY_LATER}: never filed late, and never filed for review because
 * the model was overloaded. Only a document that keeps getting a "retry
 * later" it may cause itself is, at the {@link MAX_RETRY_LATER_ATTEMPTS}-th
 * send, filed for review (`RETRY_EXHAUSTED`) rather than refused forever.
 *
 * Each document filed into the client's space (in its category or for
 * review) is then recorded in the document index under that client, with the
 * same `documentId`; an index failure is logged and changes nothing here.
 */
export class BatchIngestor {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly deadlineMs: number;
  /**
   * Counted "retry later" answers per client row and content hash. In memory
   * on this worker: a resend that reaches another worker starts again there.
   */
  private readonly retryLaters: RetryLaterBound;
  private readonly index: DocumentIndex;

  constructor(private readonly deps: BatchIngestorDeps) {
    this.index = deps.index ?? INDEX_OFF;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.deadlineMs = deps.batchDeadlineMs ?? BATCH_DEADLINE_MS;
    this.retryLaters = new RetryLaterBound({
      maxAttempts: deps.maxRetryLaterAttempts ?? MAX_RETRY_LATER_ATTEMPTS,
      windowMs: RETRY_LATER_WINDOW_MS,
    });
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
        : resolved.source === 'refused'
          ? { resolution: 'refused', refusalReason: resolved.reason }
          : { resolution: 'quarantine', quarantineReason: resolved.reason },
      'client resolved',
    );

    // Not a client account: nothing is decoded, classified, stored or
    // indexed, and nothing reaches either SharePoint factory.
    if (resolved.source === 'refused') {
      const code =
        resolved.reason === 'identity_unverified' ? RETRY_LATER : CLIENT_ACCOUNT_REQUIRED;
      log.info(
        {
          event: 'batch.refused',
          resolution: 'refused',
          refusalReason: resolved.reason,
          uploaderOid: batch.uploaderOid,
          documentCount: payload.documents.length,
          code,
        },
        'batch.refused',
      );
      return payload.documents.map((d) => ({
        filename: d.filename,
        status: 'rejected',
        error: { code, message: rejectionMessage(code) },
      }));
    }

    const results: IngestionBatchItemResult[] = [];
    let notStarted = 0;
    for (const document of payload.documents) {
      const at = this.now();
      if (at.getTime() - startedAt >= this.deadlineMs) {
        notStarted += 1;
        results.push({
          filename: document.filename,
          status: 'rejected',
          error: { code: RETRY_LATER, message: rejectionMessage(RETRY_LATER) },
        });
        continue;
      }
      results.push(await this.ingestOne(document, resolved, batch, at));
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
    resolved: DirectoryClientResolution | QuarantineResolution,
    batch: BatchContext,
    at: Date,
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
        return await this.fileForClient(document, content, resolved, documentId, batch, docLog, at);
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
    batch: BatchContext,
    docLog: Logger,
    at: Date,
  ): Promise<IngestionBatchItemResult> {
    // Prime the classifier with the bound client's own identity so it can
    // tell sales from purchases. Only this client's identity is ever sent.
    // The classifier reads a copy of the bytes if it must shorten a PDF; the
    // original `content` is what gets filed.
    const ids = { clientId: client.clientId, listItemId: client.listItemId, teamId: client.teamId };
    const outcome = await this.deps.classification.classify(
      {
        filename: document.filename,
        contentType: document.contentType,
        readContent: async () => content,
        ...(client.nip || client.companyName
          ? { client: { nip: client.nip, companyName: client.companyName } }
          : {}),
      },
      at,
    );
    // Hashed only when a "retry later" is, or was, in play.
    let key: string | undefined;
    const keyOf = () => (key ??= retryKey(client, content));
    let decision: AcceptanceDecision;
    let exhausted: RetryLaterLast | undefined;
    if (outcome.kind === 'retry_later') {
      const verdict = this.retryLaters.record(
        keyOf(),
        outcome.reason,
        outcome.status,
        at.getTime(),
      );
      docLog.warn(
        {
          event: 'document.retry_later',
          documentId,
          ...ids,
          classifier: outcome.classifier,
          reason: outcome.reason,
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
          counted: verdict.counted,
          retryLaterAttempt: verdict.attempts,
          maxRetryLaterAttempts: this.retryLaters.maxAttempts,
        },
        'document.retry_later',
      );
      if (!verdict.exhausted) {
        return {
          filename: document.filename,
          status: 'rejected',
          error: { code: RETRY_LATER, message: rejectionMessage(RETRY_LATER) },
        };
      }
      exhausted = {
        attempts: verdict.attempts,
        reason: outcome.reason,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      };
      decision = retryExhaustedDecision(at, outcome.reason);
    } else {
      decision = outcome.decision;
    }

    const item = await this.deps.clientSharePointFactory.forTarget(client.target).uploadDocument({
      folderPath: decision.folderPath,
      filename: document.filename,
      contentType: document.contentType,
      content,
    });
    // Filed, for review or not: its earlier "retry later" answers are spent.
    if (this.retryLaters.size > 0) this.retryLaters.forget(keyOf());
    docLog.info(
      {
        event: 'document.filed',
        documentId,
        ...ids,
        driveItemId: item.id,
        review: decision.review,
        ...decisionLogFields(decision),
        ...(exhausted
          ? {
              unclassified: true,
              retryLaterAttempts: exhausted.attempts,
              ...(exhausted.status !== undefined ? { status: exhausted.status } : {}),
            }
          : {}),
      },
      'document.filed',
    );
    // Filed: the index follows, in this client's scope. Never throws.
    await recordFiling(
      this.index,
      {
        documentId,
        source: 'bot',
        client: {
          listItemId: client.listItemId,
          clientNo: client.clientId,
          nip: client.nip,
          legalName: client.companyName,
        },
        driveId: client.target.expectedDriveId ?? item.parentReference?.driveId ?? '',
        driveItemId: item.id,
        decision,
        ...(batch.uploaderOid ? { uploadedByOid: batch.uploaderOid } : {}),
        content,
        sizeBytes: content.length,
        ...(item.webUrl ? { webUrl: item.webUrl } : {}),
      },
      docLog,
    );

    return {
      filename: document.filename,
      status: 'uploaded',
      result: {
        driveItemId: item.id,
        webUrl: item.webUrl,
        folderPath: decision.folderPath,
        finalFilename: item.name,
        classification: {
          documentType: decision.documentType,
          categoryId: decision.category,
          confidence: decision.confidence,
          classifier: decision.classifier,
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

/** One document of one client: the row and a hash of the bytes, never a name. */
function retryKey(client: DirectoryClientResolution, content: Buffer): string {
  return `${client.listItemId}|${createHash('sha256').update(content).digest('hex')}`;
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
      return 'The document was not processed now; send it again later';
    case CLIENT_ACCOUNT_REQUIRED:
      return 'This account may not file documents';
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
