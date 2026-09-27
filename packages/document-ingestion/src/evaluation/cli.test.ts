import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { runCli, USAGE, type CliDeps } from './cli';

// Synthetic documents only: text files the fake API answers by their content.
const CLIENT_NIP = '1234567890';
const OTHER_NIP = '5555555555';
const DIR = '/docs';

function answer(
  output: Record<string, unknown>,
  usage = { input_tokens: 1000, output_tokens: 100 },
) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          year: null,
          month: null,
          client_role: 'unknown',
          parties: [],
          ...output,
        }),
      },
    ],
  };
}

const party = (role: string, nip: string) => ({ role, nip, company_name: null, person_name: null });

/** A fake Messages API: the document text says what to answer. */
function fakeApi() {
  let overloadedOnce = true;
  const create = jest.fn(
    async (params: { messages: { content: { type: string; text?: string }[] }[] }) => {
      const text = params.messages[0]?.content[0]?.text ?? '';
      if (text === 'SALE') {
        return answer({
          category: 'faktury_zakupu',
          year: 2026,
          month: 9,
          confidence: 0.95,
          client_role: 'buyer',
          parties: [party('seller', CLIENT_NIP), party('buyer', OTHER_NIP)],
        });
      }
      if (text === 'RECEIPT') {
        return answer({ category: 'faktury_noty', year: 2026, month: 8, confidence: 0.9 });
      }
      if (text === 'BUSY') {
        if (overloadedOnce) {
          overloadedOnce = false;
          throw Anthropic.APIError.generate(529, { type: 'error' }, 'Overloaded', new Headers());
        }
        return answer({ category: 'umowy', confidence: 0.9 });
      }
      return answer({ category: 'inne', confidence: 0.4 });
    },
  );
  return { messages: { create } } as unknown as Pick<Anthropic, 'messages'> & {
    messages: { create: jest.Mock };
  };
}

function harness(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  const written: Record<string, string> = {};
  const out: string[] = [];
  const err: string[] = [];
  const api = fakeApi();
  const deps: CliDeps = {
    env,
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return Buffer.from(content);
    },
    writeFile: async (path, data) => {
      written[path] = data;
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    anthropicClient: api,
    sleep: async () => undefined,
    now: () => new Date('2026-09-26T10:00:00Z'),
  };
  return { deps, written, out, err, api };
}

const truth = [
  { file: 'sale.txt', category: 'faktura', month: '2026-09', direction: 'sprzedaz' },
  { file: 'receipt.txt', category: 'faktury_noty', month: '2026-08' },
  { file: 'busy.txt', category: 'umowy', month: '' },
  { file: 'unsure.txt', category: 'inne', month: '' },
  { file: 'archive.zip', category: 'inne', month: '' },
];

const files = {
  '/truth.json': JSON.stringify(truth),
  [join(DIR, 'sale.txt')]: 'SALE',
  [join(DIR, 'receipt.txt')]: 'RECEIPT',
  [join(DIR, 'busy.txt')]: 'BUSY',
  [join(DIR, 'unsure.txt')]: 'UNSURE',
  [join(DIR, 'archive.zip')]: 'PK',
};

