import type { DocumentResult, EvaluationSummary } from './evaluate';
import { goNoGo, renderReport } from './report';

function summary(over: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    documents: 40,
    answered: 40,
    noResult: 0,
    retryExhausted: 0,
    retryLater: 0,
    unreadable: 0,
    category: { hit: 38, of: 40 },
    perCategory: [
      { category: 'umowy', documents: 40, answered: 40, correct: 38, review: 3, filedWrongly: 1 },
    ],
    direction: { scored: 10, correct: 10, unresolved: 0, wrong: 0 },
    month: { hit: 20, of: 20 },
    review: { hit: 3, of: 40 },
    filedCorrectly: 36,
    filedWrongly: 1,
    confidenceBuckets: [{ label: '0.90-1.00', hit: 38, of: 40 }],
    extraction: [],
    reasons: { LOW_CONFIDENCE: 3 },
    inputTokens: 2_000_000,
    outputTokens: 40_000,
    ...over,
  };
}

const meta = {
  date: new Date('2026-09-26T10:00:00Z'),
  model: 'claude-opus-5',
  effort: 'low',
  threshold: 0.7,
  identityGiven: true,
};

const base: Omit<DocumentResult, 'truth' | 'outcome'> = {
  direction: 'not_scored',
  filedCorrectly: false,
  filedWrongly: false,
  inputTokens: 0,
  outputTokens: 0,
  model: 'claude-opus-5',
};

describe('goNoGo', () => {
  it('is GO at 95% category, every scored direction right and nothing left to retry', () => {
    expect(goNoGo(summary())).toEqual({
      category: 'PASS',
      direction: 'PASS',
      transient: 'PASS',
      go: true,
    });
  });

  it.each([
    ['category below 95%', { category: { hit: 37, of: 40 } }, { category: 'FAIL' }],
    ['nothing answered', { category: { hit: 0, of: 0 } }, { category: 'FAIL' }],
    [
      'one wrong direction',
      { direction: { scored: 10, correct: 9, unresolved: 0, wrong: 1 } },
      { direction: 'FAIL' },
    ],
    [
      'one unresolved direction',
      { direction: { scored: 10, correct: 9, unresolved: 1, wrong: 0 } },
      { direction: 'FAIL' },
    ],
    ['no identity', { direction: undefined }, { direction: 'NOT MEASURED' }],
    [
      'no invoice to score',
      { direction: { scored: 0, correct: 0, unresolved: 0, wrong: 0 } },
      { direction: 'NOT MEASURED' },
    ],
    ['documents left as retry later', { retryLater: 2 }, { transient: 'INCOMPLETE' }],
  ] as const)('is NO-GO with %s', (_label, over, expected) => {
    const s = summary(over as Partial<EvaluationSummary>);
    expect(goNoGo(s)).toMatchObject({ ...expected, go: false });
  });
});

