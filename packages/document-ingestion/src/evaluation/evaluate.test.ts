import type { Classification } from '@bcr/shared';
import { AcceptancePolicy, retryExhaustedDecision } from '../services/acceptancePolicy';
import { MAX_RETRY_LATER_ATTEMPTS } from '../services/batchIngestor';
import type { ClassificationOutcome } from '../services/classificationService';
import { contentTypeOf, runEvaluation, score, summarize, type DocumentResult } from './evaluate';
import { goNoGo } from './report';
import type { TruthEntry } from './truth';

const NOW = new Date('2026-09-26T10:00:00.000Z');
const policy = new AcceptancePolicy(0.7);

function decide(fields: Classification['fields'], over: Partial<Classification> = {}) {
  return policy.decide(
    {
      documentType: '',
      folderPath: '',
      confidence: 0.9,
      classifier: 'claude',
      model: 'claude-opus-5',
      fields,
      ...over,
    },
    NOW,
  );
}

const sale: TruthEntry = {
  file: 'fv.pdf',
  category: 'faktury_sprzedazy',
  month: '2026-09',
  direction: 'sprzedaz',
};

describe('score', () => {
  it('scores a retry-exhausted document as unanswered, never as a wrong category', () => {
    const r = score(sale, retryExhaustedDecision(NOW, 'server_error'), true);
    expect(r).toMatchObject({
      outcome: 'retry_exhausted',
      reason: 'server_error',
      direction: 'not_scored',
      filedCorrectly: false,
      filedWrongly: false,
    });
    expect(r).not.toHaveProperty('categoryCorrect');
  });

  it('counts a sale filed as a sale, in its month, as correct', () => {
    const r = score(
      sale,
      decide({ category: 'faktury_sprzedazy', year: 2026, month: 9, direction: 'sprzedaz' }),
      true,
    );
    expect(r).toMatchObject({
      outcome: 'answered',
      suggested: 'faktury_sprzedazy',
      categoryCorrect: true,
      direction: 'correct',
      monthCorrect: true,
      filedCorrectly: true,
      filedWrongly: false,
    });
  });

  it('counts a sale filed as a purchase as right family, wrong direction, and a mis-filing', () => {
    const r = score(
      sale,
      decide({ category: 'faktury_zakupu', year: 2026, month: 9, direction: 'zakup' }),
      true,
    );
    expect(r).toMatchObject({
      categoryCorrect: true,
      direction: 'wrong',
      filedCorrectly: false,
      filedWrongly: true,
    });
  });

  it('counts an unresolved direction as review, not as wrong', () => {
    const r = score(
      sale,
      decide(
        { category: 'faktury_zakupu', year: 2026, month: 9 },
        { confidence: 0.5, reviewReasons: ['DIRECTION_UNRESOLVED'] },
      ),
      true,
    );
    expect(r).toMatchObject({
      suggested: 'faktury_zakupu',
      categoryCorrect: true,
      direction: 'unresolved',
      filedWrongly: false,
    });
  });

  it('scores the settled direction of an invoice held back for low confidence', () => {
    const r = score(
      sale,
      decide(
        { category: 'faktury_sprzedazy', year: 2026, month: 9, direction: 'sprzedaz' },
        { confidence: 0.6 },
      ),
      true,
    );
    expect(r).toMatchObject({ direction: 'correct', filedCorrectly: false, filedWrongly: false });
  });

  it('does not score direction without an identity, or for a non-invoice answer', () => {
    const decision = decide({
      category: 'faktury_sprzedazy',
      year: 2026,
      month: 9,
      direction: 'sprzedaz',
    });
    expect(score(sale, decision, false).direction).toBe('not_scored');
    expect(score(sale, decide({ category: 'umowy' }), true)).toMatchObject({
      direction: 'not_scored',
      categoryCorrect: false,
      filedWrongly: true,
    });
  });

  it('accepts either invoice folder for an invoice-family truth, and checks the month of dated ones', () => {
    const family: TruthEntry = { file: 'x.pdf', category: 'faktura', month: '2026-08' };
    expect(
      score(
        family,
        decide({ category: 'faktury_zakupu', year: 2026, month: 9, direction: 'zakup' }),
        false,
      ),
    ).toMatchObject({
      categoryCorrect: true,
      monthCorrect: false,
      filedCorrectly: false,
      filedWrongly: true,
    });
  });

  it('does not require a month of an undated category', () => {
    const contract: TruthEntry = { file: 'u.pdf', category: 'umowy', month: '2025-03' };
    expect(score(contract, decide({ category: 'umowy' }), false)).toMatchObject({
      monthCorrect: false,
      filedCorrectly: true,
    });
  });

  it('reports the fallback as no model answer, with why', () => {
    const r = score(
      sale,
      decide(
        { category: 'nieposortowane', unclassifiedReason: 'pdf_trim_failed' },
        { classifier: 'fallback-unsorted', reviewReasons: ['NOT_CLASSIFIED'] },
      ),
      true,
    );
    expect(r).toMatchObject({
      outcome: 'no_result',
      reason: 'pdf_trim_failed',
      filedWrongly: false,
    });
    expect(
      score(
        sale,
        decide({}, { classifier: 'fallback-unsorted', reviewReasons: ['NOT_CLASSIFIED'] }),
        true,
      ),
    ).not.toHaveProperty('reason');
  });

  it('keeps the model’s own "nieposortowane" as its suggestion', () => {
    expect(score(sale, decide({ category: 'nieposortowane' }), true)).toMatchObject({
      outcome: 'answered',
      suggested: 'nieposortowane',
      categoryCorrect: false,
    });
  });
});

