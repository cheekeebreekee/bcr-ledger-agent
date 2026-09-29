import { z } from 'zod';
import { categoryCatalog, type DocumentCategory } from '../parsers/folderTaxonomy';

/**
 * Client search: the contract between the bot and ingestion's `POST
 * /api/search` (design: docs/operations/human-steps.md "Client search
 * release", CLAUDE.md "Client search").
 *
 * The asker is `source.userAadObjectId`, the Bot-Framework-authenticated
 * user the bot's gate passed; ingestion resolves their client exactly as it
 * routes their uploads, and only a row's `{NIP}@bcr-group.pl` client account
 * may search. Nothing in a request can name a client, a scope, a row, a limit
 * or a column: every schema here is `.strict()`, so such a key is a 400,
 * never ignored.
 */

/** Results per page. */
export const SEARCH_PAGE_SIZE = 10;
/** Longest question accepted, after normalisation. */
export const SEARCH_MAX_QUESTION_CHARS = 300;
/** Matches counted at most; above it the card says "ponad 500". */
export const SEARCH_TOTAL_CAP = 500;
/** Longest paging cursor accepted. */
export const SEARCH_CURSOR_MAX_CHARS = 256;
/** Longest counterparty name or invoice number searched for. */
export const SEARCH_MAX_TEXT_CHARS = 60;

const CATEGORY_IDS = categoryCatalog.map((c) => c.id) as [DocumentCategory, ...DocumentCategory[]];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A normalised non-negative amount: digits, optional two decimals (`normalizeAmount`'s form). */
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A typed search over one client's documents: what the model read from the
 * question, or what the card's "Zmień filtr" form sent. Every field narrows;
 * none can widen past the asker's own client, which is fixed before any read.
 * An empty filter means the newest documents.
 */
export const clientSearchFilterSchema = z
  .object({
    categories: z.array(z.enum(CATEGORY_IDS)).min(1).max(CATEGORY_IDS.length).optional(),
    /** `YYYY-MM`, inclusive. */
    monthFrom: z.string().regex(MONTH).optional(),
    monthTo: z.string().regex(MONTH).optional(),
    /** Gross amount bounds, inclusive, as normalised decimal strings. */
    grossMin: z.string().regex(AMOUNT).optional(),
    grossMax: z.string().regex(AMOUNT).optional(),
    /** ISO 4217. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** Ten digits, checksum-valid (`normalizeNip`); seller or buyer side. */
    counterpartyNip: z
      .string()
      .regex(/^\d{10}$/)
      .optional(),
    /** A part of the seller's or buyer's name, matched literally, case-insensitively. */
    counterpartyName: z.string().trim().min(1).max(SEARCH_MAX_TEXT_CHARS).optional(),
    /** The invoice number, matched case-insensitively, trimmed. */
    invoiceNumber: z.string().trim().min(1).max(SEARCH_MAX_TEXT_CHARS).optional(),
    /** `in_review`: sorted to 98_ for review; `filed`: in its category. */
    status: z.enum(['in_review', 'filed']).optional(),
  })
  .strict()
  .refine((f) => !(f.monthFrom && f.monthTo) || f.monthFrom <= f.monthTo, {
    message: 'monthFrom is after monthTo',
    path: ['monthFrom'],
  })
  .refine(
    (f) =>
      f.grossMin === undefined ||
      f.grossMax === undefined ||
      Number(f.grossMin) <= Number(f.grossMax),
    { message: 'grossMin is above grossMax', path: ['grossMin'] },
  );
export type ClientSearchFilter = z.infer<typeof clientSearchFilterSchema>;

/** The asker, as the bot's gate saw them: the same shape uploads carry. */
const searchSourceSchema = z
  .object({
    tenantId: z.string().min(1),
    conversationId: z.string().min(1).max(500),
    activityId: z.string().min(1).max(500),
    conversationType: z.literal('personal'),
    userAadObjectId: z.string().regex(GUID, 'userAadObjectId must be a GUID'),
  })
  .strict();

/** What the bot sends to `POST /api/search`. */
export const searchRequestSchema = z
  .object({
    source: searchSourceSchema,
    query: z.discriminatedUnion('kind', [
      /** A question in the client's words: the model turns it into a filter. */
      z
        .object({
          kind: z.literal('question'),
          text: z.string().min(1).max(SEARCH_MAX_QUESTION_CHARS),
        })
        .strict(),
      /** A typed filter from our own card (paging, "Zmień filtr"): no model call. */
      z
        .object({
          kind: z.literal('typed'),
          filter: clientSearchFilterSchema,
          after: z.string().min(1).max(SEARCH_CURSOR_MAX_CHARS).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type SearchRequestPayload = z.infer<typeof searchRequestSchema>;

/**
 * One document as a client may see it: the client-view columns only (never
 * who uploaded it, a hash, drive ids, the model, its confidence or its
 * suggestion). `webUrl` is set only when it is an https link on the client's
 * own site.
 */
export interface SearchResultItem {
  readonly documentId: string;
  readonly status: 'filed' | 'in_review';
  readonly category: DocumentCategory;
  /** `YYYY-MM`. */
  readonly documentMonth: string | null;
  readonly invoiceNumber: string | null;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string | null;
  /** A decimal string, never a float. */
  readonly grossAmount: string | null;
  readonly currency: string | null;
  /** The other party of an invoice (the buyer of a sale, the seller of a purchase). */
  readonly counterpartyName: string | null;
  readonly counterpartyNip: string | null;
  readonly webUrl: string | null;
}

/**
 * Why part of a question or form did not become the filter that ran (shown as
 * a fixed Polish note). `categories_in_review`: a document in review has no
 * category yet, so the categories asked for were not applied.
 */
export type SearchNote =
  | 'counterparty_name_dropped'
  | 'invoice_number_dropped'
  | 'nip_dropped'
  | 'period_clamped'
  | 'categories_in_review';

/** Everything `POST /api/search` answers with (HTTP 200); errors keep the house 4xx/5xx shape. */
export type SearchResponsePayload =
  | {
      readonly status: 'ok';
      /** The Directory row's title: which client these results are for. */
      readonly scopeLabel: string;
      /** The filter that ran, so the card can say what it understood. */
      readonly filter: ClientSearchFilter;
      /** Matches, counted up to {@link SEARCH_TOTAL_CAP}. */
      readonly total: number;
      readonly totalCapped: boolean;
      readonly items: readonly SearchResultItem[];
      /** Pass as `after` with the same filter for the next page; `null` on the last. */
      readonly nextCursor: string | null;
      readonly notes: readonly SearchNote[];
    }
  /** The question was a greeting or a request for help. */
  | { readonly status: 'help' }
  /** The question could not become a filter (`unclear`), or asks what search does not do. */
  | { readonly status: 'not_understood'; readonly reason: 'unclear' | 'unsupported' }
  /** The asker is not the client account of exactly one client. One answer for every reason. */
  | { readonly status: 'no_access' }
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  /** The model or the index cannot answer now; the typed form may still work. */
  | { readonly status: 'unavailable' }
  /** Search is off, or not open to this client yet. */
  | { readonly status: 'disabled' };
