import { categoryCatalog, ClassificationError, type Classification } from '@bcr/shared';
import {
  AcceptancePolicy,
  decisionLogFields,
  processingFailedDecision,
  retryExhaustedDecision,
  reviewFolderPath,
} from './acceptancePolicy';

const NOW = new Date('2026-09-26T10:00:00.000Z');
const policy = new AcceptancePolicy(0.7);

function result(
  fields: Classification['fields'],
  over: Partial<Classification> = {},
): Classification {
  return {
    documentType: 'x',
    folderPath: '../../Other Client/Shared Documents',
    confidence: 0.9,
    classifier: 'claude',
    model: 'claude-opus-5',
    fields,
    ...over,
  };
}

const purchase = { category: 'faktury_zakupu', year: 2026, month: 8, direction: 'zakup' };

describe('AcceptancePolicy', () => {
  it('files a confident, dated, settled invoice under its category and month', () => {
    expect(policy.decide(result(purchase), NOW)).toEqual({
      review: false,
      category: 'faktury_zakupu',
      documentType: 'Faktura zakupu',
      folderPath: '01_Faktury/02_Faktury_zakupu/2026/08',
      confidence: 0.9,
      classifier: 'claude',
      model: 'claude-opus-5',
      month: '2026-08',
      reviewReasons: [],
    });
  });

  it('files an undated category without a month leaf, keeping the month it read', () => {
    const decision = policy.decide(result({ category: 'umowy', year: 2025, month: 3 }), NOW);
    expect(decision).toMatchObject({ review: false, folderPath: '04_Umowy', month: '2025-03' });
  });

  it('builds the folder from the category, never from the classifier’s folder path', () => {
    const decision = policy.decide(result({ category: 'umowy' }), NOW);
    expect(decision.folderPath).toBe('04_Umowy');
    expect(decision.month).toBe('');
  });

  it('files at exactly the threshold', () => {
    expect(policy.decide(result(purchase, { confidence: 0.7 }), NOW).review).toBe(false);
  });

  // The regression the threshold exists for: 0.69 is never filed under the
  // category it suggests, whichever category that is.
  it.each(categoryCatalog.filter((c) => c.id !== 'nieposortowane').map((c) => c.id))(
    'never files a 0.69 %s under its suggested category',
    (category) => {
      const decision = policy.decide(
        result(
          {
            category,
            year: 2026,
            month: 9,
            direction: category === 'faktury_sprzedazy' ? 'sprzedaz' : 'zakup',
          },
          {
            confidence: 0.69,
          },
        ),
        NOW,
      );
      expect(decision).toMatchObject({
        review: true,
        category: 'nieposortowane',
        folderPath: '98_Nieposortowane/2026/09',
        suggestedCategory: category,
        confidence: 0.69,
        month: '2026-09',
      });
      expect(decision.reviewReasons).toContain('LOW_CONFIDENCE');
    },
  );

  it('sends an invoice whose direction is not settled to review, keeping the suggestion', () => {
    const decision = policy.decide(
      result(
        { category: 'faktury_sprzedazy', year: 2026, month: 7 },
        { confidence: 0.5, reviewReasons: ['DIRECTION_UNRESOLVED'] },
      ),
      NOW,
    );
    expect(decision).toMatchObject({
      review: true,
      suggestedCategory: 'faktury_sprzedazy',
      month: '2026-07',
      reviewReasons: ['DIRECTION_UNRESOLVED', 'LOW_CONFIDENCE'],
    });
  });

  it('refuses an invoice whose direction field disagrees with its folder, even when confident', () => {
    const decision = policy.decide(
      result({ category: 'faktury_sprzedazy', year: 2026, month: 7, direction: 'zakup' }),
      NOW,
    );
    expect(decision.reviewReasons).toEqual(['DIRECTION_UNRESOLVED']);
  });

  it.each([
    ['no year or month', {}],
    ['month 13', { year: 2026, month: 13 }],
    ['a string year', { year: '2026', month: 9 }],
    ['a three-digit year', { year: 999, month: 9 }],
  ])('sends a dated category with %s to review (DATE_MISSING)', (_label, date) => {
    const decision = policy.decide(result({ category: 'wyciagi_bankowe', ...date }), NOW);
    expect(decision).toMatchObject({
      review: true,
      reviewReasons: ['DATE_MISSING'],
      suggestedCategory: 'wyciagi_bankowe',
      month: '',
    });
  });

  it('keeps the model’s own review choice, with no suggested category', () => {
    const decision = policy.decide(
      result({ category: 'nieposortowane', year: 2025, month: 1 }),
      NOW,
    );
    expect(decision).toMatchObject({
      review: true,
      reviewReasons: ['MODEL_UNSORTED'],
      folderPath: '98_Nieposortowane/2026/09',
    });
    expect(decision.suggestedCategory).toBeUndefined();
  });

  it('reports the fallback classifier as NOT_CLASSIFIED, with why the model had no answer', () => {
    const decision = policy.decide(
      result(
        { category: 'nieposortowane', unclassifiedReason: 'pdf_trim_failed' },
        { classifier: 'fallback-unsorted', confidence: 0.1, reviewReasons: ['NOT_CLASSIFIED'] },
      ),
      NOW,
    );
    expect(decision).toMatchObject({
      review: true,
      reviewReasons: ['NOT_CLASSIFIED'],
      unclassifiedReason: 'pdf_trim_failed',
      classifier: 'fallback-unsorted',
    });
  });

  it('reports a result without any category as NOT_CLASSIFIED, and an unknown one as such', () => {
    expect(policy.decide(result({}), NOW).reviewReasons).toEqual(['NOT_CLASSIFIED']);
    expect(policy.decide(result({ category: 'made_up' }), NOW).reviewReasons).toEqual([
      'UNKNOWN_CATEGORY',
    ]);
  });

  it('ignores flags it does not know, and clamps the confidence', () => {
    const decision = policy.decide(
      result({ category: 'umowy' }, { confidence: 1.7, reviewReasons: ['SOMETHING_ELSE'] }),
      NOW,
    );
    expect(decision).toMatchObject({ review: false, confidence: 1 });
    expect(policy.decide(result({ category: 'umowy' }, { confidence: NaN }), NOW)).toMatchObject({
      confidence: 0,
      reviewReasons: ['LOW_CONFIDENCE'],
    });
  });

  it('files with an empty model name when no model answered', () => {
    const noModel: Classification = {
      documentType: 'Umowa',
      folderPath: '04_Umowy',
      confidence: 0.9,
      classifier: 'rules',
      fields: { category: 'umowy' },
    };
    expect(policy.decide(noModel, NOW).model).toBe('');
  });

  it.each([0.69, 0.96, NaN])('refuses to exist with a threshold of %s', (t) => {
    expect(() => new AcceptancePolicy(t)).toThrow(ClassificationError);
  });

  it.each([0.7, 0.95])('accepts a threshold of %s', (t) => {
    expect(new AcceptancePolicy(t).threshold).toBe(t);
  });
});

