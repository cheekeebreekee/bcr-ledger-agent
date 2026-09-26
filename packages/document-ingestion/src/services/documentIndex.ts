import { createHash } from 'node:crypto';
import {
  clientIdForDirectoryRow,
  clientsRepo,
  documentsRepo,
  LedgerDbError,
  sqlStateOf,
  type DocumentRecord,
  type LedgerDb,
} from '@bcr/ledger-db';
import { DOCUMENT_EXTRACTION_FIELDS, type LedgerIndexMode, type Logger } from '@bcr/shared';
import type { AcceptanceDecision } from './acceptancePolicy';

/** The bound Client Directory row a document was filed for. */
export interface IndexedClient {
  /** The row's list item id: what the index's client row is keyed by. */
  readonly listItemId: string;
  /** The row's `ClientId` (business number, e.g. `0002`). */
  readonly clientNo: string;
  /** The client's own NIP from the row. Stored only if valid. */
  readonly nip: string;
  readonly legalName: string;
}

/** One document filed into a client's space, in its category or in `98_` for review. */
export interface IndexedDocument {
  readonly documentId: string;
  readonly source: 'bot' | 'inbox';
  readonly client: IndexedClient;
  /** The client's drive (the row's `DriveId`). */
  readonly driveId: string;
  readonly driveItemId: string;
  /** Where the acceptance policy filed it, with the classifier's invoice fields. */
  readonly decision: AcceptanceDecision;
  readonly uploadedByOid?: string;
  /** The bytes, when the filer has them: hashed (only in `write`), never stored. */
  readonly content?: Buffer;
  /** Or their hex SHA-256, when the filer hashed them already. */
  readonly contentSha256?: string;
  readonly sizeBytes?: number;
}

/**
 * The document index as the two intakes see it: `record` after a document is
 * filed (never before, never for a quarantined one), and it never throws.
 */
export interface DocumentIndex {
  readonly mode: LedgerIndexMode;
  record(doc: IndexedDocument, log: Logger): Promise<void>;
}

/** `LEDGER_INDEX_MODE=off`: nothing is connected to and nothing is written. */
export const INDEX_OFF: DocumentIndex = {
  mode: 'off',
  async record() {
    // Off: filing never waits on the index.
  },
};

/**
 * What the intakes call after filing: `index.record`, with its contract held
 * even by an index that breaks it. A document already filed must never be
 * reported as failed (the bot's user would send it again) or counted as a
 * failed move because of the index: anything thrown is logged as
 * `index.write_failed` (`reason` `error`) and swallowed.
 */
export async function recordFiling(
  index: DocumentIndex,
  doc: IndexedDocument,
  log: Logger,
): Promise<void> {
  try {
    await index.record(doc, log);
  } catch (err) {
    log.warn(
      {
        event: 'index.write_failed',
        documentId: doc.documentId,
        clientId: doc.client.clientNo,
        listItemId: doc.client.listItemId,
        driveItemId: doc.driveItemId,
        source: doc.source,
        reason: 'error',
        err: err instanceof Error ? { name: err.name } : { type: typeof err },
      },
      'index.write_failed',
    );
  }
}

/** How long writes are skipped after the database could not be reached. */
export const INDEX_UNAVAILABLE_COOLDOWN_MS = 60_000;

export interface LedgerDocumentIndexOptions {
  /** The index database (`@bcr/ledger-db`); only its client transaction is used. */
  readonly db: Pick<LedgerDb, 'withClientTx'>;
  /** `CLIENT_DIRECTORY_LIST_ID`: part of every client's derived id. */
  readonly directoryListId: string;
  /** Defaults to {@link INDEX_UNAVAILABLE_COOLDOWN_MS}. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

/** Why an index write failed, as logged. Codes only. */
export type IndexFailure =
  | 'unavailable'
  | 'constraint'
  | 'row_security'
  | 'scope'
  | 'invalid_record'
  | 'error';

/**
 * `LEDGER_INDEX_MODE=write`. Each filed document becomes one row, written in
 * a transaction scoped to its client: the client id is derived from the bound
 * Directory row the document was filed for (never from the document), the
 * client row is upserted by that row's list item id, and the document row is
 * idempotent on (client, drive item), so a retried write never duplicates.
 *
 * A failed write never blocks or undoes the filing: `record` logs
 * `index.write_failed` with ids and a reason code only (a later reconcile can
 * backfill), and resolves. When the database cannot be reached (a timeout, a
 * refused connection, no token), writes are skipped for
 * {@link INDEX_UNAVAILABLE_COOLDOWN_MS} so a batch of 25 documents does not
 * wait 25 connection timeouts.
 */
export class LedgerDocumentIndex implements DocumentIndex {
  readonly mode = 'write' as const;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private unavailableUntil = 0;