describe('renderReport', () => {
  it('writes the verdict, the totals, the tables and an estimated cost', () => {
    const results: DocumentResult[] = [
      {
        ...base,
        truth: { file: 'a|b.pdf', category: 'umowy', month: '' },
        outcome: 'answered',
        suggested: 'umowy',
        categoryCorrect: true,
        filedCorrectly: true,
        decision: {
          review: false,
          category: 'umowy',
          documentType: 'Umowa',
          folderPath: '04_Umowy',
          confidence: 0.91,
          classifier: 'claude',
          model: 'claude-opus-5',
          month: '',
          reviewReasons: [],
        },
      },
      {
        ...base,
        truth: { file: 'c.pdf', category: 'faktury_zakupu', month: '2026-09', direction: 'zakup' },
        outcome: 'answered',
        suggested: 'faktury_sprzedazy',
        categoryCorrect: true,
        filedWrongly: true,
        decision: {
          review: false,
          category: 'faktury_sprzedazy',
          documentType: 'Faktura sprzedaży',
          folderPath: '01_Faktury/01_Faktury_sprzedaży/2026/09',
          confidence: 0.95,
          classifier: 'claude',
          model: 'claude-opus-5',
          month: '2026-09',
          reviewReasons: [],
        },
      },
      {
        ...base,
        truth: { file: 'd.pdf', category: 'umowy', month: '' },
        outcome: 'answered',
        suggested: 'umowy',
        categoryCorrect: true,
        decision: {
          review: true,
          category: 'nieposortowane',
          documentType: 'Nieposortowane',
          folderPath: '98_Nieposortowane/2026/09',
          confidence: 0.6,
          classifier: 'claude',
          model: 'claude-opus-5',
          month: '',
          reviewReasons: ['LOW_CONFIDENCE'],
          suggestedCategory: 'umowy',
        },
      },
      {
        ...base,
        truth: { file: 'e.pdf', category: 'inne', month: '' },
        outcome: 'answered',
        suggested: 'umowy',
        categoryCorrect: false,
      },
      {
        ...base,
        truth: { file: 'f.pdf', category: 'umowy', month: '' },
        outcome: 'retry_later',
        reason: 'overloaded',
        status: 529,
      },
      {
        ...base,
        truth: { file: 'g.pdf', category: 'umowy', month: '' },
        outcome: 'retry_later',
        reason: 'timeout',
      },
      {
        ...base,
        truth: { file: 'h.pdf', category: 'umowy', month: '' },
        outcome: 'no_result',
        reason: 'pdf_trim_failed',
      },
      { ...base, truth: { file: 'i.pdf', category: 'umowy', month: '' }, outcome: 'no_result' },
      { ...base, truth: { file: 'j.pdf', category: 'umowy', month: '' }, outcome: 'unreadable' },
      {
        ...base,
        truth: { file: 'k.pdf', category: 'umowy', month: '' },
        outcome: 'retry_exhausted',
        reason: 'timeout',
      },
      {
        ...base,
        truth: { file: 'l.pdf', category: 'umowy', month: '' },
        outcome: 'retry_exhausted',
        reason: 'server_error',
        status: 500,
      },
    ];

    const text = renderReport(summary({ retryLater: 2, retryExhausted: 2 }), results, meta);

    expect(text).toContain('# Classification evaluation — 2026-09-26 10:00 UTC');
    expect(text).toContain(
      'Model `claude-opus-5`, effort `low`, accept threshold 0.70, client identity given.',
    );
    expect(text).toContain('| Category ≥ 95% of answered | PASS | 38/40 (95%) |');
    expect(text).toContain(
      '| Direction 100% when the client is a party | PASS | 10/10 correct, 0 unresolved, 0 wrong |',
    );
    expect(text).toContain(
      '| No transient error filed to 98_ | INCOMPLETE | 2 left as "retry later", none filed; ' +
        '2 retry exhausted (a timeout, 5xx or lost connection on every pass: filed for review) |',
    );
    expect(text).toContain('**NO-GO**');
    expect(text).toContain('about $11.00 at list price for `claude-opus-5`');
    expect(text).toContain('| a b.pdf | `umowy` | — | `umowy` | `umowy` | — | 0.91 | — | ok |');
    expect(text).toContain('**WRONG**');
    expect(text).toContain('review (category right)');
    expect(text).toContain('review (category wrong)');
    expect(text).toContain('retry later (overloaded 529)');
    expect(text).toContain('retry later (timeout)');
    expect(text).toContain('retry exhausted, review (timeout)');
    expect(text).toContain('retry exhausted, review (server_error 500)');
    expect(text).toContain('retry exhausted: 2; retry later: 2;');
    expect(text).toContain('no model answer (pdf_trim_failed)');
    expect(text).toContain('no model answer (unknown)');
    expect(text).toContain('| unreadable |');
    expect(text).toContain('`faktury_zakupu` (zakup)');
    expect(text).toContain('- Review reasons: LOW_CONFIDENCE 3.');
  });

  it('reports invoice-field accuracy and each miss by field name, never by value', () => {
    const text = renderReport(
      summary({
        extraction: [
          { field: 'grossAmount', hit: 9, of: 10 },
          { field: 'sellerNip', hit: 10, of: 10 },
        ],
      }),
      [
        {
          ...base,
          truth: {
            file: 'fv|1.pdf',
            category: 'faktury_zakupu',
            month: '2026-09',
            fields: { grossAmount: '1230.00' },
          },
          outcome: 'answered',
          fields: { grossAmount: false, sellerNip: true },
        },
      ],
      meta,
    );
    expect(text).toContain('## Invoice fields (answered documents whose truth gives the field)');
    expect(text).toContain('| `grossAmount` | 9/10 (90%) |');
    expect(text).toContain('| `sellerNip` | 10/10 (100%) |');
    expect(text).toContain('| fv 1.pdf | `grossAmount` |');
    expect(text).not.toContain('1230.00');
    expect(text).not.toContain('| fv 1.pdf | `sellerNip` |');
  });

  it('says when no truth gives invoice fields, and when nothing was missed', () => {
    expect(renderReport(summary(), [], meta)).toContain('No truth entry gives invoice fields.');
    expect(
      renderReport(summary({ extraction: [{ field: 'currency', hit: 1, of: 1 }] }), [], meta),
    ).toContain('No misses.');
  });

  it('says so when direction is not measured, and prices nothing it does not know', () => {
    const text = renderReport(
      summary({ direction: undefined, reasons: {}, category: { hit: 0, of: 0 } }),
      [
        {
          ...base,
          model: 'other-model',
          truth: { file: 'x.pdf', category: 'umowy', month: '' },
          outcome: 'unreadable',
        },
      ],
      { ...meta, identityGiven: false, model: 'other-model' },
    );
    expect(text).toContain('client identity not given (direction not measured)');
    expect(text).toContain('| NOT MEASURED | no --client-name/--client-nip |');
    expect(text).toContain('| FAIL | 0/0 |');
    expect(text).toContain('- Review reasons: none.');
    expect(text).not.toContain('list price');
  });
});