describe('runEvaluation', () => {
  const entries: TruthEntry[] = [
    { file: 'a.txt', category: 'umowy', month: '' },
    { file: 'b.txt', category: 'umowy', month: '' },
    { file: 'missing.txt', category: 'umowy', month: '' },
  ];

  it('retries "retry later" documents after a pause, sums usage, and keeps the input order', async () => {
    const calls: string[] = [];
    let bFails = 2;
    const sleeps: number[] = [];
    const progress: number[] = [];
    const results = await runEvaluation({
      entries,
      readDocument: async (file) => {
        if (file === 'missing.txt') throw new Error('ENOENT');
        return Buffer.from(file);
      },
      makeService: (onUsage) => ({
        classify: async (ctx): Promise<ClassificationOutcome> => {
          calls.push(ctx.filename);
          if (ctx.filename === 'b.txt' && bFails-- > 0) {
            return { kind: 'retry_later', classifier: 'claude', reason: 'overloaded', status: 529 };
          }
          onUsage({
            model: 'claude-opus-5',
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 7,
          });
          onUsage({
            model: 'claude-opus-5',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
          });
          return { kind: 'decided', decision: decide({ category: 'umowy' }) };
        },
      }),
      concurrency: 1,
      retryPasses: 1,
      retryDelayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW,
      onProgress: (done) => progress.push(done),
    });

    expect(results.map((r) => [r.truth.file, r.outcome])).toEqual([
      ['a.txt', 'answered'],
      ['b.txt', 'retry_later'],
      ['missing.txt', 'unreadable'],
    ]);
    expect(results[1]).toMatchObject({ reason: 'overloaded', status: 529 });
    expect(results[0]).toMatchObject({
      inputTokens: 101,
      outputTokens: 11,
      cacheReadInputTokens: 52,
      cacheCreationInputTokens: 8,
      model: 'claude-opus-5',
    });
    expect(calls).toEqual(['a.txt', 'b.txt', 'b.txt']);
    expect(sleeps).toEqual([5]);
    expect(progress).toEqual([1, 2, 3]);
  });

  // Review finding: a document that always timed out stayed "retry later"
  // on every run, so the release could never reach GO, although production
  // files it for review at the bound.
  it('scores a document that times out on every pass as filed for review, as the bot path would', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const run = (files: string[]) =>
      runEvaluation({
        entries: files.map((file) => ({ file, category: 'umowy', month: '' })),
        readDocument: async (file) => Buffer.from(file),
        makeService: () => ({
          classify: async (ctx): Promise<ClassificationOutcome> => {
            calls.push(ctx.filename);
            if (ctx.filename === 'slow.pdf') {
              return { kind: 'retry_later', classifier: 'claude', reason: 'timeout' };
            }
            if (ctx.filename === 'busy.pdf') {
              return {
                kind: 'retry_later',
                classifier: 'claude',
                reason: 'overloaded',
                status: 529,
              };
            }
            return { kind: 'decided', decision: decide({ category: 'umowy' }) };
          },
        }),
        concurrency: 1,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => NOW,
      });

    const results = await run(['ok.pdf', 'slow.pdf', 'busy.pdf']);

    // The default is two retry passes: as many sends as the bot path allows.
    expect(calls.filter((c) => c === 'slow.pdf')).toHaveLength(MAX_RETRY_LATER_ATTEMPTS);
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(results.map((r) => [r.truth.file, r.outcome])).toEqual([
      ['ok.pdf', 'answered'],
      ['slow.pdf', 'retry_exhausted'],
      ['busy.pdf', 'retry_later'],
    ]);
    expect(results[1]).toMatchObject({
      reason: 'timeout',
      decision: { review: true, reviewReasons: ['RETRY_EXHAUSTED'] },
      filedWrongly: false,
    });
    const summary = summarize(results, false);
    expect(summary).toMatchObject({ answered: 1, retryExhausted: 1, retryLater: 1 });
    expect(summary.review).toEqual({ hit: 1, of: 2 });
    // A 529 left over still makes the run incomplete; the exhausted one does not.
    expect(goNoGo(summary).transient).toBe('INCOMPLETE');
    expect(goNoGo(summarize(await run(['ok.pdf', 'slow.pdf']), false)).transient).toBe('PASS');
  });

  it('passes the client identity and the content type, and runs with its defaults', async () => {
    const seen: unknown[] = [];
    await runEvaluation({
      entries: [{ file: 'scan.PDF', category: 'umowy', month: '' }],
      readDocument: async () => Buffer.from('%PDF'),
      client: { nip: '1234567890', companyName: 'Biuro Testowe' },
      makeService: () => ({
        classify: async (ctx) => {
          seen.push({ client: ctx.client, contentType: ctx.contentType });
          return { kind: 'decided', decision: decide({ category: 'umowy' }) };
        },
      }),
    });
    expect(seen).toEqual([
      {
        client: { nip: '1234567890', companyName: 'Biuro Testowe' },
        contentType: 'application/pdf',
      },
    ]);
  });
});

