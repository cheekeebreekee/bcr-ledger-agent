import {
  type ClientSearchFilter,
  clientSearchFilterSchema,
  isDocumentCategory,
  normalizeAmount,
  normalizeCurrency,
  normalizeNip,
  SEARCH_CURSOR_MAX_CHARS,
  SEARCH_MAX_TEXT_CHARS,
  undoLinkDefang,
} from '@bcr/shared';

/**
 * What a guest sends to search, read before anything is called: the question
 * they typed, or the value of one of our own card buttons. SDK-agnostic on
 * purpose, like the gate: it reads strings and plain objects only.
 *
 * Nothing here decides whose documents are searched. A card value can carry
 * a filter and a cursor, nothing else is read from it, and ingestion
 * re-validates both inside the asker's own scope.
 */

/** The card actions search understands; `v` versions the shape. */
export const SEARCH_ACTION_VERSION = 1;
export const SEARCH_PAGE_ACTION = 'bcr.search.page';
export const SEARCH_FILTER_ACTION = 'bcr.search.filter';

/** Input ids of the „Zmień filtr” form; Teams merges them into the submit value. */
export const SEARCH_FORM_INPUTS = {
  categories: 'bcrCategories',
  monthFrom: 'bcrMonthFrom',
  monthTo: 'bcrMonthTo',
  grossMin: 'bcrGrossMin',
  grossMax: 'bcrGrossMax',
  currency: 'bcrCurrency',
  counterpartyNip: 'bcrNip',
  counterpartyName: 'bcrCounterpartyName',
  invoiceNumber: 'bcrInvoiceNumber',
  status: 'bcrStatus',
} as const;

/** The status choice meaning "no status filter". */
export const SEARCH_STATUS_ANY = 'all';

/** The first result on a page is at most this far down (display only). */
const MAX_START = 100_000;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TAG = /<\/?[a-zA-Z][^<>]*>/g;
const MENTION = /<at\b[^>]*>[\s\S]*?<\/at>/gi;
const ENTITY = /&(amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[0-9a-f]{1,6});/gi;
/** C0/C1 controls (tabs and newlines too) and line/paragraph separators: become a space. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/**
 * Invisible format characters: soft hyphen, Arabic letter mark, Mongolian
 * vowel separator, zero-width space/joiners, LRM/RLM, bidi embeddings and
 * overrides, word joiner and invisible operators, bidi isolates, BOM.
 * Removed, so `fak<ZWSP>tura` is `faktura`.
 */
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A guest's message as a search question: the bot's mention and any HTML
 * tags dropped, the common entities decoded (once), NFC, control characters
 * turned into spaces, invisible and bidi characters removed, whitespace
 * collapsed and trimmed. The caller checks the length (1–300) afterwards.
 */
export function normalizeQuestion(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '';
  return cleanText(raw.replace(MENTION, ' ').replace(TAG, ' ').replace(ENTITY, decodeEntity));
}

/** A request for the help card: „pomoc”, „help”, „menu” or „?”. */
export function isHelpKeyword(question: string): boolean {
  const word = question
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim();
  return word === 'pomoc' || word === 'help' || word === 'menu' || word === '?';
}

export type SearchAction =
  /** Not one of our card actions: the message is read as text. */
  | { readonly kind: 'none' }
  /** One of ours, but its filter or cursor is not usable. */
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'typed';
      readonly filter: ClientSearchFilter;
      readonly after?: string;
      /** 1-based position of the first result this request shows (display only). */
      readonly start: number;
    };

/**
 * Reads `activity.value` of a card submit. Only `{v: 1, action}` values of
 * ours are actions; for them only the filter (paging) or the form's inputs
 * („Zmień filtr”), the cursor and a display position are read. Any other key
 * — a client id, a scope, a limit — is never read, so never forwarded.
 */
export function parseSearchAction(value: unknown): SearchAction {
  if (!isRecord(value) || value.v !== SEARCH_ACTION_VERSION) return { kind: 'none' };

  if (value.action === SEARCH_PAGE_ACTION) {
    const filter = clientSearchFilterSchema.safeParse(value.filter);
    const after = value.after;
    if (
      !filter.success ||
      typeof after !== 'string' ||
      after.length === 0 ||
      after.length > SEARCH_CURSOR_MAX_CHARS
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'typed', filter: filter.data, after, start: displayStart(value.start) };
  }

  if (value.action === SEARCH_FILTER_ACTION) {
    const filter = filterFromForm(value);
    return filter ? { kind: 'typed', filter, start: 1 } : { kind: 'invalid' };
  }

  return { kind: 'none' };
}

/**
 * The „Zmień filtr” form's inputs as a filter, or `null` when any input is
 * not a usable value. An empty input leaves its field out. The result is
 * checked by the shared schema (month and amount order included).
 */
export function filterFromForm(
  value: Readonly<Record<string, unknown>>,
): ClientSearchFilter | null {
  const inputs = SEARCH_FORM_INPUTS;
  // `undefined` from a converter: leave the field out; `null`: the input is unusable.
  const fields: readonly [keyof ClientSearchFilter, string, (v: string) => unknown][] = [
    ['categories', inputs.categories, formCategories],
    ['monthFrom', inputs.monthFrom, (v) => (MONTH.test(v) ? v : null)],
    ['monthTo', inputs.monthTo, (v) => (MONTH.test(v) ? v : null)],
    ['grossMin', inputs.grossMin, formAmount],
    ['grossMax', inputs.grossMax, formAmount],
    ['currency', inputs.currency, normalizeCurrency],
    ['counterpartyNip', inputs.counterpartyNip, normalizeNip],
    ['counterpartyName', inputs.counterpartyName, formText],
    ['invoiceNumber', inputs.invoiceNumber, formText],
    ['status', inputs.status, formStatus],
  ];

  const draft: Record<string, unknown> = {};
  for (const [field, id, convert] of fields) {
    const raw = value[id];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return null;
    const cleaned = cleanText(raw);
    if (cleaned === '') continue;
    const converted = convert(cleaned);
    if (converted === null) return null;
    if (converted !== undefined) draft[field] = converted;
  }
  const parsed = clientSearchFilterSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
}

function formCategories(v: string): string[] | null {
  const ids = [...new Set(v.split(',').map((s) => s.trim()))].filter((s) => s !== '');
  return ids.length > 0 && ids.every(isDocumentCategory) ? ids : null;
}

function formStatus(v: string): string | null | undefined {
  if (v === SEARCH_STATUS_ANY) return undefined;
  return v === 'in_review' || v === 'filed' ? v : null;
}

/** A non-negative amount as typed (`1 500,00`, `1500.5`), normalised; else `null`. */
function formAmount(v: string): string | null {
  const amount = normalizeAmount(v);
  return amount === null || amount.startsWith('-') ? null : amount;
}

function formText(v: string): string | null {
  return v.length <= SEARCH_MAX_TEXT_CHARS ? v : null;
}

function displayStart(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_START ? raw : 1;
}

/** NFC, and a value copied from a result card back to its own characters (`undoLinkDefang`). */
function cleanText(text: string): string {
  return undoLinkDefang(text.normalize('NFC'))
    .replace(CONTROLS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntity(_match: string, name: string): string {
  const named = NAMED_ENTITIES[name.toLowerCase()];
  if (named !== undefined) return named;
  const code =
    name[1] === 'x' || name[1] === 'X'
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return valid ? String.fromCodePoint(code) : ' ';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
