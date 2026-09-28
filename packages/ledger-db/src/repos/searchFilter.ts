import {
  SEARCH_MAX_TEXT_CHARS,
  normalizeAmount,
  normalizeCurrency,
  normalizeNip,
  normalizeText,
} from '@bcr/shared';
import { z } from 'zod';
import { LedgerDbError } from '../errors';
import { sql, type Sql } from '../sql';
import type { ClientTx } from '../tx';

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const CATEGORY = /^[a-z_]{1,64}$/;
/** More than the taxonomy has: a list this long is not a filter. */
const MAX_CATEGORIES = 32;

/**
 * A search of one client's documents. No field names a client or a limit: the
 * client is the transaction's, the page size is the page's. The shared
 * `ClientSearchFilter` (what a client's search sends, @bcr/shared) is one:
 * every field of it is here with the same meaning, and the index checks it
 * again before any statement is built.
 */
export interface DocumentSearchFilter {
  /** The category filed under (`nieposortowane` finds the review pile). */
  readonly category?: string | undefined;
  /** Any of these categories. */
  readonly categories?: readonly string[] | undefined;
  /** `in_review`: sorted to review (`NEEDS_REVIEW`); `filed`: in its category (`FILED`). */
  readonly status?: 'in_review' | 'filed' | undefined;
  /** `YYYY-MM`, inclusive. */
  readonly monthFrom?: string | undefined;
  readonly monthTo?: string | undefined;
  /** Gross amount bounds, inclusive: a number or a decimal string. */
  readonly grossMin?: string | number | undefined;
  readonly grossMax?: string | number | undefined;
  /** ISO 4217. */
  readonly currency?: string | undefined;
  /** A NIP on either side of the invoice. */
  readonly counterpartyNip?: string | undefined;
  /** A part of the seller's or the buyer's name: literal, case-insensitive. */
  readonly counterpartyName?: string | undefined;
  /** The whole invoice number: case-insensitive, trimmed. */
  readonly invoiceNumber?: string | undefined;
}

/** The name of a field of {@link DocumentSearchFilter}. */
export type SearchFilterField = keyof DocumentSearchFilter;

/** Every field of the filter, and nothing else: the compiler holds this list to the interface. */
const FIELD_NAMES = {
  categories: true,
  category: true,
  counterpartyName: true,
  counterpartyNip: true,
  currency: true,
  grossMax: true,
  grossMin: true,
  invoiceNumber: true,
  monthFrom: true,
  monthTo: true,
  status: true,
} as const satisfies Record<SearchFilterField, true>;

/**
 * The filter's field names, sorted: all a `search_queries` row may say about
 * a filter besides its hash (migration 0003's CHECK lists the same names).
 */
export const SEARCH_FILTER_FIELDS = Object.keys(FIELD_NAMES).sort() as [
  SearchFilterField,
  ...SearchFilterField[],
];

/** A value the shared normaliser keeps, in its normalised form; anything else is an issue. */
const normalised = (normalise: (value: string) => string | null) =>
  z.string().transform((v, ctx) => normalise(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER));

const amountFilter = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => normalizeAmount(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER));

const searchText = normalised((v) => normalizeText(v, SEARCH_MAX_TEXT_CHARS));

const filterSchema = z
  .object({
    category: z.string().regex(CATEGORY).optional(),
    categories: z.array(z.string().regex(CATEGORY)).min(1).max(MAX_CATEGORIES).optional(),
    status: z.enum(['in_review', 'filed']).optional(),
    monthFrom: z.string().regex(MONTH).optional(),
    monthTo: z.string().regex(MONTH).optional(),
    grossMin: amountFilter.optional(),
    grossMax: amountFilter.optional(),
    currency: normalised(normalizeCurrency).optional(),
    counterpartyNip: normalised(normalizeNip).optional(),
    counterpartyName: searchText.optional(),
    invoiceNumber: searchText.optional(),
  })
  .strict();

/** A filter as the index checked it: NIP, amounts, currency and texts in normalised form. */
export type ParsedSearchFilter = z.output<typeof filterSchema>;

/**
 * Checks and normalises a filter. Throws `invalid_filter` naming the fields,
 * never their values; an unknown key (a client, a limit) is refused, not ignored.
 */
export function parseSearchFilter(filter: DocumentSearchFilter): ParsedSearchFilter {
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new LedgerDbError('invalid_filter', `the search filter is invalid: ${fields}`);
  }
  return parsed.data;
}

/**
 * THE condition builder of every search read (`search`, `searchClientView`,
 * `countMatching`): the transaction's client first, always — row-level
 * security scopes the statement anyway; this condition is the second lock,
 * and what lets the planner use the per-client indexes — then one fixed
 * fragment per field set. Every value is a bind parameter. The name matches
 * with `strpos`, never LIKE: `%` and `_` in a name are characters, not
 * wildcards.
 */
export function filterConditions(tx: ClientTx, f: ParsedSearchFilter): Sql[] {
  const conditions: Sql[] = [sql`client_id = ${tx.clientId}`];
  if (f.category) conditions.push(sql`category = ${f.category}`);
  if (f.monthFrom) conditions.push(sql`document_month >= ${`${f.monthFrom}-01`}::date`);
  if (f.monthTo) conditions.push(sql`document_month <= ${`${f.monthTo}-01`}::date`);
  if (f.grossMin !== undefined) conditions.push(sql`gross_amount >= ${f.grossMin}::numeric`);
  if (f.grossMax !== undefined) conditions.push(sql`gross_amount <= ${f.grossMax}::numeric`);
  if (f.counterpartyNip) {
    conditions.push(sql`(seller_nip = ${f.counterpartyNip} OR buyer_nip = ${f.counterpartyNip})`);
  }
  if (f.categories) {
    conditions.push(sql`category = ANY(${[...new Set(f.categories)]}::text[])`);
  }
  if (f.status) {
    conditions.push(sql`status = ${f.status === 'in_review' ? 'NEEDS_REVIEW' : 'FILED'}`);
  }
  if (f.currency) conditions.push(sql`currency = ${f.currency}`);
  if (f.counterpartyName) {
    conditions.push(
      sql`(strpos(lower(seller_name), lower(${f.counterpartyName}::text)) > 0 OR strpos(lower(buyer_name), lower(${f.counterpartyName}::text)) > 0)`,
    );
  }
  if (f.invoiceNumber) {
    conditions.push(sql`lower(btrim(invoice_number)) = lower(${f.invoiceNumber}::text)`);
  }
  return conditions;
}
