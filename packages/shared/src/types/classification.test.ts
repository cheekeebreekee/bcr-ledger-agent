import { isNoResult, isRetryLater, type ClassifierResult } from './classification';

const classification: ClassifierResult = {
  documentType: 'Umowa',
  confidence: 0.9,
  classifier: 'claude',
  folderPath: '04_Umowy',
  fields: { category: 'umowy' },
};

describe('classifier result guards', () => {
  it('tells "retry later" from "no result", a classification and null', () => {
    const retry: ClassifierResult = { outcome: 'retry_later', reason: 'overloaded', status: 529 };
    const none: ClassifierResult = { outcome: 'no_result', reason: 'unsupported_type' };

    expect([retry, none, classification, null].map(isRetryLater)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([retry, none, classification, null].map(isNoResult)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });
});
