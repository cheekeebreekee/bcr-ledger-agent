import {
  SEARCH_PAGE_SIZE,
  SEARCH_TOTAL_CAP,
  normalizeAmount,
  normalizeCurrency,
  normalizeIsoDate,
  normalizeKsefNumber,
  normalizeNip,
} from '@bcr/shared';
import { z } from 'zod';
import { LedgerDbError } from '../errors';
import { joinSql, sql, type Sql } from '../sql';
import { assertClientTx, type ClientTx } from '../tx';
import { filterConditions, parseSearchFilter, type DocumentSearchFilter } from './searchFilter';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const CATEGORY = /^[a-z_]{1,64}$/;

/** Where a document came from. */
export type DocumentSource = 'bot' | 'inbox' | 'backfill';

/** `FILED`: in its category's folder. `NEEDS_REVIEW`: in `98_Nieposortowane`. */
export type DocumentStatus = 'FILED' | 'NEEDS_REVIEW';

/** The invoice fields of a document, as the classifier validated them (all nullable). */
export interface DocumentInvoiceFields {
  readonly invoiceNumber: string | null;
  readonly issueDate: string | null;
  readonly saleDate: string | null;
  readonly currency: string | null;
  readonly netAmount: string | null;
  readonly vatAmount: string | null;
  readonly grossAmount: string | null;
  readonly sellerNip: string | null;
  readonly sellerName: string | null;
  readonly buyerNip: string | null;
  readonly buyerName: string | null;
  readonly ksefNumber: string | null;
}

/** One filed document, as the index records it. The client is the transaction's. */
export interface DocumentRecord {
  /** The server-minted id (the bot path logs it as `documentId`). */
  readonly documentId: string;
  readonly source: DocumentSource;
  readonly driveId: string;
  readonly driveItemId: string;
  /** The taxonomy category it is filed under: `nieposortowane` on review. */
  readonly category: string;
  /** On review: what the classifier suggested. */
  readonly suggestedCategory?: string;
  readonly confidence?: number;
  readonly classifier?: string;
  readonly model?: string;
  readonly reviewReasons: readonly string[];
  /** The document's month as the classifier read it, `YYYY-MM`. */
  readonly documentMonth?: string;
  /** The taxonomy folder path, relative to the client's channel folder. */
  readonly folderPath?: string;
  readonly uploadedByOid?: string;
  /** Hex SHA-256 of the bytes, when the filer had them. */
  readonly contentSha256?: string;
  readonly sizeBytes?: number;
  /** The file's SharePoint link (`https://…`), for staff; client data like the rest of the row. */
  readonly webUrl?: string;
  readonly invoice?: DocumentInvoiceFields;
}

const nullableField = (check: (v: string) => string | null) =>
  z
    .string()
    .nullable()
    .refine((v) => v === null || check(v) === v, 'not in its normalised form');

