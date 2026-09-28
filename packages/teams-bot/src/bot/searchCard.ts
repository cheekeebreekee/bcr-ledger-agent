import {
  categoryCatalog,
  type ClientSearchFilter,
  defangLinks,
  getCategory,
  SEARCH_PAGE_SIZE,
  type SearchResponsePayload,
  type SearchResultItem,
} from '@bcr/shared';
import {
  MONTHS_GENITIVE,
  MONTHS_NOMINATIVE,
  SEARCH_CARD_TEXT,
  SEARCH_COVERAGE_TEXT,
  SEARCH_EMPTY_TEXT,
  SEARCH_EVERYTHING_TEXT,
  SEARCH_IN_REVIEW_LABEL,
  SEARCH_LINK_UNAVAILABLE_TEXT,
  SEARCH_NOT_UNDERSTOOD_TEXT,
  SEARCH_NO_ACCESS_TEXT,
  SEARCH_NOTE_TEXT,
  SEARCH_RESULTS_HEADING,
  SEARCH_UNAVAILABLE_QUESTION_TEXT,
  SEARCH_UNAVAILABLE_TEXT,
  SEARCH_UNSUPPORTED_TEXT,
  escapeMarkdown,
  searchFoundText,
  searchRateLimitedText,
} from './cardText';
import { ADAPTIVE_CARD_VERSION, SCHEMA, safeHttpsUrl } from './responseBuilder';
import {
  SEARCH_ACTION_VERSION,
  SEARCH_FILTER_ACTION,
  SEARCH_FORM_INPUTS,
  SEARCH_PAGE_ACTION,
  SEARCH_STATUS_ANY,
} from './searchText';

/**
 * The search answer as the guest sees it. SDK-agnostic: plain Adaptive Card
 * JSON (1.5) and plain strings, so the Agents SDK port only re-wires it.
 *
 * Every sentence is a fixed Polish string from `cardText.ts`; every value
 * from the index (the client's title, labels, numbers, names) goes through
 * `escapeMarkdown()`; amounts and dates are formatted from their strings,
 * never through a float or a `Date`. Results are Containers, not a Table, so
 * the card reads on a phone. A link becomes an „Otwórz” button only when it
 * is https (ingestion has already kept only links into the client's own
 * site); otherwise the item says „Link niedostępny”. No model text, no
 * reason for a refusal and no quarantine detail is ever shown.
 *
 * The buttons carry only `{v, action, filter, after, start}`: the scope is
 * re-derived by ingestion on every request and never travels in a card.
 */

type OkAnswer = Extract<SearchResponsePayload, { status: 'ok' }>;

/** What the bot sends for a search answer. */
export type SearchReply =
  | { readonly kind: 'card'; readonly card: unknown }
  | { readonly kind: 'text'; readonly text: string }
  /** The help card; `search: false` is today's card, byte for byte. */
  | { readonly kind: 'help'; readonly search: boolean };

export interface SearchReplyContext {
  /** The time the answer is shown, for „spróbuj ponownie o HH:mm”. */
  readonly now: Date;
  /** 1-based position of the first result on this page. */
  readonly start: number;
  /**
   * The answer is to a question, not to the card's form: a guest asking for
   * the first time has no „Zmień filtr” yet, so `unavailable` brings one.
   */
  readonly question?: boolean;
}

/** One reply per answer status; every one but `ok` is a fixed text or the help card. */
export function searchReply(answer: SearchResponsePayload, ctx: SearchReplyContext): SearchReply {
  switch (answer.status) {
    case 'ok':
      return { kind: 'card', card: buildSearchResultCard(answer, ctx.start) };
    case 'help':
      return { kind: 'help', search: true };
    case 'disabled':
      return { kind: 'help', search: false };
    case 'not_understood':
      return {
        kind: 'text',
        text:
          answer.reason === 'unsupported' ? SEARCH_UNSUPPORTED_TEXT : SEARCH_NOT_UNDERSTOOD_TEXT,
      };
    case 'no_access':
      return { kind: 'text', text: SEARCH_NO_ACCESS_TEXT };
    case 'rate_limited':
      return {
        kind: 'text',
        text: searchRateLimitedText(retryClock(ctx.now, answer.retryAfterSeconds)),
      };
    case 'unavailable':
    default:
      // The form's search makes no model call, so it may work while Claude does not.
      return ctx.question
        ? { kind: 'card', card: buildUnavailableCard() }
        : { kind: 'text', text: SEARCH_UNAVAILABLE_TEXT };
  }
}

