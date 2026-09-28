import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { ingestionConfigSchema, thinkingDisabledProblem, type Logger } from '@bcr/shared';
import { AcceptancePolicy } from '../services/acceptancePolicy';
import { ClassificationService, FallbackClassifier } from '../services/classificationService';
import {
  CLAUDE_EFFORT,
  CLAUDE_THINKING,
  ClaudeClassifier,
  type ClaudeEffort,
  type ClaudeThinking,
} from '../services/claudeClassifier';
import { runEvaluation, summarize, type ServiceFactory } from './evaluate';
import { goNoGo, renderReport } from './report';
import {
  parseSearchCases,
  promptTokens,
  renderSearchReport,
  runSearchEvaluation,
  summarizeSearch,
} from './searchEval';
import { arbiterToTruth, parseTruth, type ArbiterRow } from './truth';

/** Everything the CLI touches outside itself, so tests can run it offline. */
export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Tests only: a fake Messages API. Without it, a real client is built from the key. */
  readonly anthropicClient?: Pick<Anthropic, 'messages'>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * The synthetic search cases, relative to the package (where `yarn workspace … eval:search` runs).
 * Outside `src/`: the packager ships only compiled TypeScript and refuses any other file there.
 */
export const DEFAULT_SEARCH_CASES = 'fixtures/search-questions.json';

export const USAGE = `Usage:
  eval run --dir <folder> --truth <truth.json> [--client-name <name>] [--client-nip <nip>]
           [--out <report.md>] [--model <id>] [--effort low|medium|high] [--thinking adaptive|disabled]
           [--threshold <0.70-0.95>]
           [--concurrency <1-4>] [--retry-passes <n>] [--retry-delay-ms <ms>]
  eval truth --arbiter <arbiter.json> [--out <truth.json>] [--client-name <name>] [--client-nip <nip>]
  eval search [--cases <cases.json>] [--out <report.md>] [--now <ISO time>]

run classifies every document of truth.json from <folder> with the real Claude
classifier and acceptance policy, and reports accuracy, direction, month, review
rate, confidence and tokens. It reads ANTHROPIC_API_KEY from this shell's
environment (never from Key Vault) and sends each document to the Anthropic API
only. ANTHROPIC_MODEL and CLASSIFICATION_ACCEPT_THRESHOLD are used when set.

truth converts the independent reviewers' arbiter report into truth.json.

search turns every synthetic question of <cases.json> (default ${DEFAULT_SEARCH_CASES})
into a filter with the real search interpreter, and reports exact answers,
invented values, keys outside the schema, the system prompt's tokens and GO /
NO-GO. Periods are read at the file's "now" unless --now is given. It reads
ANTHROPIC_API_KEY from this shell only, and sends only the questions.`;

