import { createHash, randomUUID } from 'node:crypto';
import {
  clientIdForDirectoryRow,
  clientsRepo,
  documentsRepo,
  LedgerDbError,
  searchQueriesRepo,
  sqlStateOf,
  type LedgerDb,
  type SearchQueryKind,
  type SearchQueryOutcome,
} from '@bcr/ledger-db';
import {
  SEARCH_PAGE_SIZE,
  SEARCH_TOTAL_CAP,
  type ClientSearchFilter,
  type DirectoryClientResolution,
  type Logger,
  type SearchNote,
  type SearchRequestPayload,
  type SearchResponsePayload,
} from '@bcr/shared';
import type { SearchOffReason } from '../config';
import type { ClientResolver } from './clientResolver';
import type { InterpretResult, SearchInterpreter, SearchModelUsage } from './searchInterpreter';
import {
  normalizeSearchQuestion,
  toResultItem,
  toSearchFilter,
  withoutReviewCategories,
} from './searchResult';
import type { UserTypeSource } from './userDirectory';

/** Searches one worker runs at once: the index pool is 2 connections, shared with filing. */
export const SEARCH_MAX_CONCURRENT = 2;

/** Model calls one worker makes in any hour; beyond it a question is `unavailable` (typed search still works). */
export const SEARCH_MAX_MODEL_CALLS_PER_HOUR = 300;

/**
 * One search's budget in ingestion, from its start: under the bot's 20 s wait
 * (`SEARCH_TIMEOUT_MS`, which also covers its token and the network), so the
 * bot never gives up on a search that ingestion still answers and charges.
 * Nothing is reserved (charged to the quotas) unless the rest can fit.
 */
export const SEARCH_DEADLINE_MS = 15_000;
/** Kept for the read and the record once the model has answered. */
export const SEARCH_DB_MARGIN_MS = 3_000;
/** The shortest model call worth making; with less time left the answer is `unavailable`. */
export const SEARCH_MIN_MODEL_MS = 4_000;

/** How long one asker's same question reuses its interpretation, per worker. */
export const SEARCH_INTERPRETATION_TTL_MS = 10 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const MAX_CACHED_INTERPRETATIONS = 1000;

export interface ClientSearchServiceOptions {
  /** Why search is off (`searchOffReason`); absent when it may run. */
  readonly offReason?: SearchOffReason;
  /** The one resolver uploads use: search gets no routing of its own. */
  readonly resolver: Pick<ClientResolver, 'resolve'>;
  /** The asker's Entra `userType`: only a guest (a client) may search. */
  readonly userTypes: UserTypeSource;
  /** The document index; only its client transaction is used. Absent: search is off. */
  readonly db?: Pick<LedgerDb, 'withClientTx'>;
  /** Absent: search is off (Claude is not configured). */
  readonly interpreter?: Pick<SearchInterpreter, 'interpret'>;
  /** `CLIENT_DIRECTORY_LIST_ID`: part of every client's derived id. */
  readonly directoryListId: string;
  /** `SEARCH_ROWS`: list item ids search is open to; empty: every bound row. */
  readonly searchRows: readonly string[];
  /** Injected in tests. */
  readonly now?: () => Date;
  readonly newQueryId?: () => string;
  readonly maxConcurrent?: number;
  readonly maxModelCallsPerHour?: number;
}

/** A question's interpretation, kept for the same asker and question a short while. */
interface CachedInterpretation {
  readonly result: Exclude<InterpretResult, { outcome: 'unavailable' }>;
  readonly at: number;
}

/** The request, checked and ready: a question (normalised) or a typed filter. */
type PreparedQuery =
  | {
      readonly kind: 'question';
      readonly question: string;
      readonly cacheKey: string;
      readonly cached?: CachedInterpretation['result'];
    }
  | { readonly kind: 'typed'; readonly filter: ClientSearchFilter; readonly after?: string };

/** What the search found, before it is recorded. */
interface Answer {
  readonly response: SearchResponsePayload;
  readonly outcome: SearchQueryOutcome;
  readonly filter?: ClientSearchFilter;
  readonly resultCount?: number;
  readonly usage?: SearchModelUsage;
}