/** `unavailable` for a question: the fixed text, with an empty „Zmień filtr” form. */
export function buildUnavailableCard(): unknown {
  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: ADAPTIVE_CARD_VERSION,
    body: [{ type: 'TextBlock', text: SEARCH_UNAVAILABLE_QUESTION_TEXT, wrap: true }],
    actions: [
      { type: 'Action.ShowCard', title: SEARCH_CARD_TEXT.changeFilter, card: filterForm({}) },
    ],
  };
}

// ---------------------------------------------------------------------------
// The result card
// ---------------------------------------------------------------------------

/**
 * Display caps (code points) for the free text an item carries, and the
 * longest link kept as a button. With the shaped fields (dates, amounts,
 * currency, NIP) shown only in their contract shape, they bound the card
 * well below Teams' 28 KB message limit whatever the index holds
 * (`searchCard.test.ts` builds the worst case); a longer link says „Link
 * niedostępny”, a longer text ends in „…”.
 */
const MAX_SCOPE_LABEL = 80;
const MAX_NAME = 80;
const MAX_INVOICE_NUMBER = 40;
export const MAX_LINK_CHARS = 600;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CURRENCY = /^[A-Z]{3}$/;
const NIP_DIGITS = /^\d{10}$/;

export function buildSearchResultCard(answer: OkAnswer, start: number): unknown {
  const items = answer.items.slice(0, SEARCH_PAGE_SIZE);
  const first = Math.max(1, Math.floor(start));
  const t = SEARCH_CARD_TEXT;

  const body: unknown[] = [
    {
      type: 'TextBlock',
      text: SEARCH_RESULTS_HEADING,
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: `${t.scopePrefix} ${display(answer.scopeLabel, MAX_SCOPE_LABEL)}`,
      spacing: 'None',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: `${t.understoodPrefix} ${describeFilter(answer.filter)}`,
      isSubtle: true,
      wrap: true,
    },
    ...[...new Set(answer.notes)].map((note) => ({
      type: 'TextBlock',
      text: SEARCH_NOTE_TEXT[note],
      color: 'Warning',
      spacing: 'Small',
      wrap: true,
    })),
    {
      type: 'TextBlock',
      text:
        items.length === 0
          ? SEARCH_EMPTY_TEXT
          : searchFoundText(answer.total, answer.totalCapped, first, first + items.length - 1),
      weight: 'Bolder',
      spacing: 'Medium',
      wrap: true,
    },
    ...items.map(itemContainer),
    {
      type: 'TextBlock',
      text: SEARCH_COVERAGE_TEXT,
      isSubtle: true,
      size: 'Small',
      spacing: 'Medium',
      wrap: true,
    },
  ];

  const actions: unknown[] = [
    ...(answer.nextCursor && items.length > 0
      ? [
          {
            type: 'Action.Submit',
            title: t.nextPage,
            data: {
              v: SEARCH_ACTION_VERSION,
              action: SEARCH_PAGE_ACTION,
              filter: answer.filter,
              after: answer.nextCursor,
              start: first + items.length,
            },
          },
        ]
      : []),
    { type: 'Action.ShowCard', title: t.changeFilter, card: filterForm(answer.filter) },
  ];

  return { type: 'AdaptiveCard', $schema: SCHEMA, version: ADAPTIVE_CARD_VERSION, body, actions };
}

