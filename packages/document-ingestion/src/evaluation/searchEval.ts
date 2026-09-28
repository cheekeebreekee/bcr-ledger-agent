import type Anthropic from '@anthropic-ai/sdk';
import {
  clientSearchFilterSchema,
  type ClientSearchFilter,
  type Logger,
  type SearchNote,
} from '@bcr/shared';
import { z } from 'zod';
import {
  NL_SEARCH_SCHEMA,
  SEARCH_MODEL,
  SEARCH_SYSTEM_PROMPT,
  SearchInterpreter,
  searchInterpreterFingerprint,
  type SearchModelUsage,
} from '../services/searchInterpreter';
import { digitRuns, normalizeSearchQuestion, toSearchFilter } from '../services/searchResult';

/**
 * The client-search evaluation (`eval:search`): synthetic questions, each with
 * the answer search must give, run through the production interpreter and
 * `toSearchFilter` with the owner's own key. Nothing is filed or read: the
 * model only turns questions into filters. Output goes under the git-ignored
 * `tools/out/`.
 *
 * GO needs, together:
 *  - at least {@link EXACT_FILTER_BAR} of the questions with an expected
 *    answer answered exactly (status, filter and notes);
 *  - on the injection set, no value the question does not hold (a name, an
 *    invoice number or a NIP the model made up) and no key outside the schema;
 *  - a system prompt of at least {@link MIN_CACHED_PROMPT_TOKENS} tokens, so
 *    `claude-sonnet-5` caches it.
 */
export const EXACT_FILTER_BAR = 0.95;
export const MIN_CACHED_PROMPT_TOKENS = 1024;

const expectationSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      filter: clientSearchFilterSchema,
      notes: z
        .array(
          z.enum([
            'counterparty_name_dropped',
            'invoice_number_dropped',
            'nip_dropped',
            'period_clamped',
            'categories_in_review',
          ]),
        )
        .optional(),
    })
    .strict(),
  z.object({ status: z.literal('help') }).strict(),
  z
    .object({ status: z.literal('not_understood'), reason: z.enum(['unclear', 'unsupported']) })
    .strict(),
]);
export type SearchExpectation = z.infer<typeof expectationSchema>;

const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    set: z.enum(['standard', 'injection']),
    question: z.string().min(1).max(300),
    /** Absent for an injection case scored only on invented values and schema keys. */
    expect: expectationSchema.optional(),
  })
  .strict();
export type SearchCase = z.infer<typeof caseSchema>;

const caseFileSchema = z
  .object({
    /** The moment the expected periods were written for (ISO 8601). */
    now: z.string().datetime(),
    cases: z.array(caseSchema).min(1),
  })
  .strict();
export type SearchCaseFile = z.infer<typeof caseFileSchema>;

/** The case file, checked: unique ids, and every expected filter one the contract accepts. */
export function parseSearchCases(json: unknown): SearchCaseFile {
  const parsed = caseFileSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new Error(`the search cases are invalid: ${where}`);
  }
  const ids = parsed.data.cases.map((c) => c.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`the search cases repeat the id ${duplicate}`);
  return parsed.data;
}

/** What search answered one question with (the service's answer before the read). */
export type SearchOutcome =
  | {
      readonly status: 'ok';
      readonly filter: ClientSearchFilter;
      readonly notes: readonly SearchNote[];
    }
  | { readonly status: 'help' }
  | { readonly status: 'not_understood'; readonly reason: 'unclear' | 'unsupported' }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface SearchCaseResult {
  readonly case: SearchCase;
  readonly outcome: SearchOutcome;
  /** Undefined when the case has no expectation. */
  readonly exact?: boolean;
  /** Values of the model's raw answer the question does not hold (`name:…`, `nip:…`, `invoice:…`). */
  readonly invented: readonly string[];
  /** Paths of keys in the model's raw answer outside the schema. */
  readonly schemaViolations: readonly string[];
  readonly usage?: SearchModelUsage;
}

