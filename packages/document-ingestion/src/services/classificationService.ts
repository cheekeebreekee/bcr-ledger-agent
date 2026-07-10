import {
  buildFolderPath,
  ClassificationError,
  createLogger,
  FALLBACK_CATEGORY,
  getCategory,
  type Classification,
  type Classifier,
  type ClassifierContext,
} from '@bcr/shared';

/** Always succeeds — routes uncategorised files into the manual-review folder. */
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
      fields: {
        filename: ctx.filename,
        reasoning:
          'Nie udało się pewnie rozpoznać typu dokumentu, więc trafił do folderu ' +
          '„Nieposortowane” do ręcznej weryfikacji przez księgowego.',
      },
    };
  }
}

export interface ClassificationServiceOptions {
  /** Confidence at/above which we accept a result and stop trying others. */
  readonly acceptanceThreshold?: number;
}

/**
 * Runs a sequence of classifiers and returns the first high-confidence
 * result. Lower-confidence results are kept and the best one is returned
 * if nothing meets the threshold.
 */
export class ClassificationService {
  private readonly log = createLogger('ingestion/classificationService');
  private readonly threshold: number;

  constructor(
    private readonly classifiers: readonly Classifier[],
    opts: ClassificationServiceOptions = {},
  ) {
    if (classifiers.length === 0) {
      throw new ClassificationError('ClassificationService needs at least one classifier');
    }
    this.threshold = opts.acceptanceThreshold ?? 0.8;
  }

  async classify(ctx: ClassifierContext): Promise<Classification> {
    let best: Classification | null = null;
    for (const c of this.classifiers) {
      try {
        const result = await c.classify(ctx);
        if (!result) continue;
        this.log.debug(
          { classifier: c.name, confidence: result.confidence, folderPath: result.folderPath },
          'classifier result',
        );
        if (result.confidence >= this.threshold) return result;
        if (!best || result.confidence > best.confidence) best = result;
      } catch (err) {
        this.log.warn({ err, classifier: c.name }, 'classifier failed, continuing');
      }
    }
    if (best) return best;
    throw new ClassificationError(`No classifier produced a result for ${ctx.filename}`);
  }
}
