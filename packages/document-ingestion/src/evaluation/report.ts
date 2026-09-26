import type { DocumentResult, EvaluationSummary, Ratio } from './evaluate';

export interface ReportMeta {
  readonly date: Date;
  readonly model: string;
  readonly effort: string;
  readonly threshold: number;
  /** Whether a client identity was primed (its values are not printed). */
  readonly identityGiven: boolean;
}

/** USD per million tokens (input, output), for the cost estimate only. */
const PRICES: readonly [string, number, number][] = [
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-5', 5, 25],
];

/** The go/no-go bar of the classification release (docs/operations/human-steps.md). */
export const CATEGORY_BAR = 0.95;

export interface GoNoGo {
  readonly category: 'PASS' | 'FAIL';
  readonly direction: 'PASS' | 'FAIL' | 'NOT MEASURED';
  readonly transient: 'PASS' | 'INCOMPLETE';
  readonly go: boolean;
}

/** The release criteria, from a summary. */
export function goNoGo(summary: EvaluationSummary): GoNoGo {
  const category =
    summary.category.of > 0 && rate(summary.category) >= CATEGORY_BAR ? 'PASS' : 'FAIL';
  const d = summary.direction;
  const direction =
    !d || d.scored === 0 ? 'NOT MEASURED' : d.correct === d.scored ? 'PASS' : 'FAIL';
  // A "retry later" is never filed, so none reached 98_; left over, the run is
  // incomplete. A retry-exhausted document was filed for review by the bound,
  // as production would: it is reported, and it does not hold the verdict.
  const transient = summary.retryLater === 0 ? 'PASS' : 'INCOMPLETE';
  return {
    category,
    direction,
    transient,
    go: category === 'PASS' && direction === 'PASS' && transient === 'PASS',
  };
}

/** A Markdown report: local output, never committed (it names the files). */
export function renderReport(
  summary: EvaluationSummary,
  results: readonly DocumentResult[],
  meta: ReportMeta,
): string {
  const verdict = goNoGo(summary);
  const lines: string[] = [
    `# Classification evaluation — ${meta.date.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Model \`${meta.model}\`, effort \`${meta.effort}\`, accept threshold ${meta.threshold.toFixed(2)}, ` +
      `client identity ${meta.identityGiven ? 'given' : 'not given (direction not measured)'}.`,
    '',
    '## Go / no-go',
    '',
    '| Criterion | Result | Detail |',
    '|---|---|---|',
    `| Category ≥ ${pct(CATEGORY_BAR)} of answered | ${verdict.category} | ${ratio(summary.category)} |`,
    `| Direction 100% when the client is a party | ${verdict.direction} | ${directionDetail(summary)} |`,
    `| No transient error filed to 98_ | ${verdict.transient} | ${summary.retryLater} left as "retry later", none filed; ${summary.retryExhausted} retry exhausted (a timeout, 5xx or lost connection on every pass: filed for review) |`,
    `| Review rate (reported) | — | ${ratio(summary.review)} filed to 98_ |`,
    '',
    `**${verdict.go ? 'GO' : 'NO-GO'}**`,
    '',
    '## Totals',
    '',
    `- Documents: ${summary.documents}; answered by the model: ${summary.answered}; ` +
      `no model answer (fallback): ${summary.noResult}; retry exhausted: ${summary.retryExhausted}; ` +
      `retry later: ${summary.retryLater}; ` +
      `unreadable: ${summary.unreadable}.`,
    `- Filed correctly: ${summary.filedCorrectly}; filed under a wrong category: ${summary.filedWrongly}.`,
    `- Month (documents whose truth has one): ${ratio(summary.month)}.`,
    `- Review reasons: ${
      Object.entries(summary.reasons)
        .map(([r, n]) => `${r} ${n}`)
        .join(', ') || 'none'
    }.`,
    `- Tokens: ${summary.inputTokens} in, ${summary.outputTokens} out${cost(summary, results)}.`,
    '',
    '## Per category (truth)',
    '',
    '| Category | Documents | Answered | Correct | Review | Filed wrongly |',
    '|---|---|---|---|---|---|',
    ...summary.perCategory.map(
      (c) =>
        `| \`${c.category}\` | ${c.documents} | ${c.answered} | ${c.correct} | ${c.review} | ${c.filedWrongly} |`,
    ),
    '',
    '## Confidence (answered)',
    '',
    '| Confidence | Documents | Category correct |',
    '|---|---|---|',
    ...summary.confidenceBuckets.map((b) => `| ${b.label} | ${b.of} | ${b.hit} |`),
    '',
    ...extractionSection(summary, results),
    '## Documents',
    '',
    '| File | Truth | Month | Suggested | Filed as | Month read | Confidence | Reasons | Result |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map(row),
    '',
  ];
  return lines.join('\n');
}