describe('processingFailedDecision', () => {
  it('is review, unclassified, for this month', () => {
    expect(processingFailedDecision(NOW)).toEqual({
      review: true,
      category: 'nieposortowane',
      documentType: 'Nieposortowane',
      folderPath: '98_Nieposortowane/2026/09',
      confidence: 0,
      classifier: '',
      model: '',
      month: '',
      reviewReasons: ['PROCESSING_FAILED'],
    });
  });
});

describe('retryExhaustedDecision', () => {
  it('is review, unclassified, for this month, with the last retry-later reason', () => {
    const decision = retryExhaustedDecision(NOW, 'timeout');
    expect(decision).toEqual({
      review: true,
      category: 'nieposortowane',
      documentType: 'Nieposortowane',
      folderPath: '98_Nieposortowane/2026/09',
      confidence: 0,
      classifier: '',
      model: '',
      month: '',
      reviewReasons: ['RETRY_EXHAUSTED'],
      unclassifiedReason: 'timeout',
    });
    expect(decisionLogFields(decision)).toMatchObject({
      category: 'nieposortowane',
      reviewReasons: ['RETRY_EXHAUSTED'],
      unclassifiedReason: 'timeout',
      folder: '98_Nieposortowane/2026/09',
    });
  });
});

describe('reviewFolderPath', () => {
  it('uses the UTC month of now', () => {
    expect(reviewFolderPath(new Date('2026-12-31T23:30:00.000Z'))).toBe(
      '98_Nieposortowane/2026/12',
    );
    expect(reviewFolderPath(new Date('2027-01-01T00:30:00.000+02:00'))).toBe(
      '98_Nieposortowane/2026/12',
    );
  });
});

describe('decisionLogFields', () => {
  it('carries codes, a two-decimal confidence and the taxonomy path only', () => {
    const decision = policy.decide(
      result({ category: 'faktury_zakupu', year: 2026, month: 9 }, { confidence: 0.4567 }),
      NOW,
    );
    expect(decisionLogFields(decision)).toEqual({
      category: 'nieposortowane',
      suggestedCategory: 'faktury_zakupu',
      confidence: 0.46,
      classifier: 'claude',
      model: 'claude-opus-5',
      month: '2026-09',
      reviewReasons: ['DIRECTION_UNRESOLVED', 'LOW_CONFIDENCE'],
      folder: '98_Nieposortowane/2026/09',
    });
  });

  it('names why nothing was classified', () => {
    expect(
      decisionLogFields({ ...processingFailedDecision(NOW), unclassifiedReason: 'too_large' }),
    ).toMatchObject({ unclassifiedReason: 'too_large', reviewReasons: ['PROCESSING_FAILED'] });
  });
});
