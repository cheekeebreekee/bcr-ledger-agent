import {
  buildFolderPath,
  CLASSIFICATION_ACCEPT_THRESHOLD_MAX,
  CLASSIFICATION_ACCEPT_THRESHOLD_MIN,
  ClassificationError,
  FALLBACK_CATEGORY,
  getCategory,
  isDocumentCategory,
  type Classification,
  type ClassificationUsage,
  type DocumentCategory,
  type DocumentExtraction,
} from '@bcr/shared';
import { DIRECTION_UNRESOLVED, isDirectedInvoice } from './invoiceDirection';

/**
 * Why a document went to `98_Nieposortowane` instead of its category, in the
 * order they are reported:
 *
 *  - `NOT_CLASSIFIED`: no classifier had an answer (Claude off, an
 *    unsupported or oversize file, a 400, malformed output, a refusal);
 *  - `PROCESSING_FAILED`: the channel inbox gave up after repeated failures;
 *  - `RETRY_EXHAUSTED`: the classifier answered "retry later" for a reason
 *    the document may cause (a timeout, a 5xx, a lost connection) up to the
 *    bound (`retryLaterBound.ts`); never for a 429, 529 or 401–404;
 *  - `UNKNOWN_CATEGORY`: a category the taxonomy does not have;
 *  - `MODEL_UNSORTED`: the model itself chose `nieposortowane`;
 *  - `DIRECTION_UNRESOLVED`: a sales or purchase invoice not tied to the
 *    client's own identity;
 *  - `DATE_MISSING`: a dated category without a usable year and month;
 *  - `LOW_CONFIDENCE`: below `CLASSIFICATION_ACCEPT_THRESHOLD`.
 */
export type ReviewReason =
  | 'NOT_CLASSIFIED'
  | 'PROCESSING_FAILED'
  | 'RETRY_EXHAUSTED'
  | 'UNKNOWN_CATEGORY'
  | 'MODEL_UNSORTED'
  | 'DIRECTION_UNRESOLVED'
  | 'DATE_MISSING'
  | 'LOW_CONFIDENCE';

const REASON_ORDER: readonly ReviewReason[] = [
  'NOT_CLASSIFIED',
  'PROCESSING_FAILED',
  'RETRY_EXHAUSTED',
  'UNKNOWN_CATEGORY',
  'MODEL_UNSORTED',
  'DIRECTION_UNRESOLVED',
  'DATE_MISSING',
  'LOW_CONFIDENCE',
];

/** Flags a classifier may raise for the policy to act on. */
const CLASSIFIER_FLAGS: ReadonlySet<string> = new Set<ReviewReason>([
  'NOT_CLASSIFIED',
  DIRECTION_UNRESOLVED,
]);

/** Where one document is filed, and why. Carries codes and taxonomy only. */
export interface AcceptanceDecision {
  /** `true`: filed in `98_Nieposortowane/YYYY/MM` for manual review. */
  readonly review: boolean;
  /** The category it is filed under: `nieposortowane` on review. */
  readonly category: DocumentCategory;
  /** Polish label of {@link category}, from the taxonomy. */
  readonly documentType: string;
  /** Taxonomy folder path, relative to the client's root: never a client or file name. */
  readonly folderPath: string;
  /** The classifier's confidence, on `[0, 1]`. */
  readonly confidence: number;
  readonly classifier: string;
  /** The model that answered, `''` when no model did. */
  readonly model: string;
  /** The document's month as the classifier read it, `YYYY-MM`, or `''`. */
  readonly month: string;
  /** Empty when filed under its category. */
  readonly reviewReasons: readonly ReviewReason[];
  /** On review: the category the classifier suggested, when it named a real one. */
  readonly suggestedCategory?: DocumentCategory;
  /**
   * With `NOT_CLASSIFIED`: why the model had no answer (`pdf_trim_failed`, …).
   * With `RETRY_EXHAUSTED`: the last retry-later reason (`timeout`, …).
   */
  readonly unclassifiedReason?: string;
  /**
   * The invoice fields the classifier read, carried through unchanged (filed
   * or for review) for the document index. The policy never looks at them.
   * Client data: {@link decisionLogFields} leaves them out.
   */
  readonly extraction?: DocumentExtraction;
  /** The tokens the model call was billed for, when a model answered. Counts only. */
  readonly usage?: ClassificationUsage;
}

/**
 * The only place a confidence threshold or a review reason is applied. Every
 * classification — on the bot path and in the channel inbox — passes through
 * {@link decide} before anything is written.
 *
 * A result is filed under its category only when the category is real, not
 * the review bucket, its date is usable if the category is dated, an invoice's
 * direction is settled, no classifier flagged it, and its confidence is at or
 * above the threshold. Anything else is filed in `98_Nieposortowane/YYYY/MM`
 * (this month) with the suggestion kept (category, month, confidence), so the
 * logs and the reviewer can see what the model thought.
 */
export class AcceptancePolicy {
  constructor(readonly threshold: number) {
    if (
      !Number.isFinite(threshold) ||
      threshold < CLASSIFICATION_ACCEPT_THRESHOLD_MIN ||
      threshold > CLASSIFICATION_ACCEPT_THRESHOLD_MAX
    ) {
      throw new ClassificationError(
        `The acceptance threshold must be from ${CLASSIFICATION_ACCEPT_THRESHOLD_MIN} to ` +
          `${CLASSIFICATION_ACCEPT_THRESHOLD_MAX}`,
      );
    }
  }