describe('eval run', () => {
  it('classifies each document with the real classifier and policy, and writes the report', async () => {
    const { deps, written, err, api } = harness(files);

    const code = await runCli(
      [
        'run',
        '--dir',
        DIR,
        '--truth',
        '/truth.json',
        '--client-name',
        'Biuro Testowe Sp. z o.o.',
        '--client-nip',
        '123-456-78-90',
        '--out',
        '/report.md',
        '--concurrency',
        '1',
      ],
      deps,
    );

    expect(code).toBe(0);
    const report = written['/report.md'] ?? '';
    // The sale the model guessed as a purchase is filed by the client's NIP.
    expect(report).toMatch(
      /\| sale\.txt \| `faktury_sprzedazy` \(sprzedaz\) \| 2026-09 \| `faktury_sprzedazy` \| `faktury_sprzedazy` \| 2026-09 \| 0\.95 \| — \| ok \|/,
    );
    expect(report).toMatch(/\| receipt\.txt \|.*\| ok \|/);
    // 529 on the first pass, answered on the retry pass: never filed to 98_ for it.
    expect(report).toMatch(/\| busy\.txt \|.*\| ok \|/);
    expect(report).toMatch(/\| unsure\.txt \|.*LOW_CONFIDENCE \| review \(category right\) \|/);
    expect(report).toMatch(/\| archive\.zip \|.*no model answer \(unsupported_type\) \|/);
    expect(report).toContain('| Direction 100% when the client is a party | PASS | 1/1 correct');
    expect(report).toContain('client identity given');
    expect(report).not.toContain('Biuro Testowe');
    expect(report).not.toContain(CLIENT_NIP);

    // The primed identity is the one given, digits only.
    const turn = api.messages.create.mock.calls[0]?.[0].messages[0].content[1].text as string;
    expect(turn).toContain(`Biuro Testowe Sp. z o.o., NIP ${CLIENT_NIP}`);
    expect(api.messages.create.mock.calls[0]?.[0].model).toBe('claude-opus-5');
    expect(err.join('')).toMatch(/category 4\/4 \(PASS\), direction PASS, retry later 0/);
    expect(err.join('')).toContain('report written to /report.md');
  });

  it('prints the report when there is no --out, and runs without an identity', async () => {
    const { deps, out, written } = harness(files, {
      ANTHROPIC_MODEL: 'claude-opus-4-5-20251101',
      CLASSIFICATION_ACCEPT_THRESHOLD: '0.8',
    });
    const code = await runCli(
      ['run', '--dir', DIR, '--truth', '/truth.json', '--effort', 'medium'],
      deps,
    );
    expect(code).toBe(0);
    expect(written).toEqual({});
    const report = out.join('');
    expect(report).toContain(
      'Model `claude-opus-4-5-20251101`, effort `medium`, thinking `adaptive`, accept threshold 0.80',
    );
    expect(report).toContain('client identity not given');
    // Without an identity the sale is not guessed: it goes to review.
    expect(report).toMatch(
      /\| sale\.txt \|.*DIRECTION_UNRESOLVED.*\| review \(category right\) \|/,
    );
  });

  it('runs with thinking disabled on a model that takes it, and says so', async () => {
    const { deps, out, api } = harness(files);
    const code = await runCli(
      [
        'run',
        '--dir',
        DIR,
        '--truth',
        '/truth.json',
        '--model',
        'claude-sonnet-5',
        '--thinking',
        'disabled',
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(api.messages.create.mock.calls[0]?.[0].thinking).toEqual({ type: 'disabled' });
    expect(out.join('')).toContain('Model `claude-sonnet-5`, effort `low`, thinking `disabled`');
  });

  it('needs ANTHROPIC_API_KEY from the environment when no client is injected', async () => {
    const { deps, err } = harness(files);
    const { anthropicClient: _unused, ...withoutClient } = deps;
    void _unused;
    expect(await runCli(['run', '--dir', DIR, '--truth', '/truth.json'], withoutClient)).toBe(2);
    expect(err.join('')).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it.each([
    [['run', '--truth', '/truth.json'], /--dir and --truth are required/],
    [['run', '--dir', DIR, '--truth', '/truth.json', '--threshold', '0.69'], /0.70 to 0.95/],
    [['run', '--dir', DIR, '--truth', '/truth.json', '--effort', 'max'], /--effort/],
    [['run', '--dir', DIR, '--truth', '/truth.json', '--thinking', 'off'], /--thinking must be/],
    [
      [
        'run',
        '--dir',
        DIR,
        '--truth',
        '/truth.json',
        '--model',
        'claude-opus-5-5',
        '--thinking',
        'disabled',
      ],
      /'disabled' is not accepted by ANTHROPIC_MODEL claude-opus-5-5/,
    ],
    [['run', '--dir', DIR, '--truth', '/truth.json', '--client-nip', '123'], /10 digits/],
    [['run', '--dir', DIR, '--truth', '/truth.json', '--concurrency', '9'], /--concurrency/],
    [['run', '--dir', DIR, '--truth', '/missing.json'], /ENOENT/],
    [['run', '--dir', DIR, '--truth', '/truth.json', '--bogus', 'x'], /bogus/],
  ])('refuses %j', async (argv, message) => {
    const { deps, err } = harness(files);
    expect(await runCli(argv, deps)).toBe(2);
    expect(err.join('')).toMatch(message);
  });

  it('prints its usage for help, and fails for an unknown command', async () => {
    const help = harness(files);
    expect(await runCli(['--help'], help.deps)).toBe(0);
    expect(help.err.join('')).toBe(`${USAGE}\n`);
    for (const argv of [
      ['run', '--help'],
      ['truth', '-h'],
    ]) {
      const each = harness(files);
      expect(await runCli(argv, each.deps)).toBe(0);
      expect(each.err.join('')).toBe(`${USAGE}\n`);
    }
    expect(await runCli(['classify'], harness(files).deps)).toBe(2);
    expect(await runCli([], harness(files).deps)).toBe(2);
  });
});

describe('eval truth', () => {
  const arbiter = [
    {
      local: '/somewhere/fv-1.pdf',
      reviewerCategory: 'direction_unknown',
      pipelineCategory: 'faktury_zakupu',
      verdict: 'disagree',
      month: '2026-09',
      seller: 'Biuro Testowe Sp. z o.o.',
      buyer: 'Kontrahent Sp. z o.o.',
      adjudication: { winner: 'both_acceptable', correctCategory: 'direction_unknown' },
    },
    { local: '/somewhere/umowa.pdf', reviewerCategory: 'umowy', verdict: 'agree', month: '' },
  ];

  it('converts the arbiter report into truth.json, with directions for the given client', async () => {
    const { deps, written, err } = harness({ '/arbiter.json': JSON.stringify(arbiter) });
    const code = await runCli(
      [
        'truth',
        '--arbiter',
        '/arbiter.json',
        '--out',
        '/truth.json',
        '--client-name',
        'Biuro Testowe Sp. z o.o.',
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(written['/truth.json'] ?? '')).toEqual([
      { file: 'fv-1.pdf', category: 'faktury_sprzedazy', month: '2026-09', direction: 'sprzedaz' },
      { file: 'umowa.pdf', category: 'umowy', month: '' },
    ]);
    expect(err.join('')).toBe('2 entries (1 with a direction): faktury_sprzedazy 1, umowy 1\n');
  });

  it('prints to stdout without --out, and takes a NIP', async () => {
    const { deps, out } = harness({ '/arbiter.json': JSON.stringify(arbiter) });
    expect(
      await runCli(['truth', '--arbiter', '/arbiter.json', '--client-nip', CLIENT_NIP], deps),
    ).toBe(0);
    expect(JSON.parse(out.join(''))[0]).toEqual({
      file: 'fv-1.pdf',
      category: 'faktura',
      month: '2026-09',
    });
  });

  it.each([
    [[], /--arbiter is required/, '[]'],
    [['--arbiter', '/arbiter.json'], /must be a JSON array/, '{}'],
    [['--arbiter', '/arbiter.json'], /row 0/, JSON.stringify([{ verdict: 'agree' }])],
  ])('refuses %j', async (args, message, content) => {
    const { deps, err } = harness({ '/arbiter.json': content });
    expect(await runCli(['truth', ...args], deps)).toBe(2);
    expect(err.join('')).toMatch(message);
  });
});
