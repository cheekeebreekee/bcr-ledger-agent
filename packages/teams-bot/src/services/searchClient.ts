import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { request } from 'undici';
import {
  clientSearchFilterSchema,
  createLogger,
  isDocumentCategory,
  LedgerAgentError,
  type Logger,
  SEARCH_CURSOR_MAX_CHARS,
  SEARCH_PAGE_SIZE,
  type SearchNote,
  type SearchRequestPayload,
  type SearchResponsePayload,
  type SearchResultItem,
} from '@bcr/shared';

/** The subset of undici's `request` the client uses; injectable for tests. */
export type SearchFetcher = (
  url: string,
  options: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;

export interface SearchClientOptions {
  readonly baseUrl: string;
  /** `INGESTION_SCOPE`, `api://<ingestion app id>/.default`. */
  readonly scope: string;
  /** Optional override for tests. Defaults to undici's `request`. */
  readonly fetcher?: SearchFetcher;
  /**
   * Optional override for tests. Defaults to the bot Function App's
   * system-assigned managed identity — never the bot registration's secret:
   * only the managed identity holds the `Documents.Search` role.
   */
  readonly acquireToken?: (signal: AbortSignal) => Promise<string>;
  /** The whole call, token included. Default {@link SEARCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
}

/** How long a search may take end to end before the bot answers `unavailable`. */
export const SEARCH_TIMEOUT_MS = 20_000;

const UNAVAILABLE: SearchResponsePayload = { status: 'unavailable' };

/**
 * Thin HTTP client for ingestion's `POST /api/search`.
 *
 * It sends only what the caller built (the gate-checked source and the
 * query) and never reads, logs or echoes a body beyond parsing the answer.
 * It never throws: a failed token, a timeout, a non-200, a non-JSON body or
 * an answer outside the shared contract all become `{ status: 'unavailable' }`,
 * which the bot renders as one fixed Polish line. An accepted answer is
 * rebuilt from its known fields only, so nothing ingestion adds by mistake can
 * reach a card.
 */
export class SearchClient {
  private readonly log: Pick<Logger, 'info' | 'warn'>;
  private readonly fetcher: SearchFetcher;
  private readonly acquireToken: (signal: AbortSignal) => Promise<string>;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SearchClientOptions) {
    this.log = opts.logger ?? createLogger('bot/searchClient');
    this.fetcher = opts.fetcher ?? request;
    this.acquireToken = opts.acquireToken ?? managedIdentityToken(opts.scope);
    this.timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  }

  async search(payload: SearchRequestPayload): Promise<SearchResponsePayload> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new LedgerAgentError('SearchTimeout', 'search call timed out', 504)),
        { once: true },
      );
    });
    try {
      return await Promise.race([this.call(payload, controller.signal, started), timedOut]);
    } catch (err) {
      this.log.warn(
        {
          err,
          kind: payload.query.kind,
          timedOut: controller.signal.aborted,
          latencyMs: Date.now() - started,
        },
        'search.call_failed',
      );
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(
    payload: SearchRequestPayload,
    signal: AbortSignal,
    started: number,
  ): Promise<SearchResponsePayload> {
    const token = await this.acquireToken(signal);
    const url = new URL('/api/search', this.opts.baseUrl).toString();
    const { statusCode, body } = await this.fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal,
    });

    // Always drain the body so undici can reuse the connection.
    const text = await body.text();
    const latencyMs = Date.now() - started;

    if (statusCode !== 200) {
      this.log.warn({ statusCode, kind: payload.query.kind, latencyMs }, 'search.http_error');
      return UNAVAILABLE;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.warn({ statusCode, kind: payload.query.kind, latencyMs }, 'search.bad_response');
      return UNAVAILABLE;
    }
    const answer = parseSearchResponse(parsed);
    if (!answer) {
      this.log.warn({ statusCode, kind: payload.query.kind, latencyMs }, 'search.bad_response');
      return UNAVAILABLE;
    }
    this.log.info(
      { statusCode, kind: payload.query.kind, status: answer.status, latencyMs },
      'search.call',
    );
    return answer;
  }
}

/**
 * Tokens for `scope` from the bot Function App's system-assigned managed
 * identity: the identity `SEARCH_CALLER_APP_IDS` names on ingestion. The
 * credential caches the token and renews it before expiry.
 */
export function managedIdentityToken(
  scope: string,
  credential: Pick<TokenCredential, 'getToken'> = new ManagedIdentityCredential(),
): (signal: AbortSignal) => Promise<string> {
  return async (abortSignal) => {
    const token = await credential.getToken(scope, { abortSignal });
    if (!token?.token) {
      throw new LedgerAgentError('SearchUnavailable', 'managed identity returned no token', 502);
    }
    return token.token;
  };
}