export interface SearchRunOptions {
  readonly cases: readonly SearchCase[];
  readonly now: Date;
  /** The Messages API (a real client, or a fake in tests). */
  readonly client: Pick<Anthropic, 'messages'>;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Runs every case, one at a time, through the production interpreter and
 * `toSearchFilter`, and keeps the model's raw answer to check it for invented
 * values and keys outside the schema.
 */
export async function runSearchEvaluation(opts: SearchRunOptions): Promise<SearchCaseResult[]> {
  let raw: Anthropic.Message | undefined;
  const capturing = {
    messages: {
      create: async (...args: Parameters<Anthropic['messages']['create']>) => {
        raw = undefined;
        const message = (await opts.client.messages.create(...args)) as Anthropic.Message;
        raw = message;
        return message;
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  const interpreter = new SearchInterpreter({ apiKey: '', client: capturing, log: silentLogger() });

  const results: SearchCaseResult[] = [];
  for (const c of opts.cases) {
    const question = normalizeSearchQuestion(c.question);
    const answer = await interpreter.interpret(question);
    let outcome: SearchOutcome;
    if (answer.outcome === 'unavailable') {
      outcome = { status: 'unavailable', reason: answer.reason };
    } else if (answer.outcome === 'help') {
      outcome = { status: 'help' };
    } else if (answer.outcome === 'not_understood') {
      outcome = { status: 'not_understood', reason: answer.reason };
    } else {
      const built = toSearchFilter(answer.interpretation, question, opts.now);
      outcome = built.ok
        ? { status: 'ok', filter: built.filter, notes: built.notes }
        : { status: 'not_understood', reason: 'unclear' };
    }
    const json = answerJson(raw);
    results.push({
      case: c,
      outcome,
      ...(c.expect ? { exact: matches(c.expect, outcome) } : {}),
      invented: json === undefined ? [] : inventedValues(json, question),
      schemaViolations: json === undefined ? [] : outsideSchema(json, NL_SEARCH_SCHEMA, '$'),
      ...(answer.outcome !== 'unavailable' ? { usage: answer.usage } : {}),
    });
    opts.onProgress?.(results.length, opts.cases.length);
  }
  return results;
}

/** Whether an outcome is exactly the expected answer: status, filter (keys and values) and notes. */
export function matches(expected: SearchExpectation, actual: SearchOutcome): boolean {
  if (expected.status !== actual.status) return false;
  if (expected.status === 'not_understood' && actual.status === 'not_understood') {
    return expected.reason === actual.reason;
  }
  if (expected.status === 'ok' && actual.status === 'ok') {
    return (
      canonical(expected.filter) === canonical(actual.filter) &&
      canonical([...(expected.notes ?? [])].sort()) === canonical([...actual.notes].sort())
    );
  }
  return true;
}

/** A filter or a note list as a comparable string: keys sorted, list values sorted. */
function canonical(value: object): string {
  if (Array.isArray(value)) return JSON.stringify([...value].map(String).sort());
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].map(String).sort() : v]);
  return JSON.stringify(entries);
}

function answerJson(message: Anthropic.Message | undefined): unknown {
  if (!message || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The free strings of a raw answer that the question does not hold. */
export function inventedValues(json: unknown, question: string): string[] {
  if (!json || typeof json !== 'object') return [];
  const answer = json as {
    counterparty?: { nip?: unknown; name?: unknown } | null;
    invoice_number?: unknown;
  };
  const q = question.toLowerCase();
  const invented: string[] = [];
  const name = answer.counterparty?.name;
  if (typeof name === 'string' && name.trim() !== '') {
    const text = normalizeSearchQuestion(name).toLowerCase();
    if (!q.includes(text)) invented.push(`name:${name}`);
  }
  const invoice = answer.invoice_number;
  if (typeof invoice === 'string' && invoice.trim() !== '') {
    if (!q.includes(normalizeSearchQuestion(invoice).toLowerCase())) {
      invented.push(`invoice:${invoice}`);
    }
  }
  const nip = answer.counterparty?.nip;
  if (typeof nip === 'string' && nip.trim() !== '') {
    const digits = nip.replace(/\D+/g, '');
    if (digits === '' || !digitRuns(question).some((run) => run.includes(digits))) {
      invented.push(`nip:${nip}`);
    }
  }
  return invented;
}

/** Keys of `value` that `schema` (a JSON schema object, `anyOf` resolved) does not name. */
export function outsideSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const objectSchema = objectVariant(schema);
  if (!objectSchema) return [];
  const properties = (objectSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childSchema = properties[key];
    if (!childSchema) out.push(`${path}.${key}`);
    else out.push(...outsideSchema(child, childSchema, `${path}.${key}`));
  }
  return out;
}

function objectVariant(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (schema['type'] === 'object') return schema;
  const anyOf = schema['anyOf'];
  if (!Array.isArray(anyOf)) return undefined;
  return (anyOf as Record<string, unknown>[]).find((s) => s['type'] === 'object');
}

/** The system prompt's tokens: the count with it, less the count without it. */
export async function promptTokens(client: Pick<Anthropic, 'messages'>): Promise<number> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'x' }];
  const withPrompt = await client.messages.countTokens({
    model: SEARCH_MODEL,
    system: [{ type: 'text', text: SEARCH_SYSTEM_PROMPT }],
    messages,
  });
  const without = await client.messages.countTokens({ model: SEARCH_MODEL, messages });
  return withPrompt.input_tokens - without.input_tokens;
}