function itemContainer(item: SearchResultItem) {
  const label = escapeMarkdown(getCategory(item.category).polishLabel);
  const heading = item.status === 'in_review' ? `${label} ${SEARCH_IN_REVIEW_LABEL}` : label;

  // A shaped value outside its shape is left out, never shown raw.
  const when =
    formatIssueDate(item.issueDate) ?? formatMonth(item.documentMonth, MONTHS_NOMINATIVE);
  const currency = item.currency && CURRENCY.test(item.currency) ? ` ${item.currency}` : '';
  const grossAmount = item.grossAmount ? formatAmountPl(item.grossAmount) : null;
  const amount = grossAmount ? `${grossAmount}${currency}` : null;
  const details = [
    item.invoiceNumber ? display(defangLinks(item.invoiceNumber), MAX_INVOICE_NUMBER) : null,
    when,
    amount,
  ].filter((part): part is string => part !== null);

  const name = item.counterpartyName ? display(defangLinks(item.counterpartyName), MAX_NAME) : null;
  const nip =
    item.counterpartyNip && NIP_DIGITS.test(item.counterpartyNip) ? item.counterpartyNip : null;
  const counterparty =
    name && nip ? `${name} (NIP ${nip})` : name ? name : nip ? `NIP ${nip}` : null;

  const url = item.webUrl ? safeHttpsUrl(item.webUrl) : undefined;
  const link = url !== undefined && url.length <= MAX_LINK_CHARS ? url : undefined;

  return {
    type: 'Container',
    separator: true,
    spacing: 'Medium',
    items: [
      { type: 'TextBlock', text: heading, weight: 'Bolder', wrap: true },
      ...(details.length > 0
        ? [{ type: 'TextBlock', text: details.join(' · '), spacing: 'None', wrap: true }]
        : []),
      ...(counterparty
        ? [
            {
              type: 'TextBlock',
              text: `${SEARCH_CARD_TEXT.counterpartyPrefix} ${counterparty}`,
              isSubtle: true,
              spacing: 'None',
              wrap: true,
            },
          ]
        : []),
      // The button title is fixed text: Action titles are not markdown, and a
      // fixed label keeps index values out of a second, unescaped place.
      link
        ? {
            type: 'ActionSet',
            actions: [{ type: 'Action.OpenUrl', title: SEARCH_CARD_TEXT.open, url: link }],
          }
        : {
            type: 'TextBlock',
            text: SEARCH_LINK_UNAVAILABLE_TEXT,
            isSubtle: true,
            size: 'Small',
            spacing: 'Small',
            wrap: true,
          },
    ],
  };
}

// ---------------------------------------------------------------------------
// „Zmień filtr”: a form that becomes a typed request (no model call)
// ---------------------------------------------------------------------------

const MONTH_REGEX = '^\\d{4}-(0[1-9]|1[0-2])$';

/**
 * Pre-filled with the filter that ran. Input values are plain text, not
 * markdown, so they are not escaped (an escape would be sent back as part
 * of the value); they come from the filter ingestion validated. Its submit
 * carries `{v, action}` only: Teams adds the inputs, nothing else.
 */