/**
 * Client search (`POST /api/search`, design steps 7–16): a guest's question,
 * or a typed filter from the card, over their own client's documents.
 *
 * Search is a second consumer of the routing uploads use; it has none of its
 * own. Who is asking is the authenticated `source.userAadObjectId`; which
 * client is decided by the same `ClientResolver` (bound row, exact Team,
 * membership read now), and only an Entra guest may search. The index scope
 * is then {@link clientIdForDirectoryRow} of the resolved row, computed before
 * any read, and nothing else: not the question, not the model's answer, not a
 * field of the request. Row-level security keeps every transaction to it.
 *
 * In order:
 *  1. off (`SEARCH_MODE`, no index, no Claude, no callers, callers shared with
 *     the bot's secret, membership check off) → `disabled`;
 *  2. not bound to exactly one client (every quarantine reason) → `no_access`;
 *  3. not a guest, or their type cannot be read → `no_access`;
 *  4. their row not in `SEARCH_ROWS` → `disabled`;
 *  5. the durable limits, in the client's scope (tx1: the client row, then the
 *     reservation) → `rate_limited`;
 *  6. a question only: the model (per-worker hourly cap), then
 *     `toSearchFilter`;
 *  7. the read, in a READ ONLY transaction (tx2): one page of client-view
 *     columns and the count, capped;
 *  8. best effort, the record (tx3): outcome, filter hash and field names,
 *     counts, tokens; never the question, never a filter value.
 *
 * Refusals 1–4 cost no model call and no transaction, nor does a search
 * with too little of {@link SEARCH_DEADLINE_MS} left to finish (`unavailable`,
 * before anything is reserved); the model call is bounded by the time left.
 * At most
 * {@link SEARCH_MAX_CONCURRENT} searches run at once per worker; beyond them
 * the answer is `unavailable`.
 *
 * Contract: it NEVER throws. Logs carry ids, codes and counts only (`search.*`
 * events): never the question, the filter's values or a result.
 */
export class ClientSearchService {
  private readonly now: () => Date;
  private readonly newQueryId: () => string;
  private readonly maxConcurrent: number;
  private readonly maxModelCallsPerHour: number;
  private readonly searchRows: ReadonlySet<string>;
  private running = 0;
  private modelCalls: number[] = [];
  private readonly interpretations = new Map<string, CachedInterpretation>();

  constructor(private readonly opts: ClientSearchServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.newQueryId = opts.newQueryId ?? randomUUID;
    this.maxConcurrent = opts.maxConcurrent ?? SEARCH_MAX_CONCURRENT;
    this.maxModelCallsPerHour = opts.maxModelCallsPerHour ?? SEARCH_MAX_MODEL_CALLS_PER_HOUR;
    this.searchRows = new Set(opts.searchRows.map((id) => id.trim()));
  }

  /** Whether search answers anything but `disabled` (for the cold-start line). */
  get enabled(): boolean {
    return (
      !this.opts.offReason && this.opts.db !== undefined && this.opts.interpreter !== undefined
    );
  }

  async search(payload: SearchRequestPayload, log: Logger): Promise<SearchResponsePayload> {
    const kind: SearchQueryKind =
      payload.query.kind === 'question' ? 'question' : payload.query.after ? 'page' : 'typed';
    const reqLog = log.child({ searchKind: kind });
    try {
      return await this.run(payload, kind, reqLog);
    } catch (err) {
      reqLog.warn(
        { event: 'search.unavailable', stage: 'internal', err: describeError(err) },
        'search.unavailable',
      );
      return { status: 'unavailable' };
    }
  }

