import {
  DOCUMENT_EXTRACTION_FIELDS,
  getCategory,
  invoiceCategoryForDirection,
  type ClassifierContext,
  type DocumentCategory,
  type DocumentExtractionField,
} from '@bcr/shared';
import { retryExhaustedDecision, type AcceptanceDecision } from '../services/acceptancePolicy';
import { MAX_RETRY_LATER_ATTEMPTS } from '../services/batchIngestor';
import type { ClassificationOutcome } from '../services/classificationService';
import type { ClaudeUsage } from '../services/claudeClassifier';
import { isDirectedInvoice } from '../services/invoiceDirection';
import { RetryLaterBound } from '../services/retryLaterBound';
import { FIELD_COMPARATORS, INVOICE_FAMILY, type TruthEntry } from './truth';

/** What classified one document: the real service, with a per-document usage sink. */
export type ServiceFactory = (onUsage: (usage: ClaudeUsage) => void) => {
  classify(ctx: ClassifierContext, now?: Date): Promise<ClassificationOutcome>;
};

export interface RunOptions {
  readonly entries: readonly TruthEntry[];
  /** Reads one document of the `--dir` folder by its truth file name. */
  readonly readDocument: (file: string) => Promise<Buffer>;
  readonly makeService: ServiceFactory;
  /** The client's own identity, primed as ingestion would for a bound row. */
  readonly client?: { readonly nip: string; readonly companyName: string };
  /** Documents classified at once. Default 2. */
  readonly concurrency?: number;
  /**
   * Extra passes over documents that came back "retry later". Default 2: with
   * the first, as many sends as the bot path allows a document before it files
   * it for review (`RETRY_EXHAUSTED`).
   */
  readonly retryPasses?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /** Called after each document, for progress. */
  readonly onProgress?: (done: number, total: number) => void;
}

export type DirectionVerdict = 'correct' | 'unresolved' | 'wrong' | 'not_scored';

export interface DocumentResult {
  readonly truth: TruthEntry;
  /**
   * `answered`: the model classified it; `no_result`: the fallback did;
   * `retry_exhausted`: a timeout, 5xx or lost connection on every pass up to
   * the bot path's bound, so filed for review as production would; the rest
   * filed nothing.
   */
  readonly outcome: 'answered' | 'no_result' | 'retry_exhausted' | 'retry_later' | 'unreadable';
  readonly decision?: AcceptanceDecision;
  /** The category the model suggested, before the policy (answered only). */
  readonly suggested?: string;
  /** `retry_later`, `retry_exhausted` or `no_result`: the code. */
  readonly reason?: string;
  readonly status?: number;
  readonly categoryCorrect?: boolean;
  readonly direction: DirectionVerdict;
  /** Undefined when the truth has no month, or nothing was answered. */
  readonly monthCorrect?: boolean;
  /** Filed under the right category (and direction and month, where they apply). */
  readonly filedCorrectly: boolean;
  /** Filed under a category that is not the truth's: a mis-filing. */
  readonly filedWrongly: boolean;
  /**
   * Per invoice field the truth gives: whether the extraction read it right.
   * Answered documents only; a field the model left `null` is a miss.
   */
  readonly fields?: Readonly<Partial<Record<DocumentExtractionField, boolean>>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
}

/**
 * Classifies every labelled document with the real classification service
 * (Claude and the acceptance policy) and scores it. Documents that come back
 * "retry later" are tried again after a pause, up to `retryPasses` times,
 * each pass counting like a resend on the bot path: a document that gets a
 * timeout, 5xx or lost connection on {@link MAX_RETRY_LATER_ATTEMPTS} passes
 * is scored as filed for review (`RETRY_EXHAUSTED`), as the bot path would
 * file it. Whatever is still "retry later" after the last pass (429, 529,
 * too few passes) is reported as such, never as a classification.
 */
export async function runEvaluation(opts: RunOptions): Promise<DocumentResult[]> {
  const results = new Map<string, DocumentResult>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bound = new RetryLaterBound({ maxAttempts: MAX_RETRY_LATER_ATTEMPTS });
  let pending = [...opts.entries];
  const passes = 1 + Math.max(0, opts.retryPasses ?? 2);
  let done = 0;
  for (let pass = 0; pass < passes && pending.length > 0; pass += 1) {
    if (pass > 0) await sleep(opts.retryDelayMs ?? 30_000);
    await pool(pending, Math.max(1, opts.concurrency ?? 2), async (entry) => {
      results.set(entry.file, await classifyOne(entry, opts, bound));
      if (pass === 0) opts.onProgress?.((done += 1), opts.entries.length);
    });
    pending = pending.filter((e) => results.get(e.file)?.outcome === 'retry_later');
  }
  return opts.entries.map((e) => results.get(e.file) as DocumentResult);
}