/**
 * Invoice-field accuracy (reported, not part of the verdict), and which field
 * each miss was: field names only, never a value read or expected.
 */
function extractionSection(
  summary: EvaluationSummary,
  results: readonly DocumentResult[],
): string[] {
  if (summary.extraction.length === 0) {
    return ['## Invoice fields', '', 'No truth entry gives invoice fields.', ''];
  }
  const misses = results.flatMap((r) =>
    Object.entries(r.fields ?? {})
      .filter(([, correct]) => !correct)
      .map(([field]) => `| ${cell(r.truth.file)} | \`${field}\` |`),
  );
  return [
    '## Invoice fields (answered documents whose truth gives the field)',
    '',
    '| Field | Read correctly |',
    '|---|---|',
    ...summary.extraction.map((f) => `| \`${f.field}\` | ${ratio(f)} |`),
    '',
    ...(misses.length > 0
      ? [
          'Misses (a wrong value, or none where the truth has one):',
          '',
          '| File | Field |',
          '|---|---|',
          ...misses,
          '',
        ]
      : ['No misses.', '']),
  ];
}

function row(r: DocumentResult): string {
  const d = r.decision;
  const truth = `\`${r.truth.category}\`${r.truth.direction ? ` (${r.truth.direction})` : ''}`;
  const cells = [
    cell(r.truth.file),
    truth,
    r.truth.month || '—',
    r.suggested ? `\`${r.suggested}\`` : '—',
    d ? `\`${d.category}\`` : '—',
    d?.month || '—',
    d ? d.confidence.toFixed(2) : '—',
    d?.reviewReasons.join(', ') || '—',
    resultOf(r),
  ];
  return `| ${cells.join(' | ')} |`;
}

function resultOf(r: DocumentResult): string {
  switch (r.outcome) {
    case 'unreadable':
      return 'unreadable';
    case 'retry_later':
      return `retry later (${r.reason ?? ''}${r.status ? ` ${r.status}` : ''})`;
    case 'retry_exhausted':
      return `retry exhausted, review (${r.reason ?? ''}${r.status ? ` ${r.status}` : ''})`;
    case 'no_result':
      return `no model answer (${r.reason ?? 'unknown'})`;
    default:
      if (r.filedWrongly) return '**WRONG**';
      if (r.filedCorrectly) return 'ok';
      return r.categoryCorrect ? 'review (category right)' : 'review (category wrong)';
  }
}

function directionDetail(summary: EvaluationSummary): string {
  const d = summary.direction;
  if (!d) return 'no --client-name/--client-nip';
  return `${d.correct}/${d.scored} correct, ${d.unresolved} unresolved, ${d.wrong} wrong`;
}

function cost(summary: EvaluationSummary, results: readonly DocumentResult[]): string {
  const model = results.find((r) => r.model)?.model ?? '';
  const price = PRICES.find(([prefix]) => model.startsWith(prefix));
  if (!price) return '';
  const usd = (summary.inputTokens * price[1] + summary.outputTokens * price[2]) / 1_000_000;
  return ` (about $${usd.toFixed(2)} at list price for \`${model}\`)`;
}

function rate(r: Ratio): number {
  return r.of === 0 ? 0 : r.hit / r.of;
}

function ratio(r: Ratio): string {
  return r.of === 0 ? '0/0' : `${r.hit}/${r.of} (${pct(rate(r))})`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

/** A file name in a table cell: pipes and newlines would break the row. */
function cell(value: string): string {
  return value.replace(/[|\r\n]/g, ' ');
}