  private async run(
    payload: SearchRequestPayload,
    kind: SearchQueryKind,
    log: Logger,
  ): Promise<SearchResponsePayload> {
    const { db, interpreter } = this.opts;
    const deadline = this.now().getTime() + SEARCH_DEADLINE_MS;
    // 1. Off: nothing is read, nobody is resolved.
    if (this.opts.offReason || !db || !interpreter) {
      log.info(
        { event: 'search.disabled', reason: this.opts.offReason ?? 'not_wired' },
        'search.disabled',
      );
      return { status: 'disabled' };
    }

    // 2. Which client: the uploads' resolver, from the authenticated id alone.
    const oid = payload.source.userAadObjectId.trim().toLowerCase();
    const resolved = await this.opts.resolver.resolve({ userAadObjectId: oid, purpose: 'search' });
    if (resolved.source !== 'directory') {
      log.info({ event: 'search.no_access', reason: resolved.reason }, 'search.no_access');
      return { status: 'no_access' };
    }
    const ids = {
      clientId: resolved.clientId,
      listItemId: resolved.listItemId,
      teamId: resolved.teamId,
    };

    // 3. Only a client's guest: a staff id on a client row never searches.
    const refusedUser = await this.guestCheck(oid);
    if (refusedUser) {
      log.info({ event: 'search.no_access', reason: refusedUser, ...ids }, 'search.no_access');
      return { status: 'no_access' };
    }

    // 4. A canary-first rollout.
    if (this.searchRows.size > 0 && !this.searchRows.has(resolved.listItemId)) {
      log.info({ event: 'search.disabled', reason: 'row_not_listed', ...ids }, 'search.disabled');
      return { status: 'disabled' };
    }

    // The scope: a pure function of the resolved row, known before any read.
    const scope = clientIdForDirectoryRow(this.opts.directoryListId, resolved.listItemId);
    const scopeLog = log.child({ ...ids, ledgerClientId: scope });

    let query: PreparedQuery;
    if (payload.query.kind === 'question') {
      const question = normalizeSearchQuestion(payload.query.text);
      if (question === '') {
        scopeLog.info(
          { event: 'search.not_understood', reason: 'empty_question' },
          'search.not_understood',
        );
        return { status: 'not_understood', reason: 'unclear' };
      }
      const cacheKey = interpretationKey(oid, question);
      const cached = this.cachedInterpretation(cacheKey);
      if (!cached && !this.modelCallAvailable()) {
        scopeLog.warn({ event: 'search.unavailable', stage: 'model_cap' }, 'search.unavailable');
        return { status: 'unavailable' };
      }
      query = { kind: 'question', question, cacheKey, ...(cached ? { cached } : {}) };
    } else {
      const { filter, after } = payload.query;
      query = { kind: 'typed', filter, ...(after !== undefined ? { after } : {}) };
    }

    // Too little time left (a slow Graph read, a cold start): refuse before
    // anything is reserved, rather than charge a search the bot gave up on.
    const needed =
      SEARCH_DB_MARGIN_MS + (query.kind === 'question' && !query.cached ? SEARCH_MIN_MODEL_MS : 0);
    if (deadline - this.now().getTime() < needed) {
      scopeLog.warn({ event: 'search.unavailable', stage: 'deadline' }, 'search.unavailable');
      return { status: 'unavailable' };
    }

    if (this.running >= this.maxConcurrent) {
      scopeLog.warn(
        { event: 'search.unavailable', stage: 'busy', running: this.running },
        'search.unavailable',
      );
      return { status: 'unavailable' };
    }
    this.running += 1;
    try {
      const queryId = this.newQueryId();
      const qLog = scopeLog.child({ queryId });
      const started = this.now().getTime();

      // 5. tx1: the client row (the reservation's foreign key), then the limits.
      let reservation: searchQueriesRepo.ReserveResult;
      try {
        reservation = await db.withClientTx(scope, async (tx) => {
          await clientsRepo.upsertFromDirectory(tx, {
            directoryListId: this.opts.directoryListId,
            listItemId: resolved.listItemId,
            clientNo: resolved.clientId,
            nip: resolved.nip,
            legalName: resolved.companyName,
            active: true,
          });
          return searchQueriesRepo.reserve(tx, { queryId, userOid: oid, kind });
        });
      } catch (err) {
        qLog.warn(
          { event: 'search.unavailable', stage: 'reserve', err: describeError(err) },
          'search.unavailable',
        );
        return { status: 'unavailable' };
      }
      if (reservation.status === 'rate_limited') {
        qLog.info(
          {
            event: 'search.rate_limited',
            quota: reservation.quota,
            retryAfterSeconds: reservation.retryAfterSeconds,
          },
          'search.rate_limited',
        );
        return { status: 'rate_limited', retryAfterSeconds: reservation.retryAfterSeconds };
      }

      // 6–7.
      const answer = await this.answer({ query, resolved, scope, interpreter, db, deadline }, qLog);

      // 8. Best effort: the answer stands whatever the record does.
      const latencyMs = Math.max(0, this.now().getTime() - started);
      await this.record(db, scope, queryId, answer, latencyMs, qLog);
      return answer.response;
    } finally {
      this.running -= 1;
    }
  }

