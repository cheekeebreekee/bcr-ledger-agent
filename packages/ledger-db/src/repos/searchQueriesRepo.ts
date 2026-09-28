import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LedgerDbError } from '../errors';
import { joinSql, sql, type Sql } from '../sql';
import { assertClientTx, type ClientTx } from '../tx';
import {
  SEARCH_FILTER_FIELDS,
  parseSearchFilter,
  type DocumentSearchFilter,
  type SearchFilterField,
} from './searchFilter';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A model id (`claude-sonnet-5`): never free text. */
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * `question`: the guest's words, read by the model. `typed`: a filter from the
 * card's form. `page`: the next page of an earlier search (a typed filter with
 * a cursor).
 */
export type SearchQueryKind = 'question' | 'typed' | 'page';

/**
 * How a reserved search ended. `not_understood` and `unsupported` are the two
 * reasons of the `not_understood` answer; `unavailable` covers the model and
 * the index alike. A search refused before its reservation (no access,
 * disabled, rate limited) has no row.
 */
export type SearchQueryOutcome = 'ok' | 'help' | 'not_understood' | 'unsupported' | 'unavailable';

export type SearchQuotaName =
  | 'user_questions_5m'
  | 'user_questions_24h'
  | 'user_typed_5m'
  | 'client_questions_24h';

/** One durable rate limit: at most `max` searches of `kinds` in any `windowSeconds`. */
export interface SearchQuota {
  readonly name: SearchQuotaName;
  /** Counted per asker (`user_oid`, within the client), or for the whole client. */
  readonly per: 'user' | 'client';
  readonly kinds: readonly SearchQueryKind[];
  readonly max: number;
  readonly windowSeconds: number;
}

/**
 * The durable limits, across every worker. Questions cost a model call, so
 * they have their own, tighter windows, and the client's daily one bounds
 * what one client's guests can spend together. A question the model did not
 * understand still counts. Typed and page requests cost no model call.
 */
export const SEARCH_QUOTAS: readonly SearchQuota[] = [
  { name: 'user_questions_5m', per: 'user', kinds: ['question'], max: 10, windowSeconds: 300 },
  {
    name: 'user_questions_24h',
    per: 'user',
    kinds: ['question'],
    max: 60,
    windowSeconds: 86_400,
  },
  { name: 'user_typed_5m', per: 'user', kinds: ['typed', 'page'], max: 30, windowSeconds: 300 },
  {
    name: 'client_questions_24h',
    per: 'client',
    kinds: ['question'],
    max: 300,
    windowSeconds: 86_400,
  },
];

/**
 * The class of the advisory lock {@link reserve} takes (two-key form, so it
 * never meets the migration runner's one-key lock). Any constant, as long as
 * it never changes while two builds run side by side.
 */
export const SEARCH_LOCK_CLASS = 0x5345_4152;

export interface SearchReservation {
  /** A fresh UUID minted by the caller: the row's key, and what it logs. */
  readonly queryId: string;
  /** The asker's Entra object id (any case). */
  readonly userOid: string;
  readonly kind: SearchQueryKind;
}

export type ReserveResult =
  | { readonly status: 'ok' }
  | {
      readonly status: 'rate_limited';
      /** Seconds until every limit this search hit has room again (at least 1). */
      readonly retryAfterSeconds: number;
      /** The limit that frees last. */
      readonly quota: SearchQuotaName;
    };

const reservationSchema = z
  .object({
    queryId: z.string().regex(UUID),
    userOid: z
      .string()
      .regex(GUID)
      .transform((v) => v.toLowerCase()),
    kind: z.enum(['question', 'typed', 'page']),
  })
  .strict();

/** The rows of the quota's window, for the transaction's client (and the asker). */
function windowOf(tx: ClientTx, quota: SearchQuota, userOid: string): Sql {
  const conditions: Sql[] = [
    sql`client_id = ${tx.clientId}`,
    sql`kind = ANY(${[...quota.kinds]}::text[])`,
    sql`created_at > now() - make_interval(secs => ${quota.windowSeconds})`,
  ];
  if (quota.per === 'user') conditions.push(sql`user_oid = ${userOid}::uuid`);
  return joinSql(conditions, sql` AND `);
}

/** The lock key of a client: the first 32 bits of its UUID (hash bits, for a UUIDv5). */
function lockKeyOf(clientId: string): number {
  return Number.parseInt(clientId.slice(0, 8), 16) | 0;
}

/**
 * Reserves a search against the durable limits ({@link SEARCH_QUOTAS}) and
 * records it as `started`; or, over a limit, records nothing and says when to
 * try again. Call it before anything paid, in the client's own (read-write)
 * transaction, after `clientsRepo.upsertFromDirectory` (the row's foreign key).
 *
 * Concurrent reservations of one client, on any worker, are serialised by a
 * transaction-scoped advisory lock on the client — every window reserve
 * counts, the asker's and the client's, lies within that client's scope — and
 * each count runs after the lock, so under READ COMMITTED it sees every
 * reservation committed before it: two requests at 9 of 10 cannot both pass.
 * The lock ends with the transaction.
 */
