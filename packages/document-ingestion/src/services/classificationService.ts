import {
  ClassificationError,
  createLogger,
  defaultFilenameParser,
  type Classification,
  type Classifier,
  type ClassifierContext,
  type PatternRegistry,
} from '@bcr/shared';

/**
 * Filename-regex classifier. Wraps the shared {@link PatternRegistry} as a
 * `Classifier` so it composes naturally with content-based strategies.
 */
export class FilenameRegexClassifier implements Classifier {
  readonly name = 'filename-regex';
  constructor(private readonly parser: PatternRegistry = defaultFilenameParser) {}

  async classify(ctx: ClassifierContext): Promise<Classification | null> {
    const parsed = this.parser.parse(ctx.filename);
    if (!parsed.matched || !parsed.folderPath || !parsed.documentType) return null;
    return {
      documentType: parsed.documentType,
      folderPath: parsed.folderPath,
      confidence: parsed.confidence,
      classifier: this.name,
      fields: parsed.fields,
    };
  }
}

/** Always succeeds — routes uncategorised files into a "needs review" folder. */
export class FallbackClassifier implements Classifier {
  readonly name = 'fallback-unsorted';
  async classify(ctx: ClassifierContext): Promise<Classification> {
    const now = new Date();
    const year = String(now.getUTCFullYear()).padStart(4, '0');
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return {
      documentType: 'Unknown',
      folderPath: `Unsorted/${year}/${month}`,
      confidence: 0.1,
      classifier: this.name,
      fields: { filename: ctx.filename },
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