  private async answer(
    ctx: {
      readonly query: PreparedQuery;
      readonly resolved: DirectoryClientResolution;
      readonly scope: string;
      readonly interpreter: Pick<SearchInterpreter, 'interpret'>;
      readonly db: Pick<LedgerDb, 'withClientTx'>;
      /** When the answer must be ready (`SEARCH_DEADLINE_MS` from the start). */
      readonly deadline: number;
    },
    log: Logger,
  ): Promise<Answer> {
    const query = ctx.query;
    let filter: ClientSearchFilter;
    let after: string | undefined;
    let notes: readonly SearchNote[] = [];
    /** The model call's usage, when this search made one (a cached answer costs nothing). */
    let spent: { readonly usage?: SearchModelUsage } = {};

    if (query.kind === 'question') {
      let result = query.cached;
      if (!result) {
        const timeoutMs = ctx.deadline - this.now().getTime() - SEARCH_DB_MARGIN_MS;
        if (timeoutMs < SEARCH_MIN_MODEL_MS) {
          log.warn({ event: 'search.unavailable', stage: 'deadline' }, 'search.unavailable');
          return { response: { status: 'unavailable' }, outcome: 'unavailable' };
        }
        if (!this.takeModelCall()) {
          log.warn({ event: 'search.unavailable', stage: 'model_cap' }, 'search.unavailable');
          return { response: { status: 'unavailable' }, outcome: 'unavailable' };
        }
        const fresh = await ctx.interpreter.interpret(query.question, log, { timeoutMs });
        if (fresh.outcome === 'unavailable') {
          log.warn(
            {
              event: 'search.unavailable',
              stage: 'model',
              reason: fresh.reason,
              ...(fresh.status !== undefined ? { status: fresh.status } : {}),
            },
            'search.unavailable',
          );
          return { response: { status: 'unavailable' }, outcome: 'unavailable' };
        }
        result = fresh;
        spent = { usage: fresh.usage };
        this.rememberInterpretation(query.cacheKey, fresh);
      }
      if (result.outcome === 'help') {
        log.info({ event: 'search.help', cached: !spent.usage }, 'search.help');
        return { response: { status: 'help' }, outcome: 'help', ...spent };
      }
      if (result.outcome === 'not_understood') {
        log.info(
          { event: 'search.not_understood', reason: result.reason, cached: !spent.usage },
          'search.not_understood',
        );
        return {
          response: { status: 'not_understood', reason: result.reason },
          outcome: result.reason === 'unsupported' ? 'unsupported' : 'not_understood',
          ...spent,
        };
      }
      const built = toSearchFilter(result.interpretation, query.question, this.now());
      if (!built.ok) {
        log.info(
          { event: 'search.not_understood', reason: built.reason, cached: !spent.usage },
          'search.not_understood',
        );
        return {
          response: { status: 'not_understood', reason: 'unclear' },
          outcome: 'not_understood',
          ...spent,
        };
      }
      filter = built.filter;
      notes = built.notes;
    } else {
      ({ filter, notes } = withoutReviewCategories(query.filter));
      after = query.after;
    }

    // 7. tx2: READ ONLY, the client-view columns only, in the scope alone.
    let found: {
      readonly page: documentsRepo.SearchResult<documentsRepo.ClientViewRow>;
      readonly count: documentsRepo.MatchCount;
    };
    try {
      found = await ctx.db.withClientTx(
        ctx.scope,
        async (tx) => {
          const page = await documentsRepo.searchClientView(tx, filter, {
            limit: SEARCH_PAGE_SIZE,
            ...(after !== undefined ? { after } : {}),
          });
          const count = await documentsRepo.countMatching(tx, filter, SEARCH_TOTAL_CAP);
          return { page, count };
        },
        { readOnly: true },
      );
    } catch (err) {
      // A cursor or filter the index will not take (tampered, or a value it
      // refuses) is the request's, not an outage.
      if (
        err instanceof LedgerDbError &&
        (err.reason === 'invalid_cursor' || err.reason === 'invalid_filter')
      ) {
        log.info(
          { event: 'search.not_understood', reason: err.reason, filterFields: fieldsOf(filter) },
          'search.not_understood',
        );
        return {
          response: { status: 'not_understood', reason: 'unclear' },
          outcome: 'not_understood',
          ...spent,
        };
      }
      log.warn(
        { event: 'search.unavailable', stage: 'read', err: describeError(err) },
        'search.unavailable',
      );
      return {
        response: { status: 'unavailable' },
        outcome: 'unavailable',
        ...spent,
      };
    }

    const owner = { nip: ctx.resolved.nip, target: ctx.resolved.target };
    const items = found.page.items.flatMap((row) => {
      const item = toResultItem(row, owner);
      return item ? [item] : [];
    });
    const dropped = found.page.items.length - items.length;
    log.info(
      {
        event: 'search.ok',
        filterFields: fieldsOf(filter),
        notes,
        total: found.count.total,
        totalCapped: found.count.capped,
        items: items.length,
        ...(dropped > 0 ? { droppedItems: dropped } : {}),
        links: items.filter((i) => i.webUrl !== null).length,
        nextPage: found.page.nextCursor !== null,
        ...(query.kind === 'question' ? { cached: !spent.usage } : {}),
      },
      'search.ok',
    );
    return {
      response: {
        status: 'ok',
        scopeLabel: ctx.resolved.title,
        filter,
        total: found.count.total,
        totalCapped: found.count.capped,
        items,
        nextCursor: found.page.nextCursor,
        notes,
      },
      outcome: 'ok',
      filter,
      resultCount: found.count.total,
      ...spent,
    };
  }