async function classifyOne(
  truth: TruthEntry,
  opts: RunOptions,
  bound: RetryLaterBound,
): Promise<DocumentResult> {
  let content: Buffer;
  try {
    content = await opts.readDocument(truth.file);
  } catch {
    return blank(truth, 'unreadable');
  }
  const usage = { inputTokens: 0, outputTokens: 0, model: '' };
  const service = opts.makeService((u) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.model = u.model;
  });
  const now = (opts.now ?? (() => new Date()))();
  const outcome = await service.classify(
    {
      filename: truth.file,
      contentType: contentTypeOf(truth.file),
      readContent: async () => content,
      ...(opts.client ? { client: opts.client } : {}),
    },
    now,
  );
  if (outcome.kind === 'retry_later') {
    const status = outcome.status !== undefined ? { status: outcome.status } : {};
    if (bound.record(truth.file, outcome.reason, outcome.status, now.getTime()).exhausted) {
      const decision = retryExhaustedDecision(now, outcome.reason);
      return { ...score(truth, decision, opts.client !== undefined), ...usage, ...status };
    }
    return { ...blank(truth, 'retry_later'), ...usage, reason: outcome.reason, ...status };
  }
  return { ...score(truth, outcome.decision, opts.client !== undefined), ...usage };
}

function blank(truth: TruthEntry, outcome: DocumentResult['outcome']): DocumentResult {
  return {
    truth,
    outcome,
    direction: 'not_scored',
    filedCorrectly: false,
    filedWrongly: false,
    inputTokens: 0,
    outputTokens: 0,
    model: '',
  };
}

/** Scores one decision against its truth. Exported for tests. */
export function score(
  truth: TruthEntry,
  decision: AcceptanceDecision,
  identityGiven: boolean,
): DocumentResult {
  const base = {
    truth,
    decision,
    inputTokens: 0,
    outputTokens: 0,
    model: decision.model,
  };
  const unanswered = decision.reviewReasons.includes('NOT_CLASSIFIED')
    ? 'no_result'
    : decision.reviewReasons.includes('RETRY_EXHAUSTED')
      ? 'retry_exhausted'
      : undefined;
  if (unanswered) {
    return {
      ...base,
      outcome: unanswered,
      ...(decision.unclassifiedReason ? { reason: decision.unclassifiedReason } : {}),
      direction: 'not_scored',
      filedCorrectly: false,
      filedWrongly: false,
    };
  }

  const suggested: string = decision.review
    ? (decision.suggestedCategory ?? decision.category)
    : decision.category;
  const categoryCorrect = family(suggested) === family(truth.category);
  const direction = directionVerdict(truth, decision, identityGiven);
  const monthCorrect = truth.month ? decision.month === truth.month : undefined;
  const fields = scoreFields(truth, decision);
  const dated = getCategory(decision.category).dated;
  const filedCorrectly =
    !decision.review &&
    categoryCorrect &&
    (truth.direction ? decision.category === invoiceCategoryForDirection(truth.direction) : true) &&
    (dated && truth.month ? monthCorrect === true : true);
  return {
    ...base,
    outcome: 'answered',
    suggested,
    categoryCorrect,
    direction,
    ...(monthCorrect !== undefined ? { monthCorrect } : {}),
    filedCorrectly,
    filedWrongly: !decision.review && !filedCorrectly,
    ...(fields ? { fields } : {}),
  };
}

/** Each field the truth gives, compared the way the truth was normalised. */
function scoreFields(
  truth: TruthEntry,
  decision: AcceptanceDecision,
): Partial<Record<DocumentExtractionField, boolean>> | undefined {
  if (!truth.fields) return undefined;
  const out: Partial<Record<DocumentExtractionField, boolean>> = {};
  for (const field of DOCUMENT_EXTRACTION_FIELDS) {
    const expected = truth.fields[field];
    if (expected === undefined) continue;
    const read = decision.extraction?.[field] ?? null;
    out[field] = read !== null && FIELD_COMPARATORS[field](read) === expected;
  }
  return out;
}

function directionVerdict(
  truth: TruthEntry,
  decision: AcceptanceDecision,
  identityGiven: boolean,
): DirectionVerdict {
  if (!identityGiven || !truth.direction) return 'not_scored';
  if (decision.reviewReasons.includes('DIRECTION_UNRESOLVED')) return 'unresolved';
  const settled: DocumentCategory | undefined = decision.review
    ? decision.suggestedCategory
    : decision.category;
  if (!isDirectedInvoice(settled)) return 'not_scored';
  return settled === invoiceCategoryForDirection(truth.direction) ? 'correct' : 'wrong';
}