const recordSchema = z
  .object({
    documentId: z.string().regex(UUID),
    source: z.enum(['bot', 'inbox', 'backfill']),
    driveId: z.string().min(1).max(200),
    driveItemId: z.string().min(1).max(200),
    category: z.string().regex(CATEGORY),
    suggestedCategory: z.string().regex(CATEGORY).optional(),
    confidence: z.number().min(0).max(1).optional(),
    classifier: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    reviewReasons: z.array(z.string().regex(/^[A-Z_]{1,64}$/)).max(20),
    documentMonth: z.string().regex(MONTH).optional(),
    folderPath: z.string().max(400).optional(),
    uploadedByOid: z.string().regex(UUID).optional(),
    contentSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    sizeBytes: z.number().int().min(0).optional(),
    webUrl: z
      .string()
      .max(2000)
      .regex(/^https:\/\/\S+$/)
      .optional(),
    invoice: z
      .object({
        invoiceNumber: z.string().max(100).nullable(),
        issueDate: nullableField(normalizeIsoDate),
        saleDate: nullableField(normalizeIsoDate),
        currency: nullableField(normalizeCurrency),
        netAmount: nullableField(normalizeAmount),
        vatAmount: nullableField(normalizeAmount),
        grossAmount: nullableField(normalizeAmount),
        sellerNip: nullableField(normalizeNip),
        sellerName: z.string().max(300).nullable(),
        buyerNip: nullableField(normalizeNip),
        buyerName: z.string().max(300).nullable(),
        ksefNumber: nullableField(normalizeKsefNumber),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A document row as read back. Amounts are decimal strings; dates `YYYY-MM-DD`. */
export interface DocumentRow {
  readonly documentId: string;
  readonly clientId: string;
  readonly source: DocumentSource;
  readonly driveId: string;
  readonly driveItemId: string;
  readonly status: DocumentStatus;
  readonly category: string;
  readonly suggestedCategory: string | null;
  readonly confidence: string | null;
  readonly classifier: string | null;
  readonly model: string | null;
  readonly reviewReasons: readonly string[];
  /** `YYYY-MM`. */
  readonly documentMonth: string | null;
  readonly folderPath: string | null;
  readonly uploadedByOid: string | null;
  readonly contentSha256: string | null;
  readonly sizeBytes: string | null;
  readonly invoiceNumber: string | null;
  readonly issueDate: string | null;
  readonly saleDate: string | null;
  readonly currency: string | null;
  readonly netAmount: string | null;
  readonly vatAmount: string | null;
  readonly grossAmount: string | null;
  readonly sellerNip: string | null;
  readonly sellerName: string | null;
  readonly buyerNip: string | null;
  readonly buyerName: string | null;
  readonly ksefNumber: string | null;
  /** ISO 8601 UTC with microseconds: the keyset of {@link search}. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What {@link recordFiled} and {@link recordReview} did. */
export interface RecordOutcome {
  /** The row's id: the first document id recorded for this drive item. */
  readonly documentId: string;
  /** `false` when the drive item already had a row, which was updated. */
  readonly created: boolean;
}

/**
 * Records a document filed under its category (`FILED`). Idempotent on
 * (client, drive item): a second call for the same item updates its row and
 * keeps its first `document_id`, so a retried write never duplicates.
 */
export function recordFiled(tx: ClientTx, record: DocumentRecord): Promise<RecordOutcome> {
  return record_(tx, record, 'FILED');
}

/** Records a document sorted to `98_Nieposortowane` for review (`NEEDS_REVIEW`). Idempotent too. */
export function recordReview(tx: ClientTx, record: DocumentRecord): Promise<RecordOutcome> {
  return record_(tx, record, 'NEEDS_REVIEW');
}

async function record_(
  tx: ClientTx,
  input: DocumentRecord,
  status: DocumentStatus,
): Promise<RecordOutcome> {
  assertClientTx(tx);
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new LedgerDbError('invalid_record', `the document record is invalid: ${fields}`);
  }
  const r = parsed.data;
  const inv = r.invoice;
  const rows = await tx.query<{ document_id: string; created: boolean }>(sql`
    INSERT INTO ledger.documents (
      document_id, client_id, source, drive_id, drive_item_id, status, category,
      suggested_category, confidence, classifier, model, review_reasons, document_month,
      folder_path, uploaded_by_oid, content_sha256, size_bytes, invoice_number, issue_date,
      sale_date, currency, net_amount, vat_amount, gross_amount, seller_nip, seller_name,
      buyer_nip, buyer_name, ksef_number, web_url
    ) VALUES (
      ${r.documentId}, ${tx.clientId}, ${r.source}, ${r.driveId}, ${r.driveItemId}, ${status},
      ${r.category}, ${r.suggestedCategory ?? null},
      ${r.confidence === undefined ? null : Math.round(r.confidence * 100) / 100},
      ${r.classifier ?? null}, ${r.model ?? null}, ${[...r.reviewReasons]},
      ${r.documentMonth ? `${r.documentMonth}-01` : null}, ${r.folderPath ?? null},
      ${r.uploadedByOid ?? null}, ${r.contentSha256 ?? null}, ${r.sizeBytes ?? null},
      ${inv?.invoiceNumber ?? null}, ${inv?.issueDate ?? null}, ${inv?.saleDate ?? null},
      ${inv?.currency ?? null}, ${inv?.netAmount ?? null}, ${inv?.vatAmount ?? null},
      ${inv?.grossAmount ?? null}, ${inv?.sellerNip ?? null}, ${inv?.sellerName ?? null},
      ${inv?.buyerNip ?? null}, ${inv?.buyerName ?? null}, ${inv?.ksefNumber ?? null},
      ${r.webUrl ?? null}
    )
    ON CONFLICT (client_id, drive_item_id) DO UPDATE SET
      source = EXCLUDED.source,
      drive_id = EXCLUDED.drive_id,
      status = EXCLUDED.status,
      category = EXCLUDED.category,
      suggested_category = EXCLUDED.suggested_category,
      confidence = EXCLUDED.confidence,
      classifier = EXCLUDED.classifier,
      model = EXCLUDED.model,
      review_reasons = EXCLUDED.review_reasons,
      document_month = EXCLUDED.document_month,
      folder_path = EXCLUDED.folder_path,
      uploaded_by_oid = COALESCE(EXCLUDED.uploaded_by_oid, ledger.documents.uploaded_by_oid),
      content_sha256 = COALESCE(EXCLUDED.content_sha256, ledger.documents.content_sha256),
      size_bytes = COALESCE(EXCLUDED.size_bytes, ledger.documents.size_bytes),
      invoice_number = EXCLUDED.invoice_number,
      issue_date = EXCLUDED.issue_date,
      sale_date = EXCLUDED.sale_date,
      currency = EXCLUDED.currency,
      net_amount = EXCLUDED.net_amount,
      vat_amount = EXCLUDED.vat_amount,
      gross_amount = EXCLUDED.gross_amount,
      seller_nip = EXCLUDED.seller_nip,
      seller_name = EXCLUDED.seller_name,
      buyer_nip = EXCLUDED.buyer_nip,
      buyer_name = EXCLUDED.buyer_name,
      ksef_number = EXCLUDED.ksef_number,
      web_url = COALESCE(EXCLUDED.web_url, ledger.documents.web_url),
      -- Each write for review is one real move into 98_ (a file staff sent
      -- back to the inbox and sorted again, too): announce it again.
      review_notified_at = CASE WHEN EXCLUDED.status = 'NEEDS_REVIEW' THEN NULL
        ELSE ledger.documents.review_notified_at END
    RETURNING document_id::text AS document_id, (xmax = 0) AS created`);
  const row = rows[0];
  if (!row) throw new LedgerDbError('invalid_record', 'the document row was not written');
  return { documentId: row.document_id, created: row.created };
}

/** Every column of {@link DocumentRow}, dates and times as text (never a JS Date). */
const COLUMNS = sql`
  document_id::text AS "documentId", client_id::text AS "clientId", source,
  drive_id AS "driveId", drive_item_id AS "driveItemId", status, category,
  suggested_category AS "suggestedCategory", confidence::text AS confidence, classifier, model,
  review_reasons AS "reviewReasons", to_char(document_month, 'YYYY-MM') AS "documentMonth",
  folder_path AS "folderPath", uploaded_by_oid::text AS "uploadedByOid",
  content_sha256 AS "contentSha256", size_bytes::text AS "sizeBytes",
  invoice_number AS "invoiceNumber", issue_date::text AS "issueDate",
  sale_date::text AS "saleDate", currency::text AS currency, net_amount::text AS "netAmount",
  vat_amount::text AS "vatAmount", gross_amount::text AS "grossAmount",
  seller_nip AS "sellerNip", seller_name AS "sellerName", buyer_nip AS "buyerNip",
  buyer_name AS "buyerName", ksef_number AS "ksefNumber",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"`;

/** The client's row for a drive item, or `null`. */
export async function findByDriveItem(
  tx: ClientTx,
  driveItemId: string,
): Promise<DocumentRow | null> {
  assertClientTx(tx);
  const rows = await tx.query<DocumentRow>(sql`
    SELECT ${COLUMNS} FROM ledger.documents
    WHERE client_id = ${tx.clientId} AND drive_item_id = ${driveItemId}`);
  return rows[0] ?? null;
}

/** A document in review that no notice has named yet: what staff need to find it. */
export interface PendingReviewNotice {
  readonly documentId: string;
  readonly driveItemId: string;
  /** What the classifier suggested, when it named a real category. */
  readonly suggestedCategory: string | null;
  readonly reviewReasons: readonly string[];
  /** `YYYY-MM`. */
  readonly documentMonth: string | null;
  readonly webUrl: string | null;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
}

/** Most documents one call returns: a notice names at most this many per client. */
export const REVIEW_NOTICE_MAX_LIMIT = 50;

/**
 * The client's documents in review (`NEEDS_REVIEW`) that no notice has named
 * yet, oldest first, at most `limit`.
 */
export async function pendingReviewNotices(
  tx: ClientTx,
  limit: number,
): Promise<PendingReviewNotice[]> {
  assertClientTx(tx);
  const n = Math.min(Math.max(Math.trunc(limit), 1), REVIEW_NOTICE_MAX_LIMIT);
  return tx.query<PendingReviewNotice>(sql`
    SELECT document_id::text AS "documentId", drive_item_id AS "driveItemId",
      suggested_category AS "suggestedCategory", review_reasons AS "reviewReasons",
      to_char(document_month, 'YYYY-MM') AS "documentMonth", web_url AS "webUrl",
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM ledger.documents
    WHERE client_id = ${tx.clientId} AND status = 'NEEDS_REVIEW' AND review_notified_at IS NULL
    ORDER BY created_at, document_id
    LIMIT ${n}`);
}

/**
 * Marks the client's documents as named in a notice, after the notice was
 * posted. Only rows still pending are touched: returns how many.
 */
export async function markReviewNotified(
  tx: ClientTx,
  documentIds: readonly string[],
): Promise<number> {
  assertClientTx(tx);
  if (documentIds.length === 0) return 0;
  for (const id of documentIds) {
    if (!UUID.test(id)) throw new LedgerDbError('invalid_record', 'a document id is not a UUID');
  }
  const rows = await tx.query<{ document_id: string }>(sql`
    UPDATE ledger.documents SET review_notified_at = now()
    WHERE client_id = ${tx.clientId} AND document_id = ANY(${[...documentIds]}::uuid[])
      AND review_notified_at IS NULL
    RETURNING document_id::text AS document_id`);
  return rows.length;
}

/** Documents per month and status, newest month first; `month` null: no month read. */
export interface MonthlyCount {
  readonly month: string | null;
  readonly status: DocumentStatus;
  readonly documents: number;
}

/**
 * The example read: how many documents the transaction's client has per month
 * and status. Row-level security already limits it to that client; the
 * explicit `client_id` condition only lets the planner use the index.
 */
export async function monthlyCounts(tx: ClientTx): Promise<MonthlyCount[]> {
  assertClientTx(tx);
  return tx.query<MonthlyCount>(sql`
    SELECT to_char(document_month, 'YYYY-MM') AS month, status, count(*)::int AS documents
    FROM ledger.documents
    WHERE client_id = ${tx.clientId}
    GROUP BY document_month, status
    ORDER BY document_month DESC NULLS LAST, status`);
}

export type { DocumentSearchFilter } from './searchFilter';

export interface SearchPage {
  /** 1–100. Default 25 ({@link search}), 10 ({@link searchClientView}). */
  readonly limit?: number | undefined;
  /** The `nextCursor` of the previous page. */
  readonly after?: string | undefined;
}

export interface SearchResult<R = DocumentRow> {
  readonly items: readonly R[];
  /** Pass as `after` for the next page; `null` on the last page. */
  readonly nextCursor: string | null;
}

export const SEARCH_DEFAULT_LIMIT = 25;
export const SEARCH_MAX_LIMIT = 100;

const CURSOR_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;

/**
 * A cursor's time that PostgreSQL will take: the shape above AND a real
 * instant (no 30 February, month 13, hour 24 or second 60; not year 0000,
 * which JavaScript round-trips and PostgreSQL refuses). Checked before any
 * SQL, so a tampered cursor is `invalid_cursor`, never a database error
 * (22008) that reads as an outage.
 */
function isCursorTime(value: string): boolean {
  if (!CURSOR_TIME.test(value) || value.startsWith('0000')) return false;
  const millis = `${value.slice(0, 23)}Z`;
  const time = Date.parse(millis);
  return !Number.isNaN(time) && new Date(time).toISOString() === millis;
}

/** The keyset of a row: newest first, ties broken by id. */
export function encodeCursor(row: Pick<DocumentRow, 'createdAt' | 'documentId'>): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.documentId]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { readonly createdAt: string; readonly documentId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    !isCursorTime(parsed[0]) ||
    typeof parsed[1] !== 'string' ||
    !UUID.test(parsed[1])
  ) {
    throw new LedgerDbError('invalid_cursor', 'the search cursor is not one this index issued');
  }
  return { createdAt: parsed[0], documentId: parsed[1] };
}

/** One page of `columns` from the documents matching `filter`: the pager of every search read. */
async function searchPage<R extends Pick<DocumentRow, 'createdAt' | 'documentId'>>(
  tx: ClientTx,
  filter: DocumentSearchFilter,
  page: SearchPage,
  columns: Sql,
  defaultLimit: number,
): Promise<SearchResult<R>> {
  assertClientTx(tx);
  const conditions = filterConditions(tx, parseSearchFilter(filter));
  const limit = page.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new LedgerDbError('invalid_filter', 'the search filter is invalid: limit');
  }
  if (page.after !== undefined) {
    const after = decodeCursor(page.after);
    conditions.push(
      sql`(created_at, document_id) < (${after.createdAt}::timestamptz, ${after.documentId}::uuid)`,
    );
  }
  const rows = await tx.query<R>(sql`
    SELECT ${columns} FROM ledger.documents
    WHERE ${joinSql(conditions, sql` AND `)}
    ORDER BY created_at DESC, document_id DESC
    LIMIT ${limit + 1}`);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/**
 * The transaction's client's documents matching `filter`, newest first, one
 * page at a time (keyset paging on `created_at`, `document_id`: stable while
 * rows are added, and no OFFSET scans), every column: for staff and the
 * index's own tools, never for a client (that is {@link searchClientView}).
 * Every value reaches SQL as a parameter; the conditions are fixed fragments.
 */
export function search(
  tx: ClientTx,
  filter: DocumentSearchFilter,
  page: SearchPage = {},
): Promise<SearchResult> {
  return searchPage<DocumentRow>(tx, filter, page, COLUMNS, SEARCH_DEFAULT_LIMIT);
}

/**
 * A document as its client may see it: the client-view columns only. Never
 * who uploaded it, the bytes' hash, drive ids, the folder, the classifier, its
 * model, confidence, suggestion or review reasons. `status` is the index's
 * (`FILED` | `NEEDS_REVIEW`); `webUrl` is the stored link, unchecked here (the
 * caller keeps it only on the client's own site).
 */
export interface ClientViewRow {
  readonly documentId: string;
  readonly status: DocumentStatus;
  readonly category: string;
  /** `YYYY-MM`. */
  readonly documentMonth: string | null;
  readonly invoiceNumber: string | null;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string | null;
  readonly currency: string | null;
  /** A decimal string. */
  readonly grossAmount: string | null;
  readonly sellerNip: string | null;
  readonly sellerName: string | null;
  readonly buyerNip: string | null;
  readonly buyerName: string | null;
  readonly webUrl: string | null;
  /** ISO 8601 UTC with microseconds: the keyset of the paging. */
  readonly createdAt: string;
}

/** The fields of {@link ClientViewRow}, in the order selected: all a client's search reads. */
export const CLIENT_VIEW_FIELDS = [
  'documentId',
  'status',
  'category',
  'documentMonth',
  'invoiceNumber',
  'issueDate',
  'currency',
  'grossAmount',
  'sellerNip',
  'sellerName',
  'buyerNip',
  'buyerName',
  'webUrl',
  'createdAt',
] as const satisfies readonly (keyof ClientViewRow)[];

/** Exactly {@link CLIENT_VIEW_FIELDS}, selected in SQL: nothing else leaves the database. */
const CLIENT_VIEW_COLUMNS = sql`
  document_id::text AS "documentId", status, category,
  to_char(document_month, 'YYYY-MM') AS "documentMonth", invoice_number AS "invoiceNumber",
  issue_date::text AS "issueDate", currency::text AS currency,
  gross_amount::text AS "grossAmount", seller_nip AS "sellerNip", seller_name AS "sellerName",
  buyer_nip AS "buyerNip", buyer_name AS "buyerName", web_url AS "webUrl",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

/**
 * A client's search: {@link search}'s filter and paging, but only the
 * client-view columns ({@link ClientViewRow}), selected in SQL. A page is 10
 * by default (`SEARCH_PAGE_SIZE`). Run it in a read-only transaction
 * (`withClientTx(…, { readOnly: true })`).
 */
export function searchClientView(
  tx: ClientTx,
  filter: DocumentSearchFilter,
  page: SearchPage = {},
): Promise<SearchResult<ClientViewRow>> {
  return searchPage<ClientViewRow>(tx, filter, page, CLIENT_VIEW_COLUMNS, SEARCH_PAGE_SIZE);
}

/** How many documents match, counted up to a cap. */
export interface MatchCount {
  /** The matches, at most the cap. */
  readonly total: number;
  /** More than the cap match ("ponad 500"). */
  readonly capped: boolean;
}

/** The highest cap {@link countMatching} takes. */
export const COUNT_MAX_CAP = 10_000;

/**
 * How many of the transaction's client's documents match `filter` (the same
 * conditions as {@link searchClientView}), counting no further than `cap` + 1
 * rows, so a broad filter costs no more than `cap` does.
 */
export async function countMatching(
  tx: ClientTx,
  filter: DocumentSearchFilter,
  cap: number = SEARCH_TOTAL_CAP,
): Promise<MatchCount> {
  assertClientTx(tx);
  const conditions = filterConditions(tx, parseSearchFilter(filter));
  if (!Number.isInteger(cap) || cap < 1 || cap > COUNT_MAX_CAP) {
    throw new LedgerDbError('invalid_filter', 'the search filter is invalid: cap');
  }
  const rows = await tx.query<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM ledger.documents
      WHERE ${joinSql(conditions, sql` AND `)}
      LIMIT ${cap + 1}
    ) AS matching`);
  const n = rows[0]?.n ?? 0;
  return { total: Math.min(n, cap), capped: n > cap };
}