function filterForm(filter: ClientSearchFilter) {
  const ids = SEARCH_FORM_INPUTS;
  const t = SEARCH_CARD_TEXT;
  const text = (id: string, label: string, placeholder: string, value?: string, max = 60) => ({
    type: 'Input.Text',
    id,
    label,
    placeholder,
    maxLength: max,
    ...(value !== undefined ? { value } : {}),
  });
  const amountValue = (v?: string) => (v === undefined ? undefined : v.replace('.', ','));
  const month = (id: string, label: string, placeholder: string, value?: string) => ({
    ...text(id, label, placeholder, value, 7),
    regex: MONTH_REGEX,
    errorMessage: t.monthError,
  });

  return {
    type: 'AdaptiveCard',
    body: [
      {
        type: 'Input.ChoiceSet',
        id: ids.categories,
        label: t.category,
        style: 'compact',
        isMultiSelect: true,
        placeholder: t.anyCategory,
        choices: categoryCatalog.map((c) => ({ title: c.polishLabel, value: c.id })),
        ...(filter.categories ? { value: filter.categories.join(',') } : {}),
      },
      month(ids.monthFrom, t.monthFrom, 'np. 2026-01', filter.monthFrom),
      month(ids.monthTo, t.monthTo, 'np. 2026-09', filter.monthTo),
      text(ids.grossMin, t.grossMin, 'np. 1000,00', amountValue(filter.grossMin), 20),
      text(ids.grossMax, t.grossMax, 'np. 5000,00', amountValue(filter.grossMax), 20),
      text(ids.currency, t.currency, 'np. PLN', filter.currency, 3),
      text(ids.counterpartyNip, t.nip, t.nipPlaceholder, filter.counterpartyNip, 20),
      text(
        ids.counterpartyName,
        t.counterpartyName,
        t.counterpartyNamePlaceholder,
        filter.counterpartyName,
      ),
      text(ids.invoiceNumber, t.invoiceNumber, 'np. FV/1/2026', filter.invoiceNumber),
      {
        type: 'Input.ChoiceSet',
        id: ids.status,
        label: t.status,
        style: 'compact',
        value: filter.status ?? SEARCH_STATUS_ANY,
        choices: [
          { title: t.statusAny, value: SEARCH_STATUS_ANY },
          { title: t.statusFiled, value: 'filed' },
          { title: t.statusInReview, value: 'in_review' },
        ],
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: t.submit,
        data: { v: SEARCH_ACTION_VERSION, action: SEARCH_FILTER_ACTION },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// What the card understood, in Polish
// ---------------------------------------------------------------------------

/** „Faktura zakupu; od marca 2026 do września 2026; kwota brutto od 1000,00 PLN”. */
export function describeFilter(filter: ClientSearchFilter): string {
  const parts: string[] = [];
  if (filter.categories?.length) {
    parts.push(filter.categories.map((c) => escapeMarkdown(getCategory(c).polishLabel)).join(', '));
  }

  // The filter passed the shared schema, so every month and amount has its shape;
  // the escaped fallbacks only keep the types honest.
  const month = (ym: string, names: readonly string[]) =>
    formatMonth(ym, names) ?? escapeMarkdown(ym);
  const { monthFrom: from, monthTo: to } = filter;
  if (from && to && from === to) parts.push(month(from, MONTHS_NOMINATIVE));
  else if (from && to) {
    parts.push(`od ${month(from, MONTHS_GENITIVE)} do ${month(to, MONTHS_GENITIVE)}`);
  } else if (from) parts.push(`od ${month(from, MONTHS_GENITIVE)}`);
  else if (to) parts.push(`do ${month(to, MONTHS_GENITIVE)}`);

  const currency = filter.currency ? ` ${escapeMarkdown(filter.currency)}` : '';
  const amount = (v: string) => `${formatAmountPl(v) ?? escapeMarkdown(v)}${currency}`;
  if (filter.grossMin && filter.grossMax) {
    parts.push(`kwota brutto od ${amount(filter.grossMin)} do ${amount(filter.grossMax)}`);
  } else if (filter.grossMin) parts.push(`kwota brutto od ${amount(filter.grossMin)}`);
  else if (filter.grossMax) parts.push(`kwota brutto do ${amount(filter.grossMax)}`);
  else if (filter.currency) parts.push(`waluta${currency}`);

  if (filter.counterpartyNip) {
    parts.push(`NIP kontrahenta ${escapeMarkdown(filter.counterpartyNip)}`);
  }
  if (filter.counterpartyName) {
    parts.push(`kontrahent „${escapeMarkdown(filter.counterpartyName)}”`);
  }
  if (filter.invoiceNumber) parts.push(`numer faktury ${escapeMarkdown(filter.invoiceNumber)}`);
  if (filter.status === 'in_review') parts.push('w weryfikacji');
  if (filter.status === 'filed') parts.push('zarchiwizowane');

  return parts.length > 0 ? parts.join('; ') : SEARCH_EVERYTHING_TEXT;
}

// ---------------------------------------------------------------------------
// Formatting from strings (never a float, never a Date for a calendar value)
// ---------------------------------------------------------------------------

const DECIMAL = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/;
const NBSP = '\u00a0';

/**
 * A decimal string as pl-PL shows it, with two decimals: `1234.5` →
 * `1234,50`, `12345.5` → `12 345,50` (no-break spaces, grouped from five
 * integer digits, as `Intl.NumberFormat('pl-PL')` does). Worked on the
 * digits, never through a float, so `999999999999.99` stays exact. `null`
 * for anything that is not a decimal string.
 */
export function formatAmountPl(decimal: string): string | null {
  const m = DECIMAL.exec(decimal.trim());
  if (!m) return null;
  const [, sign = '', rawInteger = '0', fraction = ''] = m;
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  const grouped = integer.length >= 5 ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) : integer;
  const isZero = /^0+$/.test(integer) && /^0*$/.test(fraction);
  return `${sign && !isZero ? '-' : ''}${grouped},${fraction.padEnd(2, '0')}`;
}

/** `2026-09-15` → `15.09.2026`; `null` for anything else. */
export function formatIssueDate(iso: string | null): string | null {
  const m = iso === null ? null : ISO_DATE.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

/** `2026-09` → `wrzesień 2026` (or `września 2026`); `null` for anything else. */
export function formatMonth(ym: string | null, names: readonly string[]): string | null {
  const m = ym === null ? null : YEAR_MONTH.exec(ym);
  return m ? `${names[Number(m[2]) - 1]} ${m[1]}` : null;
}

const WARSAW_CLOCK = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `HH:mm` in Warsaw when `seconds` from `now` have passed, rounded up to the minute. */
export function retryClock(now: Date, seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), 7 * 86_400) : 0;
  const at = now.getTime() + safeSeconds * 1000;
  return WARSAW_CLOCK.format(new Date(Math.ceil(at / 60_000) * 60_000));
}

/** Half of a surrogate pair standing alone: JSON would spell it as six bytes. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * An index value for a TextBlock: lone surrogates replaced, capped to `max`
 * code points, then escaped.
 */
function display(value: string, max: number): string {
  const chars = Array.from(value.replace(LONE_SURROGATE, '\ufffd'));
  const capped = chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
  return escapeMarkdown(capped);
}