  decide(classification: Classification, now: Date): AcceptanceDecision {
    const reasons = new Set<ReviewReason>(
      (classification.reviewReasons ?? []).filter((r): r is ReviewReason =>
        CLASSIFIER_FLAGS.has(r),
      ),
    );
    const raw = classification.fields.category;
    const category = isDocumentCategory(raw) ? raw : undefined;
    const date = dateOf(classification);
    const confidence = clampConfidence(classification.confidence);

    if (!category) {
      reasons.add(raw === undefined ? 'NOT_CLASSIFIED' : 'UNKNOWN_CATEGORY');
    } else if (category === FALLBACK_CATEGORY) {
      if (reasons.size === 0) reasons.add('MODEL_UNSORTED');
    } else {
      if (
        isDirectedInvoice(category) &&
        classification.fields.direction !== directionOf(category)
      ) {
        reasons.add('DIRECTION_UNRESOLVED');
      }
      if (getCategory(category).dated && !date) reasons.add('DATE_MISSING');
      if (confidence < this.threshold) reasons.add('LOW_CONFIDENCE');
    }

    const base = {
      confidence,
      classifier: classification.classifier,
      model: classification.model ?? '',
      month: date ? `${date.year}-${String(date.month).padStart(2, '0')}` : '',
      ...(classification.extraction ? { extraction: classification.extraction } : {}),
      ...(classification.usage ? { usage: classification.usage } : {}),
    };
    if (reasons.size === 0 && category) {
      const folderPath = getCategory(category).dated
        ? buildFolderPath(category, date)
        : buildFolderPath(category);
      return {
        ...base,
        review: false,
        category,
        documentType: getCategory(category).polishLabel,
        folderPath,
        reviewReasons: [],
      };
    }

    const unclassifiedReason = classification.fields.unclassifiedReason;
    return {
      ...base,
      ...reviewPlacement(now),
      reviewReasons: REASON_ORDER.filter((r) => reasons.has(r)),
      ...(category && category !== FALLBACK_CATEGORY ? { suggestedCategory: category } : {}),
      ...(reasons.has('NOT_CLASSIFIED') && typeof unclassifiedReason === 'string'
        ? { unclassifiedReason }
        : {}),
    };
  }
}

/**
 * The channel inbox's last resort after repeated processing failures: review,
 * unclassified, for the month of `now`.
 */
export function processingFailedDecision(now: Date): AcceptanceDecision {
  return unclassifiedDecision(now, 'PROCESSING_FAILED');
}

/**
 * A document the classifier kept answering "retry later" for, for a reason
 * the document may cause, up to the bound: review, unclassified, for the month
 * of `now`, with the last reason (`timeout`, `server_error`, `connection`).
 */
export function retryExhaustedDecision(now: Date, lastReason: string): AcceptanceDecision {
  return { ...unclassifiedDecision(now, 'RETRY_EXHAUSTED'), unclassifiedReason: lastReason };
}

function unclassifiedDecision(now: Date, reason: ReviewReason): AcceptanceDecision {
  return {
    ...reviewPlacement(now),
    confidence: 0,
    classifier: '',
    model: '',
    month: '',
    reviewReasons: [reason],
  };
}

/** `98_Nieposortowane/YYYY/MM` for the month of `now` (UTC). */
export function reviewFolderPath(now: Date): string {
  return buildFolderPath(FALLBACK_CATEGORY, {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  });
}

/**
 * The fields every filing log line carries: codes and the taxonomy path only.
 * Never a file name, the client's channel folder, a party, the invoice fields
 * or the model's text.
 */
export function decisionLogFields(decision: AcceptanceDecision): Record<string, unknown> {
  return {
    category: decision.category,
    ...(decision.suggestedCategory ? { suggestedCategory: decision.suggestedCategory } : {}),
    confidence: Math.round(decision.confidence * 100) / 100,
    classifier: decision.classifier,
    model: decision.model,
    month: decision.month,
    reviewReasons: decision.reviewReasons,
    ...(decision.unclassifiedReason ? { unclassifiedReason: decision.unclassifiedReason } : {}),
    folder: decision.folderPath,
    // What this document's classification cost, for the per-document bill.
    ...(decision.usage
      ? {
          inputTokens: decision.usage.inputTokens,
          outputTokens: decision.usage.outputTokens,
          cacheReadInputTokens: decision.usage.cacheReadInputTokens,
          cacheCreationInputTokens: decision.usage.cacheCreationInputTokens,
        }
      : {}),
  };
}

function reviewPlacement(now: Date) {
  return {
    review: true,
    category: FALLBACK_CATEGORY,
    documentType: getCategory(FALLBACK_CATEGORY).polishLabel,
    folderPath: reviewFolderPath(now),
  } as const;
}

function directionOf(category: 'faktury_sprzedazy' | 'faktury_zakupu'): string {
  return category === 'faktury_sprzedazy' ? 'sprzedaz' : 'zakup';
}

function dateOf(c: Classification): { year: number; month: number } | undefined {
  const { year, month } = c.fields;
  if (
    typeof year === 'number' &&
    Number.isInteger(year) &&
    year >= 1000 &&
    year <= 9999 &&
    typeof month === 'number' &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
  ) {
    return { year, month };
  }
  return undefined;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