/** Exit codes: 0 done (whatever the verdict), 2 bad arguments or input. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'run') return await runCommand(rest, deps);
    if (command === 'truth') return await truthCommand(rest, deps);
    if (command === 'search') return await searchCommand(rest, deps);
    deps.stderr(`${USAGE}\n`);
    return command === '--help' || command === 'help' ? 0 : 2;
  } catch (err) {
    deps.stderr(`eval: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

const COMMON_OPTIONS = {
  'client-name': { type: 'string' },
  'client-nip': { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

async function runCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      ...COMMON_OPTIONS,
      dir: { type: 'string' },
      truth: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      thinking: { type: 'string' },
      threshold: { type: 'string' },
      concurrency: { type: 'string' },
      'retry-passes': { type: 'string' },
      'retry-delay-ms': { type: 'string' },
    },
  });
  if (values.help) return usage(deps);
  if (!values.dir || !values.truth) throw new Error('--dir and --truth are required');
  const dir = values.dir;

  const apiKey = (deps.env['ANTHROPIC_API_KEY'] ?? '').trim();
  if (!apiKey && !deps.anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY is not set in this shell; export it for this run only');
  }
  const shape = ingestionConfigSchema.shape;
  const model = shape.anthropicModel.parse(values.model ?? deps.env['ANTHROPIC_MODEL']);
  const maxContentBytes = shape.anthropicMaxContentBytes.parse(
    deps.env['ANTHROPIC_MAX_CONTENT_BYTES'],
  );
  const thresholdResult = shape.classificationAcceptThreshold.safeParse(
    values.threshold ?? deps.env['CLASSIFICATION_ACCEPT_THRESHOLD'],
  );
  if (!thresholdResult.success) throw new Error('--threshold must be a number from 0.70 to 0.95');
  const threshold = thresholdResult.data;
  const effort = effortOf(values.effort);
  const thinking = thinkingOf(values.thinking);
  // As at cold start: a model that refuses it would turn every call into a 400.
  const thinkingProblem = thinkingDisabledProblem({
    anthropicThinking: thinking,
    anthropicModel: model,
  });
  if (thinkingProblem) throw new Error(thinkingProblem);
  const client = identityOf(values['client-name'], values['client-nip']);

  const entries = parseTruth(JSON.parse((await deps.readFile(values.truth)).toString('utf8')));
  const policy = new AcceptancePolicy(threshold);
  const quiet = silentLogger();
  const makeService: ServiceFactory = (onUsage) =>
    new ClassificationService(
      [
        new ClaudeClassifier({
          apiKey,
          model,
          maxContentBytes,
          effort,
          thinking,
          onUsage,
          log: quiet,
          ...(deps.anthropicClient ? { client: deps.anthropicClient } : {}),
        }),
        new FallbackClassifier(),
      ],
      { policy, log: quiet },
    );

  const results = await runEvaluation({
    entries,
    readDocument: (file) => deps.readFile(join(dir, file)),
    makeService,
    ...(client ? { client } : {}),
    concurrency: wholeNumber(values.concurrency, 2, 1, 4, '--concurrency'),
    retryPasses: wholeNumber(values['retry-passes'], 2, 0, 5, '--retry-passes'),
    retryDelayMs: wholeNumber(values['retry-delay-ms'], 30_000, 0, 600_000, '--retry-delay-ms'),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    onProgress: (done, total) => deps.stderr(`\r${done}/${total}`),
  });
  const summary = summarize(results, client !== undefined);
  const report = renderReport(summary, results, {
    date: (deps.now ?? (() => new Date()))(),
    model,
    effort,
    thinking,
    threshold,
    identityGiven: client !== undefined,
  });
  if (values.out) await deps.writeFile(values.out, report);
  else deps.stdout(report);

  const verdict = goNoGo(summary);
  deps.stderr(
    `\ncategory ${summary.category.hit}/${summary.category.of} (${verdict.category}), ` +
      `direction ${verdict.direction}, retry later ${summary.retryLater}, ` +
      `retry exhausted ${summary.retryExhausted}, ` +
      `review ${summary.review.hit}/${summary.review.of}, ` +
      `tokens in ${summary.inputTokens} (cache read ${summary.cacheReadInputTokens}, ` +
      `write ${summary.cacheCreationInputTokens}) / out ${summary.outputTokens}: ` +
      `${verdict.go ? 'GO' : 'NO-GO'}` +
      `${values.out ? `; report written to ${values.out}` : ''}\n`,
  );
  return 0;
}

async function truthCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: { ...COMMON_OPTIONS, arbiter: { type: 'string' } },
  });
  if (values.help) return usage(deps);
  if (!values.arbiter) throw new Error('--arbiter is required');
  const rows: unknown = JSON.parse((await deps.readFile(values.arbiter)).toString('utf8'));
  if (!Array.isArray(rows)) throw new Error('the arbiter report must be a JSON array');
  const identity = {
    ...(values['client-name'] ? { name: values['client-name'] } : {}),
    ...(values['client-nip'] ? { nip: values['client-nip'] } : {}),
  };
  const entries = arbiterToTruth(rows as ArbiterRow[], identity);
  const json = `${JSON.stringify(entries, null, 2)}\n`;
  if (values.out) await deps.writeFile(values.out, json);
  else deps.stdout(json);

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  deps.stderr(
    `${entries.length} entries (${entries.filter((e) => e.direction).length} with a direction): ` +
      `${[...counts].map(([c, n]) => `${c} ${n}`).join(', ')}\n`,
  );
  return 0;
}

async function searchCommand(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      cases: { type: 'string' },
      out: { type: 'string' },
      now: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return usage(deps);
  const apiKey = (deps.env['ANTHROPIC_API_KEY'] ?? '').trim();
  if (!apiKey && !deps.anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY is not set in this shell; export it for this run only');
  }
  const file = parseSearchCases(
    JSON.parse((await deps.readFile(values.cases ?? DEFAULT_SEARCH_CASES)).toString('utf8')),
  );
  const now = new Date(values.now ?? file.now);
  if (Number.isNaN(now.getTime())) throw new Error('--now must be an ISO 8601 time');
  const client = deps.anthropicClient ?? new Anthropic({ apiKey });

  const tokens = await promptTokens(client);
  const results = await runSearchEvaluation({
    cases: file.cases,
    now,
    client,
    onProgress: (done, total) => deps.stderr(`\r${done}/${total}`),
  });
  const summary = summarizeSearch(results, tokens);
  const report = renderSearchReport(summary, results, (deps.now ?? (() => new Date()))());
  if (values.out) await deps.writeFile(values.out, report);
  else deps.stdout(report);
  deps.stderr(
    `\nexact ${summary.exact}/${summary.expected}, invented (injection) ` +
      `${summary.injectionInvented}, outside schema ${summary.schemaViolations}, ` +
      `prompt ${summary.promptTokens} tokens, unavailable ${summary.unavailable}: ` +
      `${summary.go ? 'GO' : 'NO-GO'}${values.out ? `; report written to ${values.out}` : ''}\n`,
  );
  return 0;
}

function usage(deps: CliDeps): number {
  deps.stderr(`${USAGE}\n`);
  return 0;
}

function effortOf(value: string | undefined): ClaudeEffort {
  if (value === undefined) return CLAUDE_EFFORT;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('--effort must be low, medium or high');
}

function thinkingOf(value: string | undefined): ClaudeThinking {
  if (value === undefined) return CLAUDE_THINKING;
  if (value === 'adaptive' || value === 'disabled') return value;
  throw new Error('--thinking must be adaptive or disabled');
}

function identityOf(
  name: string | undefined,
  nip: string | undefined,
): { nip: string; companyName: string } | undefined {
  const companyName = (name ?? '').trim();
  const digits = (nip ?? '').replace(/\D+/g, '');
  if (nip !== undefined && digits.length !== 10)
    throw new Error('--client-nip must have 10 digits');
  return companyName || digits ? { nip: digits, companyName } : undefined;
}

function wholeNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** The harness reports through its own output; the classifier's log lines would only interleave. */
function silentLogger(): Logger {
  const noop = () => undefined;
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
  return log as unknown as Logger;
}