// ---------------------------------------------------------------------------
// The answer, checked against the shared contract
// ---------------------------------------------------------------------------

const KNOWN_NOTES: ReadonlySet<SearchNote> = new Set<SearchNote>([
  'counterparty_name_dropped',
  'invoice_number_dropped',
  'nip_dropped',
  'period_clamped',
  'categories_in_review',
]);

/** Longest `webUrl` accepted; a longer one is dropped (the item shows „Link niedostępny”). */
const MAX_URL_CHARS = 2048;
/** Longest other string field accepted; a longer answer is refused as a whole. */
const MAX_FIELD_CHARS = 1000;

/**
 * `SearchResponsePayload` from an untrusted JSON value, rebuilt from its
 * known fields only; `null` when it does not match the contract.
 */
export function parseSearchResponse(value: unknown): SearchResponsePayload | null {
  if (!isRecord(value)) return null;
  switch (value.status) {
    case 'help':
    case 'no_access':
    case 'unavailable':
    case 'disabled':
      // Nothing else is read: a reason sent along with `no_access` is dropped here.
      return { status: value.status };
    case 'not_understood':
      return value.reason === 'unclear' || value.reason === 'unsupported'
        ? { status: 'not_understood', reason: value.reason }
        : null;
    case 'rate_limited':
      return typeof value.retryAfterSeconds === 'number' &&
        Number.isFinite(value.retryAfterSeconds) &&
        value.retryAfterSeconds >= 0
        ? { status: 'rate_limited', retryAfterSeconds: value.retryAfterSeconds }
        : null;
    case 'ok':
      return parseOk(value);
    default:
      return null;
  }
}

function parseOk(value: Record<string, unknown>): SearchResponsePayload | null {
  const filter = clientSearchFilterSchema.safeParse(value.filter);
  if (!filter.success) return null;
  if (typeof value.scopeLabel !== 'string' || value.scopeLabel.length > MAX_FIELD_CHARS) {
    return null;
  }
  if (typeof value.total !== 'number' || !Number.isInteger(value.total) || value.total < 0) {
    return null;
  }
  if (typeof value.totalCapped !== 'boolean') return null;
  if (!Array.isArray(value.items) || value.items.length > SEARCH_PAGE_SIZE) return null;
  const items: SearchResultItem[] = [];
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (!item) return null;
    items.push(item);
  }
  const nextCursor = value.nextCursor ?? null;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' ||
      nextCursor.length === 0 ||
      nextCursor.length > SEARCH_CURSOR_MAX_CHARS)
  ) {
    return null;
  }
  const notes = Array.isArray(value.notes)
    ? value.notes.filter((n): n is SearchNote => KNOWN_NOTES.has(n as SearchNote))
    : [];
  return {
    status: 'ok',
    scopeLabel: value.scopeLabel,
    filter: filter.data,
    total: value.total,
    totalCapped: value.totalCapped,
    items,
    nextCursor,
    notes: [...new Set(notes)],
  };
}

function parseItem(raw: unknown): SearchResultItem | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.documentId !== 'string' || raw.documentId.length > MAX_FIELD_CHARS) return null;
  if (raw.status !== 'filed' && raw.status !== 'in_review') return null;
  if (!isDocumentCategory(raw.category)) return null;
  const fields = [
    'documentMonth',
    'invoiceNumber',
    'issueDate',
    'grossAmount',
    'currency',
    'counterpartyName',
    'counterpartyNip',
  ] as const;
  const text: Partial<Record<(typeof fields)[number], string | null>> = {};
  for (const field of fields) {
    const v: unknown = raw[field] ?? null;
    if (v === null) {
      text[field] = null;
      continue;
    }
    if (typeof v !== 'string' || v.length > MAX_FIELD_CHARS) return null;
    text[field] = v;
  }
  const webUrl = raw.webUrl ?? null;
  if (webUrl !== null && typeof webUrl !== 'string') return null;
  return {
    documentId: raw.documentId,
    status: raw.status,
    category: raw.category,
    documentMonth: text.documentMonth ?? null,
    invoiceNumber: text.invoiceNumber ?? null,
    issueDate: text.issueDate ?? null,
    grossAmount: text.grossAmount ?? null,
    currency: text.currency ?? null,
    counterpartyName: text.counterpartyName ?? null,
    counterpartyNip: text.counterpartyNip ?? null,
    webUrl: webUrl !== null && webUrl.length <= MAX_URL_CHARS ? webUrl : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