describe('contentTypeOf', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['b.JPG', 'image/jpeg'],
    ['c.png', 'image/png'],
    ['d.txt', 'text/plain'],
    ['e.docx', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('%s is %s', (file, type) => {
    expect(contentTypeOf(file)).toBe(type);
  });
});

describe('score: invoice fields', () => {
  const extraction = {
    invoiceNumber: 'FV 12/2026',
    issueDate: '2026-09-12',
    saleDate: null,
    currency: 'PLN',
    netAmount: '1000.00',
    vatAmount: '230.00',
    grossAmount: '1230.00',
    sellerNip: '5260250274',
    sellerName: 'Dostawca S.A.',
    buyerNip: null,
    buyerName: null,
    ksefNumber: null,
  };
  const truth: TruthEntry = {
    file: 'fv.pdf',
    category: 'faktury_zakupu',
    month: '2026-09',
    fields: {
      invoiceNumber: 'FV12/2026',
      grossAmount: '1230.00',
      vatAmount: '23.00',
      buyerNip: '1234567819',
      sellerName: 'dostawca s a',
    },
  };

  it('scores each field the truth gives; a null read is a miss', () => {
    const decision = decide(
      { category: 'faktury_zakupu', year: 2026, month: 9, direction: 'zakup' },
      { extraction },
    );
    expect(score(truth, decision, true).fields).toEqual({
      invoiceNumber: true,
      grossAmount: true,
      vatAmount: false,
      buyerNip: false,
      sellerName: true,
    });
  });

  it('scores every field a miss when nothing was extracted, and nothing without truth fields', () => {
    const decision = decide({
      category: 'faktury_zakupu',
      year: 2026,
      month: 9,
      direction: 'zakup',
    });
    expect(Object.values(score(truth, decision, true).fields ?? {})).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(score(sale, decision, true).fields).toBeUndefined();
  });
});