  constructor(private readonly opts: LedgerDocumentIndexOptions) {
    this.cooldownMs = opts.cooldownMs ?? INDEX_UNAVAILABLE_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  async record(doc: IndexedDocument, log: Logger): Promise<void> {
    const ids = {
      documentId: doc.documentId,
      clientId: doc.client.clientNo,
      listItemId: doc.client.listItemId,
      driveItemId: doc.driveItemId,
    };
    const status = doc.decision.review ? 'NEEDS_REVIEW' : 'FILED';
    if (this.now() < this.unavailableUntil) {
      log.warn(
        {
          event: 'index.write_failed',
          ...ids,
          source: doc.source,
          reason: 'unavailable',
          skipped: true,
        },
        'index.write_failed',
      );
      return;
    }
    let ledgerClientId: string | undefined;
    try {
      ledgerClientId = clientIdForDirectoryRow(this.opts.directoryListId, doc.client.listItemId);
      const record = toRecord(doc);
      const outcome = await this.opts.db.withClientTx(ledgerClientId, async (tx) => {
        await clientsRepo.upsertFromDirectory(tx, {
          directoryListId: this.opts.directoryListId,
          listItemId: doc.client.listItemId,
          clientNo: doc.client.clientNo,
          nip: doc.client.nip,
          legalName: doc.client.legalName,
          active: true,
        });
        return doc.decision.review
          ? documentsRepo.recordReview(tx, record)
          : documentsRepo.recordFiled(tx, record);
      });
      log.info(
        {
          event: 'index.written',
          ...ids,
          ledgerClientId,
          source: doc.source,
          status,
          created: outcome.created,
          ...(outcome.documentId !== doc.documentId
            ? { indexedDocumentId: outcome.documentId }
            : {}),
          invoiceFields: countFields(doc.decision),
        },
        'index.written',
      );
    } catch (err) {
      const reason = failureOf(err);
      if (reason === 'unavailable') this.unavailableUntil = this.now() + this.cooldownMs;
      log.warn(
        {
          event: 'index.write_failed',
          ...ids,
          ...(ledgerClientId ? { ledgerClientId } : {}),
          source: doc.source,
          status,
          reason,
          err: describeError(err),
        },
        'index.write_failed',
      );
    }
  }
}

/** The index row of a filed document. The client is the transaction's, never a field. */
export function toRecord(doc: IndexedDocument): DocumentRecord {
  const d = doc.decision;
  return {
    documentId: doc.documentId,
    source: doc.source,
    driveId: doc.driveId,
    driveItemId: doc.driveItemId,
    category: d.category,
    ...(d.suggestedCategory ? { suggestedCategory: d.suggestedCategory } : {}),
    // An unclassified review (no classifier answered) has no confidence to record.
    ...(d.classifier ? { confidence: d.confidence, classifier: d.classifier } : {}),
    ...(d.model ? { model: d.model } : {}),
    reviewReasons: d.reviewReasons,
    ...(d.month ? { documentMonth: d.month } : {}),
    folderPath: d.folderPath,
    ...(doc.uploadedByOid ? { uploadedByOid: doc.uploadedByOid.toLowerCase() } : {}),
    ...(doc.contentSha256
      ? { contentSha256: doc.contentSha256 }
      : doc.content
        ? { contentSha256: createHash('sha256').update(doc.content).digest('hex') }
        : {}),
    ...(doc.sizeBytes !== undefined ? { sizeBytes: doc.sizeBytes } : {}),
    ...(d.extraction ? { invoice: d.extraction } : {}),
  };
}

function countFields(decision: AcceptanceDecision): number {
  const e = decision.extraction;
  return e ? DOCUMENT_EXTRACTION_FIELDS.filter((f) => e[f] !== null).length : 0;
}

/**
 * SQLSTATE classes that mean the server could not be used at all, as opposed
 * to a statement it refused: connection (08), resources (53), operator
 * intervention (57), authentication (28), no such database (3D).
 */
const UNAVAILABLE_SQLSTATE = /^(08|53|57|28|3D)/;

function failureOf(err: unknown): IndexFailure {
  if (err instanceof LedgerDbError) {
    if (err.reason === 'no_token') return 'unavailable';
    if (err.reason === 'invalid_scope' || err.reason === 'scope_mismatch') return 'scope';
    if (err.reason === 'invalid_record') return 'invalid_record';
    return 'error';
  }
  const code = sqlStateOf(err);
  if (code === '42501') return 'row_security';
  if (code?.startsWith('23')) return 'constraint';
  if (code && UNAVAILABLE_SQLSTATE.test(code)) return 'unavailable';
  if (code) return 'error';
  // No SQLSTATE: the connection itself (refused, reset, TLS, a timeout).
  return 'unavailable';
}

/**
 * Name, SQLSTATE and the index's own reason only. Never a message: a
 * PostgreSQL message quotes the values it refused (`Key (nip)=(…)`).
 */
function describeError(err: unknown): Record<string, unknown> {
  const code = sqlStateOf(err);
  return {
    ...(err instanceof Error ? { name: err.name } : { type: typeof err }),
    ...(code ? { sqlState: code } : {}),
    ...(err instanceof LedgerDbError ? { indexReason: err.reason } : {}),
  };
}
