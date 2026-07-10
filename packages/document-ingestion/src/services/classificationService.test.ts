import { ClassificationService, FallbackClassifier } from './classificationService';
import type { Classifier, ClassifierContext } from '@bcr/shared';

const ctx = (filename: string): ClassifierContext => ({
  filename,
  contentType: 'application/pdf',
  readContent: async () => Buffer.from(''),
});

describe('FallbackClassifier', () => {
  it('always returns a dated Nieposortowane result', async () => {
    const c = new FallbackClassifier();
    const result = await c.classify(ctx('mystery.pdf'));
    expect(result.documentType).toBe('Nieposortowane');
    expect(result.folderPath).toMatch(/^98_Nieposortowane\/\d{4}\/\d{2}$/);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('ClassificationService', () => {
  it('returns the first classifier that meets the threshold', async () => {
    const high: Classifier = {
      name: 'high',
      classify: async () => ({
        documentType: 'Invoice',
        folderPath: 'Invoices/2026/03',
        confidence: 0.95,
        classifier: 'high',
        fields: {},
      }),
    };
    const never: Classifier = { name: 'never', classify: async () => null };
    const svc = new ClassificationService([high, never]);
    const result = await svc.classify(ctx('Invoice_03_2026.pdf'));
    expect(result.classifier).toBe('high');
  });

  it('returns the best below-threshold result when none meet it', async () => {
    const low: Classifier = {
      name: 'low',
      classify: async () => ({
        documentType: 'Invoice',
        folderPath: 'Invoices/X/Y',
        confidence: 0.4,
        classifier: 'low',
        fields: {},
      }),
    };
    const medium: Classifier = {
      name: 'medium',
      classify: async () => ({
        documentType: 'Invoice',
        folderPath: 'Invoices/A/B',
        confidence: 0.6,
        classifier: 'medium',
        fields: {},
      }),
    };
    const svc = new ClassificationService([low, medium], { acceptanceThreshold: 0.9 });
    const result = await svc.classify(ctx('Invoice_03_2026.pdf'));
    expect(result.classifier).toBe('medium');
  });

  it('rethrows when no classifier returns anything', async () => {
    const none: Classifier = { name: 'none', classify: async () => null };
    const svc = new ClassificationService([none]);
    await expect(svc.classify(ctx('x.pdf'))).rejects.toThrow(/No classifier/);
  });

  it('skips classifiers that throw and continues', async () => {
    const broken: Classifier = {
      name: 'broken',
      classify: async () => {
        throw new Error('boom');
      },
    };
    const ok: Classifier = {
      name: 'ok',
      classify: async () => ({
        documentType: 'Invoice',
        folderPath: 'Invoices/2026/03',
        confidence: 0.95,
        classifier: 'ok',
        fields: {},
      }),
    };
    const svc = new ClassificationService([broken, ok]);
    const result = await svc.classify(ctx('Invoice_03_2026.pdf'));
    expect(result.classifier).toBe('ok');
  });
});