function family(category: string): string {
  return category === 'faktury_sprzedazy' || category === 'faktury_zakupu'
    ? INVOICE_FAMILY
    : category;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
};

/** The content type ingestion would see for a file of this extension. */
export function contentTypeOf(file: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item as T);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface Ratio {
  readonly hit: number;
  readonly of: number;
}

export interface EvaluationSummary {
  readonly documents: number;
  readonly answered: number;
  readonly noResult: number;
  /** Filed for review after a timeout, 5xx or lost connection on every pass. */
  readonly retryExhausted: number;
  readonly retryLater: number;
  readonly unreadable: number;
  readonly category: Ratio;
  readonly perCategory: readonly {
    readonly category: string;
    readonly documents: number;
    readonly answered: number;
    readonly correct: number;
    readonly review: number;
    readonly filedWrongly: number;
  }[];
  /** `undefined` without a client identity: direction is not measured then. */
  readonly direction?: {
    readonly scored: number;
    readonly correct: number;
    readonly unresolved: number;
    readonly wrong: number;
  };
  readonly month: Ratio;
  /** Documents filed in 98_ for review, of those that were filed at all. */
  readonly review: Ratio;
  readonly filedCorrectly: number;
  readonly filedWrongly: number;
  readonly confidenceBuckets: readonly ({ readonly label: string } & Ratio)[];
  /**
   * Extraction accuracy per invoice field, over the answered documents whose
   * truth gives that field. Fields no truth gives are left out.
   */
  readonly extraction: readonly ({ readonly field: DocumentExtractionField } & Ratio)[];
  readonly reasons: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const BUCKETS: readonly [string, number, number][] = [
  ['< 0.50', 0, 0.5],
  ['0.50-0.69', 0.5, 0.7],
  ['0.70-0.79', 0.7, 0.8],
  ['0.80-0.89', 0.8, 0.9],
  ['0.90-1.00', 0.9, 1.01],
];

export function summarize(
  results: readonly DocumentResult[],
  identityGiven: boolean,
): EvaluationSummary {
  const answered = results.filter((r) => r.outcome === 'answered');
  const decided = results.filter((r) => r.decision !== undefined);
  const reasons: Record<string, number> = {};
  for (const r of results) {
    for (const reason of r.decision?.reviewReasons ?? [])
      reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const categories = [...new Set(results.map((r) => r.truth.category))].sort();
  const directionScored = results.filter((r) => r.direction !== 'not_scored');
  const monthChecked = answered.filter((r) => r.monthCorrect !== undefined);
  return {
    documents: results.length,
    answered: answered.length,
    noResult: results.filter((r) => r.outcome === 'no_result').length,
    retryExhausted: results.filter((r) => r.outcome === 'retry_exhausted').length,
    retryLater: results.filter((r) => r.outcome === 'retry_later').length,
    unreadable: results.filter((r) => r.outcome === 'unreadable').length,
    category: { hit: answered.filter((r) => r.categoryCorrect).length, of: answered.length },
    perCategory: categories.map((category) => {
      const of = results.filter((r) => r.truth.category === category);
      return {
        category,
        documents: of.length,
        answered: of.filter((r) => r.outcome === 'answered').length,
        correct: of.filter((r) => r.categoryCorrect).length,
        review: of.filter((r) => r.decision?.review).length,
        filedWrongly: of.filter((r) => r.filedWrongly).length,
      };
    }),
    ...(identityGiven
      ? {
          direction: {
            scored: directionScored.length,
            correct: directionScored.filter((r) => r.direction === 'correct').length,
            unresolved: directionScored.filter((r) => r.direction === 'unresolved').length,
            wrong: directionScored.filter((r) => r.direction === 'wrong').length,
          },
        }
      : {}),
    month: { hit: monthChecked.filter((r) => r.monthCorrect).length, of: monthChecked.length },
    review: { hit: decided.filter((r) => r.decision?.review).length, of: decided.length },
    filedCorrectly: results.filter((r) => r.filedCorrectly).length,
    filedWrongly: results.filter((r) => r.filedWrongly).length,
    confidenceBuckets: BUCKETS.map(([label, lo, hi]) => {
      const inBucket = answered.filter(
        (r) => (r.decision?.confidence ?? 0) >= lo && (r.decision?.confidence ?? 0) < hi,
      );
      return { label, hit: inBucket.filter((r) => r.categoryCorrect).length, of: inBucket.length };
    }),
    extraction: DOCUMENT_EXTRACTION_FIELDS.map((field) => {
      const scored = answered.filter((r) => r.fields?.[field] !== undefined);
      return { field, hit: scored.filter((r) => r.fields?.[field]).length, of: scored.length };
    }).filter((f) => f.of > 0),
    reasons,
    inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: results.reduce((n, r) => n + r.outputTokens, 0),
  };
}