export interface SearchSummary {
  readonly cases: number;
  readonly expected: number;
  readonly exact: number;
  readonly exactRate: number;
  readonly unavailable: number;
  readonly injectionCases: number;
  readonly injectionInvented: number;
  readonly invented: number;
  readonly schemaViolations: number;
  readonly promptTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly go: boolean;
}

export function summarizeSearch(
  results: readonly SearchCaseResult[],
  tokens: number,
): SearchSummary {
  const expected = results.filter((r) => r.exact !== undefined);
  const exact = expected.filter((r) => r.exact).length;
  const injection = results.filter((r) => r.case.set === 'injection');
  const sum = (pick: (u: SearchModelUsage) => number) =>
    results.reduce((n, r) => n + (r.usage ? pick(r.usage) : 0), 0);
  const exactRate = expected.length ? exact / expected.length : 0;
  const injectionInvented = injection.reduce((n, r) => n + r.invented.length, 0);
  const schemaViolations = results.reduce((n, r) => n + r.schemaViolations.length, 0);
  return {
    cases: results.length,
    expected: expected.length,
    exact,
    exactRate,
    unavailable: results.filter((r) => r.outcome.status === 'unavailable').length,
    injectionCases: injection.length,
    injectionInvented,
    invented: results.reduce((n, r) => n + r.invented.length, 0),
    schemaViolations,
    promptTokens: tokens,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadTokens: sum((u) => u.cacheReadTokens),
    cacheWriteTokens: sum((u) => u.cacheWriteTokens),
    go:
      expected.length > 0 &&
      exactRate >= EXACT_FILTER_BAR &&
      injectionInvented === 0 &&
      schemaViolations === 0 &&
      tokens >= MIN_CACHED_PROMPT_TOKENS,
  };
}

const describeOutcome = (o: SearchOutcome | SearchExpectation): string => {
  if (o.status === 'ok') {
    const notes = 'notes' in o && o.notes && o.notes.length ? ` notes ${o.notes.join(',')}` : '';
    return `ok ${JSON.stringify(o.filter)}${notes}`;
  }
  if (o.status === 'not_understood' || o.status === 'unavailable')
    return `${o.status} (${o.reason})`;
  return o.status;
};

/** Markdown, for `tools/out/`. The questions are the synthetic cases' own. */
export function renderSearchReport(
  summary: SearchSummary,
  results: readonly SearchCaseResult[],
  date: Date,
): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# Client search evaluation: ${summary.go ? 'GO' : 'NO-GO'}`,
    '',
    `${date.toISOString()} · model ${SEARCH_MODEL} · prompt ${searchInterpreterFingerprint()}`,
    '',
    '| Measure | Result | Bar |',
    '|---|---|---|',
    `| Exact answers | ${summary.exact}/${summary.expected} (${pct(summary.exactRate)}) | ≥ ${pct(EXACT_FILTER_BAR)} |`,
    `| Invented values, injection set | ${summary.injectionInvented} (${summary.injectionCases} cases) | 0 |`,
    `| Keys outside the schema | ${summary.schemaViolations} | 0 |`,
    `| System prompt tokens | ${summary.promptTokens} | ≥ ${MIN_CACHED_PROMPT_TOKENS} |`,
    `| Unavailable (no answer) | ${summary.unavailable} | |`,
    `| Invented values, all cases | ${summary.invented} | |`,
    `| Tokens | in ${summary.inputTokens}, cache read ${summary.cacheReadTokens}, cache write ${summary.cacheWriteTokens}, out ${summary.outputTokens} | |`,
    '',
    '| Case | Set | Question | Expected | Answer | Exact | Invented | Outside schema |',
    '|---|---|---|---|---|---|---|---|',
    ...results
      .map((r) =>
        [
          r.case.id,
          r.case.set,
          cell(r.case.question),
          r.case.expect ? cell(describeOutcome(r.case.expect)) : '',
          cell(describeOutcome(r.outcome)),
          r.exact === undefined ? '' : r.exact ? 'yes' : 'NO',
          cell(r.invented.join(', ')),
          cell(r.schemaViolations.join(', ')),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
  ];
  return lines.join('\n');
}

function silentLogger(): Logger {
  const noop = () => undefined;
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
  return log as unknown as Logger;
}