  /** `null` when the asker is a guest; otherwise why not (a code). */
  private async guestCheck(oid: string): Promise<'not_guest' | 'user_unverified' | null> {
    let userType: string | null;
    try {
      userType = await this.opts.userTypes.userTypeOf(oid);
    } catch {
      return 'user_unverified';
    }
    return (userType ?? '').trim().toLowerCase() === 'guest' ? null : 'not_guest';
  }

  /** tx3: the reservation's row, finished. A failure is logged and changes nothing. */
  private async record(
    db: Pick<LedgerDb, 'withClientTx'>,
    scope: string,
    queryId: string,
    answer: Answer,
    latencyMs: number,
    log: Logger,
  ): Promise<void> {
    try {
      const usage = answer.usage;
      const finished = await db.withClientTx(scope, (tx) =>
        searchQueriesRepo.finish(tx, {
          queryId,
          outcome: answer.outcome,
          ...(answer.filter ? searchQueriesRepo.filterDigest(answer.filter) : {}),
          ...(answer.resultCount !== undefined ? { resultCount: answer.resultCount } : {}),
          ...(usage
            ? {
                model: usage.model,
                tokens: {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                },
              }
            : {}),
          latencyMs,
        }),
      );
      if (!finished) {
        log.warn({ event: 'search.record_failed', reason: 'not_started' }, 'search.record_failed');
      }
    } catch (err) {
      log.warn(
        { event: 'search.record_failed', reason: 'error', err: describeError(err) },
        'search.record_failed',
      );
    }
  }

  // --- Per-worker model budget and interpretation cache ---------------------

  private modelCallAvailable(): boolean {
    const since = this.now().getTime() - HOUR_MS;
    this.modelCalls = this.modelCalls.filter((t) => t > since);
    return this.modelCalls.length < this.maxModelCallsPerHour;
  }

  private takeModelCall(): boolean {
    if (!this.modelCallAvailable()) return false;
    this.modelCalls.push(this.now().getTime());
    return true;
  }

  private cachedInterpretation(key: string): CachedInterpretation['result'] | undefined {
    const hit = this.interpretations.get(key);
    if (!hit) return undefined;
    if (this.now().getTime() - hit.at >= SEARCH_INTERPRETATION_TTL_MS) {
      this.interpretations.delete(key);
      return undefined;
    }
    return hit.result;
  }

  private rememberInterpretation(key: string, result: CachedInterpretation['result']): void {
    this.interpretations.delete(key);
    if (this.interpretations.size >= MAX_CACHED_INTERPRETATIONS) {
      const oldest = this.interpretations.keys().next();
      if (!oldest.done) this.interpretations.delete(oldest.value);
    }
    this.interpretations.set(key, { result, at: this.now().getTime() });
  }
}

/** The cache key of one asker's question: a hash, so the map holds no question text as a key. */
function interpretationKey(oid: string, question: string): string {
  return createHash('sha256').update(`${oid}\u0000${question}`).digest('hex');
}

/** The names of the filter's fields that are set, sorted: never a value. */
function fieldsOf(filter: ClientSearchFilter): string[] {
  return Object.entries(filter)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}

/** Name, SQLSTATE and the index's reason only: a PostgreSQL message can quote values. */
function describeError(err: unknown): Record<string, unknown> {
  const code = sqlStateOf(err);
  return {
    ...(err instanceof Error ? { name: err.name } : { type: typeof err }),
    ...(code ? { sqlState: code } : {}),
    ...(err instanceof LedgerDbError ? { indexReason: err.reason } : {}),
  };
}
