import type { ClientViewRow } from '@bcr/ledger-db';
import {
  canonicalSitePath,
  clientSearchFilterSchema,
  FALLBACK_CATEGORY,
  isDocumentCategory,
  normalizeAmount,
  normalizeCurrency,
  normalizeNip,
  normalizeText,
  undoLinkDefang,
  SEARCH_MAX_TEXT_CHARS,
  type ClientSearchFilter,
  type SearchNote,
  type SearchResultItem,
  type SharePointTarget,
} from '@bcr/shared';
import type { SearchInterpretation } from './searchInterpreter';
import { resolvePeriod } from './searchPeriod';

/**
 * Client search's pure half: a question as the service reads it, the model's
 * interpretation turned into a filter, and an index row turned into what a
 * client may see. Nothing here reads the Directory, the index or the model.
 */

/** Invisible characters that can reorder or hide text (bidi controls, zero-width, BOM). */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A question as it is sent to the model and as its free strings are checked
 * against: NFC, a result card's link look-alikes back to `.`, `@` and `:`
 * (`undoLinkDefang`: a name copied from a card), bidi and zero-width
 * characters removed, control characters
 * and runs of whitespace one space, trimmed. The bot does the same; this is
 * the second check, since the question is the asker's input.
 */
export function normalizeSearchQuestion(text: string): string {
  return undoLinkDefang(text.normalize('NFC'))
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SearchFilterResult =
  | {
      readonly ok: true;
      readonly filter: ClientSearchFilter;
      /** What part of the question did not become a filter, for the card's fixed notes. */
      readonly notes: readonly SearchNote[];
    }
  /** The interpretation cannot be a filter: the question was not understood. `reason` is a code. */
  | { readonly ok: false; readonly reason: string };

/**
 * Digit runs of the question, separators inside a number dropped: `NIP
 * 123-456-78-19` holds `1234567819`.
 */
export function digitRuns(question: string): string[] {
  return (question.match(/\d(?:[\d -]*\d)?/g) ?? []).map((run) => run.replace(/[ -]/g, ''));
}

/** A free string the model copied, kept only when the question holds it (any case). */
function copiedFromQuestion(value: string | null, question: string): string | null | undefined {
  if (value === null) return undefined;
  const text = normalizeText(normalizeSearchQuestion(value), SEARCH_MAX_TEXT_CHARS);
  if (text === null) return null;
  return question.toLowerCase().includes(text.toLowerCase()) ? text : null;
}

/**
 * The filter a question becomes (pure). The interpretation is only a
 * suggestion, and every value in it is checked here:
 *
 *  - the period is resolved in code, against the calendar in Warsaw at `now`
 *    (`searchPeriod.ts`); one it cannot read is `ok: false`; one it had to cut
 *    adds the note `period_clamped`;
 *  - amounts go through `normalizeAmount` and must not be negative (else
 *    `ok: false`); a minimum above the maximum is turned round; a currency must
 *    be an ISO 4217 code (else `ok: false`);
 *  - a NIP must pass `normalizeNip` (the checksum) AND its digits must occur in
 *    the question, else it is dropped with `nip_dropped`;
 *  - a counterparty name and an invoice number must be 1–60 characters and
 *    occur in the (normalised) question, any case, else they are dropped with
 *    their note: the model can never search for a name the asker did not
 *    write, such as another client's;
 *  - the result is checked against the shared `clientSearchFilterSchema`.
 *
 * Nothing in it can name a client: the worst a misreading can do is search
 * the asker's own documents for something else. An empty filter means the
 * newest documents.
 */
export function toSearchFilter(
  interp: SearchInterpretation,
  question: string,
  now: Date,
): SearchFilterResult {
  const q = normalizeSearchQuestion(question);
  const notes: SearchNote[] = [];
  const filter: ClientSearchFilter = {};

  const categories = [...new Set(interp.categories ?? [])];
  if (categories.length > 0) filter.categories = categories;

  if (interp.period) {
    const period = resolvePeriod(interp.period, now);
    if (!period.ok) return { ok: false, reason: `period_${period.reason}` };
    if (period.monthFrom) filter.monthFrom = period.monthFrom;
    if (period.monthTo) filter.monthTo = period.monthTo;
    if (period.clamped) notes.push('period_clamped');
  }

  if (interp.amount) {
    const bounds: (string | undefined)[] = [];
    for (const raw of [interp.amount.min, interp.amount.max]) {
      if (raw === null) {
        bounds.push(undefined);
        continue;
      }
      const amount = normalizeAmount(raw);
      if (amount === null || amount.startsWith('-')) return { ok: false, reason: 'amount' };
      bounds.push(amount);
    }
    let [min, max] = bounds;
    if (min !== undefined && max !== undefined && Number(min) > Number(max))
      [min, max] = [max, min];
    if (min !== undefined) filter.grossMin = min;
    if (max !== undefined) filter.grossMax = max;
  }

  if (interp.currency !== null) {
    const currency = normalizeCurrency(interp.currency);
    if (currency === null) return { ok: false, reason: 'currency' };
    filter.currency = currency;
  }

  const nipAsked = interp.counterparty?.nip ?? null;
  if (nipAsked !== null) {
    const nip = normalizeNip(nipAsked);
    if (nip !== null && digitRuns(q).some((run) => run.includes(nip))) filter.counterpartyNip = nip;
    else notes.push('nip_dropped');
  }

  const name = copiedFromQuestion(interp.counterparty?.name ?? null, q);
  if (name) filter.counterpartyName = name;
  else if (name === null) notes.push('counterparty_name_dropped');

  const invoiceNumber = copiedFromQuestion(interp.invoice_number, q);
  if (invoiceNumber) filter.invoiceNumber = invoiceNumber;
  else if (invoiceNumber === null) notes.push('invoice_number_dropped');

  if (interp.status !== null) filter.status = interp.status;

  const checked = clientSearchFilterSchema.safeParse(filter);
  if (!checked.success) return { ok: false, reason: 'filter' };
  const review = withoutReviewCategories(checked.data);
  return { ok: true, filter: review.filter, notes: [...notes, ...review.notes] };
}

/**
 * A document in review has no category yet: its index row's category is
 * `nieposortowane` (the model's suggestion is kept apart and never matched,
 * since it is never shown). So `status: in_review` with categories could
 * only ever find nothing: the categories are dropped, with the note
 * `categories_in_review` unless they named `nieposortowane` alone. For a
 * question and for the card's form alike.
 */
export function withoutReviewCategories(filter: ClientSearchFilter): {
  readonly filter: ClientSearchFilter;
  readonly notes: readonly SearchNote[];
} {
  if (filter.status !== 'in_review' || !filter.categories) return { filter, notes: [] };
  const { categories, ...rest } = filter;
  const onlyUnsorted = categories.every((c) => c === FALLBACK_CATEGORY);
  return { filter: rest, notes: onlyUnsorted ? [] : ['categories_in_review'] };
}

// ---------------------------------------------------------------------------
// Rows to results
// ---------------------------------------------------------------------------

/** The longest link kept; the bot drops longer ones too. */
export const MAX_WEB_URL_CHARS = 2048;

/**
 * The document's link, only when it is plainly on the client's own site:
 * https, no user info or port, the host of the row's target, and a path under
 * the row's canonical site path (`/sites/<name>/…`, compared lower-case after
 * the URL parser has resolved `.`/`..`). Anything else is `null`, shown as
 * „Link niedostępny”: a stale link can 404, but it never points at another
 * client's site.
 */
export function guardedWebUrl(url: string | null, target: SharePointTarget): string | null {
  if (url === null || url.length > MAX_WEB_URL_CHARS) return null;
  const site = canonicalSitePath(target.sitePath);
  if (site === null || target.siteHostname.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.port !== '') return null;
  if (parsed.hostname.toLowerCase() !== target.siteHostname.trim().toLowerCase()) return null;
  if (!parsed.pathname.toLowerCase().startsWith(`${site.toLowerCase()}/`)) return null;
  return parsed.href;
}

/**
 * The other party of a document. A sale's is its buyer, a purchase's its
 * seller; for any other category, the side that is not the client's own NIP
 * (the seller when neither is). Never the client itself: a side carrying the
 * client's own NIP is never shown as the counterparty.
 */
export function counterpartyOf(
  row: Pick<ClientViewRow, 'category' | 'sellerNip' | 'sellerName' | 'buyerNip' | 'buyerName'>,
  clientNip: string,
): { readonly name: string | null; readonly nip: string | null } {
  const own = normalizeNip(clientNip);
  const isOwn = (nip: string | null) => own !== null && nip === own;
  let side: 'seller' | 'buyer';
  if (row.category === 'faktury_sprzedazy') side = 'buyer';
  else if (row.category === 'faktury_zakupu') side = 'seller';
  else side = isOwn(row.sellerNip) ? 'buyer' : 'seller';
  if (side === 'seller' && isOwn(row.sellerNip)) side = 'buyer';
  else if (side === 'buyer' && isOwn(row.buyerNip)) side = 'seller';
  const nip = side === 'seller' ? row.sellerNip : row.buyerNip;
  if (isOwn(nip)) return { name: null, nip: null };
  return { name: side === 'seller' ? row.sellerName : row.buyerName, nip };
}

/** The bound Directory row a search ran for, as far as mapping its results needs it. */
export interface SearchOwner {
  /** The row's own NIP: which side of an invoice is the client. May be empty. */
  readonly nip: string;
  /** The row's target: links are kept only on its site. */
  readonly target: SharePointTarget;
}

/**
 * One index row as the client may see it: the allowed fields, built one by
 * one (nothing else of the row is carried over, whatever the row holds), the
 * status in the contract's words, the counterparty and a guarded link. `null`
 * for a row whose category the taxonomy does not know.
 */
export function toResultItem(row: ClientViewRow, owner: SearchOwner): SearchResultItem | null {
  if (!isDocumentCategory(row.category)) return null;
  const counterparty = counterpartyOf(row, owner.nip);
  return {
    documentId: row.documentId,
    status: row.status === 'NEEDS_REVIEW' ? 'in_review' : 'filed',
    category: row.category,
    documentMonth: row.documentMonth,
    invoiceNumber: row.invoiceNumber,
    issueDate: row.issueDate,
    grossAmount: row.grossAmount,
    currency: row.currency,
    counterpartyName: counterparty.name,
    counterpartyNip: counterparty.nip,
    webUrl: guardedWebUrl(row.webUrl, owner.target),
  };
}
