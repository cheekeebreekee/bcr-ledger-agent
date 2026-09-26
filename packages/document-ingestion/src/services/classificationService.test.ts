import Anthropic from '@anthropic-ai/sdk';
import type { Classification, Classifier, ClassifierContext, Logger } from '@bcr/shared';
import { AcceptancePolicy } from './acceptancePolicy';
import { ClassificationService, FallbackClassifier } from './classificationService';
import { ClaudeClassifier } from './claudeClassifier';

const NOW = new Date('2026-09-26T10:00:00.000Z');
const policy = new AcceptancePolicy(0.7);
const silent = { warn: () => undefined, info: () => undefined } as unknown as Logger;

const ctx = (over: Partial<ClassifierContext> = {}): ClassifierContext => ({
  filename: 'x.pdf',
  contentType: 'application/pdf',
  readContent: async () => Buffer.from('%PDF-1.7'),
  ...over,
});

function answering(
  result: Awaited<ReturnType<Classifier['classify']>>,
  name = 'fake',
): Classifier & {
  classify: jest.Mock;
} {
  return { name, classify: jest.fn(async () => result) };
}

const contract: Classification = {
  documentType: 'Umowa',
  folderPath: '04_Umowy',
  confidence: 0.95,
  classifier: 'claude',
  model: 'claude-opus-5',
  fields: { category: 'umowy' },
};

function service(classifiers: Classifier[]) {
  return new ClassificationService(classifiers, { policy, now: () => NOW, log: silent });
}

describe('FallbackClassifier', () => {
  it('always returns a dated Nieposortowane result flagged NOT_CLASSIFIED', async () => {
    const result = await new FallbackClassifier().classify(ctx({ filename: 'mystery.pdf' }));
    expect(result.documentType).toBe('Nieposortowane');
    expect(result.folderPath).toMatch(/^98_Nieposortowane\/\d{4}\/\d{2}$/);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reviewReasons).toEqual(['NOT_CLASSIFIED']);
  });
});

describe('ClassificationService', () => {
  it('takes the first answer and runs it through the acceptance policy', async () => {
    const later = answering(null);
    const outcome = await service([answering(contract), later]).classify(ctx());
    expect(outcome).toEqual({
      kind: 'decided',
      decision: expect.objectContaining({
        review: false,
        category: 'umowy',
        folderPath: '04_Umowy',
      }),
    });
    expect(later.classify).not.toHaveBeenCalled();
  });

  it('sends a low-confidence answer to review instead of trying the next classifier', async () => {
    const fallback = answering(null);
    const outcome = await service([
      answering({ ...contract, confidence: 0.69 }),
      fallback,
    ]).classify(ctx());
    expect(outcome).toMatchObject({
      kind: 'decided',
      decision: { review: true, suggestedCategory: 'umowy', reviewReasons: ['LOW_CONFIDENCE'] },
    });
    expect(fallback.classify).not.toHaveBeenCalled();
  });

  it('falls through a no-result to the fallback, keeping why', async () => {
    const outcome = await service([
      answering({ outcome: 'no_result', reason: 'pdf_trim_failed' }),
      new FallbackClassifier(),
    ]).classify(ctx());
    expect(outcome).toMatchObject({
      kind: 'decided',
      decision: {
        review: true,
        folderPath: '98_Nieposortowane/2026/09',
        reviewReasons: ['NOT_CLASSIFIED'],
        unclassifiedReason: 'pdf_trim_failed',
        classifier: 'fallback-unsorted',
      },
    });
  });

  it('never falls through to the fallback on "retry later"', async () => {
    const fallback = answering(contract, 'fallback');
    const outcome = await service([
      answering({ outcome: 'retry_later', reason: 'overloaded', status: 529 }, 'claude'),
      fallback,
    ]).classify(ctx());
    expect(outcome).toEqual({
      kind: 'retry_later',
      classifier: 'claude',
      reason: 'overloaded',
      status: 529,
    });
    expect(fallback.classify).not.toHaveBeenCalled();
  });

  it('reports a status-less retry without a status', async () => {
    const outcome = await service([
      answering({ outcome: 'retry_later', reason: 'timeout' }),
    ]).classify(ctx());
    expect(outcome).toEqual({ kind: 'retry_later', classifier: 'fake', reason: 'timeout' });
  });

  it('uses the caller’s clock for the review month', async () => {
    const outcome = await service([new FallbackClassifier()]).classify(
      ctx(),
      new Date('2027-02-03T00:00:00Z'),
    );
    expect(outcome.kind === 'decided' && outcome.decision.folderPath).toBe(
      '98_Nieposortowane/2027/02',
    );
  });

  it('skips a classifier that throws, and throws when nothing answers', async () => {
    const broken: Classifier = {
      name: 'broken',
      classify: async () => {
        throw new Error('boom');
      },
    };
    const outcome = await service([broken, answering(contract)]).classify(ctx());
    expect(outcome.kind).toBe('decided');
    await expect(service([broken, answering(null)]).classify(ctx())).rejects.toThrow(
      /No classifier/,
    );
  });

  it('needs at least one classifier', () => {
    expect(() => new ClassificationService([], { policy })).toThrow(/at least one/);
  });

  // End to end with the real Claude classifier behind a fake API: a 529
  // after the SDK's own retry is never filed, not even for review.
  it('with the real Claude classifier: a 529 is retry-later, a 400 is review', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(
        Anthropic.APIError.generate(529, { type: 'error' }, 'Overloaded', new Headers()),
      )
      .mockRejectedValueOnce(
        Anthropic.APIError.generate(400, { type: 'error' }, 'bad', new Headers()),
      );
    const claude = new ClaudeClassifier({
      apiKey: 'k',
      model: 'claude-opus-5',
      maxContentBytes: 1024,
      client: { messages: { create } } as never,
      log: silent,
    });
    const svc = new ClassificationService([claude, new FallbackClassifier()], {
      policy,
      log: silent,
    });

    expect(await svc.classify(ctx(), NOW)).toEqual({
      kind: 'retry_later',
      classifier: 'claude',
      reason: 'overloaded',
      status: 529,
    });
    expect(await svc.classify(ctx(), NOW)).toMatchObject({
      kind: 'decided',
      decision: {
        review: true,
        reviewReasons: ['NOT_CLASSIFIED'],
        unclassifiedReason: 'invalid_request',
      },
    });
  });
});