describe('summarize', () => {
  const r = (
    over: Partial<DocumentResult> & Pick<DocumentResult, 'truth' | 'outcome'>,
  ): DocumentResult => ({
    direction: 'not_scored',
    filedCorrectly: false,
    filedWrongly: false,
    inputTokens: 10,
    outputTokens: 1,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 3,
    model: 'claude-opus-5',
    ...over,
  });

  it('adds up accuracy, direction, month, review, buckets, reasons and tokens', () => {
    const contract: TruthEntry = { file: 'u.pdf', category: 'umowy', month: '' };
    const results = [
      r({
        truth: sale,
        outcome: 'answered',
        decision: decide({
          category: 'faktury_sprzedazy',
          year: 2026,
          month: 9,
          direction: 'sprzedaz',
        }),
        categoryCorrect: true,
        direction: 'correct',
        monthCorrect: true,
        filedCorrectly: true,
      }),
      r({
        truth: sale,
        outcome: 'answered',
        decision: decide(
          { category: 'faktury_zakupu', year: 2026, month: 9 },
          { confidence: 0.5, reviewReasons: ['DIRECTION_UNRESOLVED'] },
        ),
        categoryCorrect: true,
        direction: 'unresolved',
        monthCorrect: true,
      }),
      r({
        truth: contract,
        outcome: 'answered',
        decision: decide({ category: 'inne' }, { confidence: 0.75 }),
        categoryCorrect: false,
        filedWrongly: true,
      }),
      r({ truth: contract, outcome: 'retry_later' }),
    ];

    const s = summarize(results, true);

    expect(s).toMatchObject({
      documents: 4,
      answered: 3,
      noResult: 0,
      retryLater: 1,
      unreadable: 0,
      category: { hit: 2, of: 3 },
      direction: { scored: 2, correct: 1, unresolved: 1, wrong: 0 },
      month: { hit: 2, of: 2 },
      review: { hit: 1, of: 3 },
      filedCorrectly: 1,
      filedWrongly: 1,
      reasons: { DIRECTION_UNRESOLVED: 1, LOW_CONFIDENCE: 1 },
      inputTokens: 40,
      outputTokens: 4,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 12,
    });
    expect(s.perCategory).toEqual([
      {
        category: 'faktury_sprzedazy',
        documents: 2,
        answered: 2,
        correct: 2,
        review: 1,
        filedWrongly: 0,
      },
      { category: 'umowy', documents: 2, answered: 1, correct: 0, review: 0, filedWrongly: 1 },
    ]);
    expect(s.confidenceBuckets.map((b) => [b.label, b.of, b.hit])).toEqual([
      ['< 0.50', 0, 0],
      ['0.50-0.69', 1, 1],
      ['0.70-0.79', 1, 0],
      ['0.80-0.89', 0, 0],
      ['0.90-1.00', 1, 1],
    ]);
    expect(summarize(results, false).direction).toBeUndefined();
    expect(s.extraction).toEqual([]);
  });

  it('adds up invoice-field accuracy over answered documents, per field given', () => {
    const invoice: TruthEntry = { file: 'i.pdf', category: 'faktury_noty', month: '' };
    const s = summarize(
      [
        r({ truth: invoice, outcome: 'answered', fields: { grossAmount: true, sellerNip: false } }),
        r({ truth: invoice, outcome: 'answered', fields: { grossAmount: false } }),
        r({ truth: invoice, outcome: 'no_result', fields: { grossAmount: false } }),
      ],
      true,
    );
    expect(s.extraction).toEqual([
      { field: 'grossAmount', hit: 1, of: 2 },
      { field: 'sellerNip', hit: 0, of: 1 },
    ]);
  });
});