export async function reserve(tx: ClientTx, input: SearchReservation): Promise<ReserveResult> {
  assertClientTx(tx);
  const parsed = reservationSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new LedgerDbError('invalid_record', `the search reservation is invalid: ${fields}`);
  }
  const r = parsed.data;
  await tx.query(
    sql`SELECT pg_advisory_xact_lock(${SEARCH_LOCK_CLASS}::int, ${lockKeyOf(tx.clientId)}::int)`,
  );
  let limited: { readonly quota: SearchQuotaName; readonly seconds: number } | null = null;
  for (const quota of SEARCH_QUOTAS) {
    if (!quota.kinds.includes(r.kind)) continue;
    const window = windowOf(tx, quota, r.userOid);
    const counted = await tx.query<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ledger.search_queries WHERE ${window}`,
    );
    const used = counted[0]?.n ?? 0;
    if (used < quota.max) continue;
    // Room again once the (used - max + 1)th oldest row leaves the window.
    const oldest = await tx.query<{ seconds: number }>(sql`
      SELECT greatest(1, ceil(extract(epoch FROM
        created_at + make_interval(secs => ${quota.windowSeconds}) - now())))::int AS seconds
      FROM ledger.search_queries WHERE ${window}
      ORDER BY created_at, query_id
      OFFSET ${used - quota.max} LIMIT 1`);
    const seconds = oldest[0]?.seconds ?? quota.windowSeconds;
    if (!limited || seconds > limited.seconds) limited = { quota: quota.name, seconds };
  }
  if (limited) {
    return { status: 'rate_limited', retryAfterSeconds: limited.seconds, quota: limited.quota };
  }
  await tx.query(sql`
    INSERT INTO ledger.search_queries (query_id, client_id, user_oid, kind)
    VALUES (${r.queryId}, ${tx.clientId}, ${r.userOid}, ${r.kind})`);
  return { status: 'ok' };
}

/** The model's token counts of one search (all four, cache included). */
export interface SearchTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** What a finished search leaves in its row: codes, a hash, field names and counts only. */
export interface SearchQueryFinish {
  readonly queryId: string;
  readonly outcome: SearchQueryOutcome;
  /** From {@link filterDigest}: never the filter itself. */
  readonly filterSha256?: string;
  readonly filterFields?: readonly SearchFilterField[];
  readonly resultCount?: number;
  /** Only when a model was called. */
  readonly model?: string;
  readonly tokens?: SearchTokenUsage;
  readonly latencyMs?: number;
}

const count = z.number().int().min(0).max(2_147_483_647);

const finishSchema = z
  .object({
    queryId: z.string().regex(UUID),
    outcome: z.enum(['ok', 'help', 'not_understood', 'unsupported', 'unavailable']),
    filterSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    filterFields: z.array(z.enum(SEARCH_FILTER_FIELDS)).max(SEARCH_FILTER_FIELDS.length).optional(),
    resultCount: count.optional(),
    model: z.string().regex(MODEL).optional(),
    tokens: z
      .object({
        inputTokens: count,
        outputTokens: count,
        cacheReadTokens: count,
        cacheWriteTokens: count,
      })
      .strict()
      .optional(),
    latencyMs: count.optional(),
  })
  .strict();

/**
 * Records how a reserved search ended: once, on a row still `started` in the
 * transaction's client. Returns `false` when there is no such row (finished
 * already, another client's, never reserved). Best effort for the caller: a
 * failure here must never change the answer the asker gets.
 */
export async function finish(tx: ClientTx, input: SearchQueryFinish): Promise<boolean> {
  assertClientTx(tx);
  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new LedgerDbError('invalid_record', `the search record is invalid: ${fields}`);
  }
  const f = parsed.data;
  const rows = await tx.query<{ query_id: string }>(sql`
    UPDATE ledger.search_queries SET
      outcome = ${f.outcome},
      filter_sha256 = ${f.filterSha256 ?? null},
      filter_fields = ${[...new Set(f.filterFields ?? [])].sort()}::text[],
      result_count = ${f.resultCount ?? null},
      model = ${f.model ?? null},
      input_tokens = ${f.tokens?.inputTokens ?? null},
      output_tokens = ${f.tokens?.outputTokens ?? null},
      cache_read_tokens = ${f.tokens?.cacheReadTokens ?? null},
      cache_write_tokens = ${f.tokens?.cacheWriteTokens ?? null},
      latency_ms = ${f.latencyMs ?? null}
    WHERE client_id = ${tx.clientId} AND query_id = ${f.queryId} AND outcome = 'started'
    RETURNING query_id::text AS query_id`);
  return rows.length > 0;
}

/** What a `search_queries` row keeps of a filter. */
export interface FilterDigest {
  /** Hex SHA-256 of the checked, normalised filter (keys and list values sorted). */
  readonly filterSha256: string;
  /** The names of the fields it sets, sorted. */
  readonly filterFields: SearchFilterField[];
}

/**
 * The filter's digest for {@link finish}: a hash and field names, never a
 * value. The filter is checked and normalised first (`invalid_filter`
 * otherwise), so two spellings of one filter hash alike.
 */
export function filterDigest(filter: DocumentSearchFilter): FilterDigest {
  const f = parseSearchFilter(filter);
  const filterFields = SEARCH_FILTER_FIELDS.filter((k) => f[k] !== undefined);
  const canonical = filterFields.map((k) => {
    const value = f[k];
    return [k, Array.isArray(value) ? [...new Set(value)].sort() : value];
  });
  const filterSha256 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { filterSha256, filterFields };
}
