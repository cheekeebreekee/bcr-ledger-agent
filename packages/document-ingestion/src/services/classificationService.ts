import {
  buildFolderPath,
  ClassificationError,
  createLogger,
  FALLBACK_CATEGORY,
  getCategory,
  isNoResult,
  isRetryLater,
  type Classification,
  type ClassificationUsage,
  type Classifier,
  type ClassifierContext,
  type ClassifierResult,
  type Logger,
} from '@bcr/shared';
import type { AcceptanceDecision, AcceptancePolicy } from './acceptancePolicy';

/**
 * Always succeeds, and always for review: the document goes to
 * `98_Nieposortowane` because nothing could classify it.
 */
export class FallbackClassifier implements Classifier {
  readonly name = 'fallback-unsorted';
  async classify(ctx: ClassifierContext): Promise<Classification> {
    const now = new Date();
    const def = getCategory(FALLBACK_CATEGORY);
    return {
      documentType: def.polishLabel,
      folderPath: buildFolderPath(FALLBACK_CATEGORY, {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      }),
      confidence: 0.1,
      classifier: this.name,
      reviewReasons: ['NOT_CLASSIFIED'],
      fields: {
        category: FALLBACK_CATEGORY,
        filename: ctx.filename,
        reasoning:
          'Nie udało się pewnie rozpoznać typu dokumentu, więc trafił do folderu ' +
          '„Nieposortowane” do ręcznej weryfikacji przez księgowego.',
      },
    };
  }
}

/**
 * What classification decided for one document:
 *  - `decided`: file it where {@link AcceptanceDecision} says (its category,
 *    or `98_Nieposortowane` for review);
 *  - `retry_later`: a classifier could not answer now (429, 529, 5xx, a
 *    timeout, …). Nothing may be filed: the bot path hands the document back
 *    with `RetryLater`, the channel inbox leaves it for the next tick.
 */
export type ClassificationOutcome =
  | { readonly kind: 'decided'; readonly decision: AcceptanceDecision }
  | {
      readonly kind: 'retry_later';
      readonly classifier: string;
      readonly reason: string;
      readonly status?: number;
    };

export interface ClassificationServiceOptions {
  /** The one place a threshold or review reason is applied. */
  readonly policy: AcceptancePolicy;
  /** Defaults to the wall clock; the review folder is this month's. */
  readonly now?: () => Date;
  /** Injected in tests; defaults to the `ingestion/classificationService` logger. */
  readonly log?: Logger;
}

/**
 * Runs the classifiers in order and takes the first one with an answer; the
 * acceptance policy then decides where it is filed. A classifier with no
 * answer (`null`, `no_result`) hands over to the next — ending with the
 * fallback, which files for review. A classifier that says `retry_later`
 * stops the chain: a transient failure is never a reason to file a
 * classifiable document for review.
 */
export class ClassificationService {
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(
    private readonly classifiers: readonly Classifier[],
    private readonly opts: ClassificationServiceOptions,
  ) {
    if (classifiers.length === 0) {
      throw new ClassificationError('ClassificationService needs at least one classifier');
    }
    this.log = opts.log ?? createLogger('ingestion/classificationService');
    this.now = opts.now ?? (() => new Date());
  }

  /** `now` sets the review folder's month; callers with their own clock pass it. */
  async classify(ctx: ClassifierContext, now: Date = this.now()): Promise<ClassificationOutcome> {
    let unclassifiedReason: string | undefined;
    // A billed response the classifier could not use: its cost stays on the decision.
    let noResultUsage: ClassificationUsage | undefined;
    for (const c of this.classifiers) {
      let result: ClassifierResult;
      try {
        result = await c.classify(ctx);
      } catch (err) {
        this.log.warn(
          { classifier: c.name, err: err instanceof Error ? { name: err.name } : {} },
          'classifier failed, continuing',
        );
        continue;
      }
      if (isRetryLater(result)) {
        return {
          kind: 'retry_later',
          classifier: c.name,
          reason: result.reason,
          ...(result.status !== undefined ? { status: result.status } : {}),
        };
      }
      if (result === null) continue;
      if (isNoResult(result)) {
        unclassifiedReason ??= result.reason;
        noResultUsage ??= result.usage;
        continue;
      }
      const withReason =
        unclassifiedReason && result.reviewReasons?.includes('NOT_CLASSIFIED')
          ? { ...result, fields: { ...result.fields, unclassifiedReason } }
          : result;
      const withUsage =
        noResultUsage && !withReason.usage ? { ...withReason, usage: noResultUsage } : withReason;
      return { kind: 'decided', decision: this.opts.policy.decide(withUsage, now) };
    }
    throw new ClassificationError(`No classifier produced a result for ${ctx.filename}`);
  }
}
