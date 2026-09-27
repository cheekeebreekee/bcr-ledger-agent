import Anthropic from '@anthropic-ai/sdk';
import type { Classification, ClassifierContext, Logger } from '@bcr/shared';
import { PDFDocument } from 'pdf-lib';
import {
  apiErrorDetail,
  CLASSIFICATION_OUTPUT_SCHEMA,
  CLAUDE_ACCOUNT_PAUSE_MS,
  CLAUDE_EFFORT,
  CLAUDE_MAX_RETRIES,
  CLAUDE_MAX_TOKENS,
  CLAUDE_REQUEST_TIMEOUT_MS,
  CLAUDE_THINKING,
  ClaudeClassifier,
  SYSTEM_PROMPT,
  buildExtraction,
  classifierFingerprint,
  classifyApiError,
  clientIdentity,
  userInstruction,
  type ClaudeUsage,
} from './claudeClassifier';
import { DIRECTION_UNRESOLVED } from './invoiceDirection';
import { countsAgainstDocument } from './retryLaterBound';

type CreateFn = jest.Mock;

const CLIENT = { nip: '1111111111', companyName: 'Klient Testowy Sp. z o.o.' };

/** A structured-output response: optional (empty) thinking, then the JSON text. */
function answer(output: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 180 },
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
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
    ...over,
  };
}

function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const write = (obj: unknown) => lines.push({ ...(obj as Record<string, unknown>) });
  const log = { info: write, warn: write, error: write, debug: write } as unknown as Logger;
  return { log, lines };
}

const ctx = (overrides: Partial<ClassifierContext> = {}): ClassifierContext => ({
  filename: '1111111111-20260917-ABCDEF.pdf',
  contentType: 'application/pdf',
  readContent: async () => Buffer.from('%PDF-1.7 fake'),
  ...overrides,
});

function classifier(
  create: CreateFn,
  over: Partial<ConstructorParameters<typeof ClaudeClassifier>[0]> = {},
) {
  const { log, lines } = recordingLogger();
  const c = new ClaudeClassifier({
    apiKey: 'test-key',
    model: 'claude-opus-5',
    maxContentBytes: 10 * 1024 * 1024,
    client: { messages: { create } } as never,
    log,
    ...over,
  });
  return { c, lines };
}

async function syntheticPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i += 1)
    doc.addPage([200, 200]).drawText(`Strona ${i}`, { x: 20, y: 100 });
  return Buffer.from(await doc.save());
}

const headers = new Headers();

describe('ClaudeClassifier: the request', () => {
  it('bounds each API call well inside the batch deadline', () => {
    const c = new ClaudeClassifier({ apiKey: 'k', model: 'claude-opus-5', maxContentBytes: 1 });
    const client = (c as unknown as { client: Anthropic }).client;
    expect(client.timeout).toBe(CLAUDE_REQUEST_TIMEOUT_MS);
    expect(client.maxRetries).toBe(CLAUDE_MAX_RETRIES);
    // Worst case: the first attempt and one retry both time out.
    expect(CLAUDE_REQUEST_TIMEOUT_MS * (CLAUDE_MAX_RETRIES + 1)).toBeLessThan(150_000);
  });

  it('asks for structured output at low effort, with no tools, sampling or thinking fields', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create);
    await c.classify(ctx());

    const arg = create.mock.calls[0][0];
    expect(arg).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: CLAUDE_MAX_TOKENS,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: CLASSIFICATION_OUTPUT_SCHEMA },
      },
    });
    const forbidden = ['tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'thinking'].filter(
      (k) => k in arg,
    );
    expect(forbidden).toEqual([]);
    expect(CLAUDE_EFFORT).toBe('low');
  });

  // Output tokens cost five times input: nothing is asked for that nothing reads.
  it('asks for no free-text reasoning, and keeps none a model sends anyway', async () => {
    const props = Object.keys(
      (CLASSIFICATION_OUTPUT_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    expect(props).not.toContain('reasoning');
    const create = jest.fn().mockResolvedValue({
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        {
          type: 'text',
          text: JSON.stringify({ category: 'inne', confidence: 0.9, reasoning: 'free text' }),
        },
      ],
    });
    const result = (await classifier(create).c.classify(ctx())) as Classification;
    expect(JSON.stringify(result)).not.toContain('free text');
  });

  it('runs at another effort when told to', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create, { effort: 'medium' });
    await c.classify(ctx());
    expect(create.mock.calls[0][0].output_config.effort).toBe('medium');
  });

  it('turns thinking off only when told to', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    await classifier(create, { thinking: 'disabled' }).c.classify(ctx());
    await classifier(create, { thinking: 'adaptive' }).c.classify(ctx());
    expect(create.mock.calls[0][0].thinking).toEqual({ type: 'disabled' });
    expect('thinking' in create.mock.calls[1][0]).toBe(false);
    expect(CLAUDE_THINKING).toBe('adaptive');
  });

  // Prompt caching: the prefix must be byte-identical for every client and
  // document, or every call pays full price for it (and a client's data
  // would sit in a shared cache entry).
  it('sends one cached system block, the same bytes for every client and document', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create);
    await c.classify(ctx({ client: CLIENT, filename: 'a.pdf' }));
    await c.classify(
      ctx({ client: { nip: '2222222222', companyName: 'Inny Klient S.A.' }, filename: 'b.pdf' }),
    );
    await c.classify(ctx({ filename: 'c.pdf' }));

    const systems = create.mock.calls.map((call) => call[0].system);
    expect(systems[0]).toEqual([
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    expect(systems[1]).toEqual(systems[0]);
    expect(systems[2]).toEqual(systems[0]);
    const leaked = ['1111111111', '2222222222', 'Klient Testowy', 'Inny Klient', '.pdf'].filter(
      (s) => SYSTEM_PROMPT.includes(s),
    );
    expect(leaked).toEqual([]);
  });

  it('declares a schema structured outputs accept: closed objects, every property required, no numeric bounds', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      for (const bound of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) {
        if (bound in n) offenders.push(`${path}: ${bound}`);
      }
      if (n['type'] === 'object') {
        const props = Object.keys((n['properties'] as object) ?? {});
        if (n['additionalProperties'] !== false) offenders.push(`${path}: open object`);
        const required = (n['required'] as string[]) ?? [];
        const missing = props.filter((p) => !required.includes(p));
        if (missing.length) offenders.push(`${path}: not required ${missing.join(',')}`);
      }
      for (const [k, v] of Object.entries(n)) {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`));
        else walk(v, `${path}.${k}`);
      }
    };
    walk(CLASSIFICATION_OUTPUT_SCHEMA, '$');
    expect(offenders).toEqual([]);
  });

  it('passes a PDF as a document block, an image as an image block, text as text', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'inne', confidence: 0.9 }));
    const { c } = classifier(create);
    await c.classify(ctx());
    await c.classify(
      ctx({
        contentType: 'image/png; charset=binary',
        readContent: async () => Buffer.from('img'),
      }),
    );
    await c.classify(
      ctx({ contentType: 'text/plain', readContent: async () => Buffer.from('Szanowni Państwo') }),
    );

    const blocks = create.mock.calls.map((call) => call[0].messages[0].content[0]);
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
    });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Szanowni Państwo' });
  });

  it('primes only the bound client’s own identity, in the user turn, with the rules from the evaluation', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create);
    await c.classify(ctx({ client: { nip: '111-111-11-11', companyName: CLIENT.companyName } }));
    const content = create.mock.calls[0][0].messages[0].content;
    // The document first, then the text that names the client and the file.
    expect(content.map((b: { type: string }) => b.type)).toEqual(['document', 'text']);
    const turn = content[1].text as string;
    expect(turn).toContain('Klient Testowy Sp. z o.o., NIP 1111111111');
    expect(turn).toContain('client_role');
    for (const rule of [
      'klantenbon',
      'BEZ danych nabywcy',
      'pro forma',
      'OWU',
      '450 zł',
      'rachunek hotelowy',
    ]) {
      expect(SYSTEM_PROMPT).toContain(rule);
    }
    expect(SYSTEM_PROMPT).toContain('Tożsamość klienta (nazwa i NIP)');
  });

  it('tells the model when no identity is given, and that direction is not its call', () => {
    const turn = userInstruction('x.pdf', undefined, undefined);
    expect(turn).toMatch(/Tożsamość klienta nie jest podana/);
    expect(turn).toMatch(/client_role na unknown/);
    expect(clientIdentity({ nip: '', companyName: 'Tylko Nazwa' })).toContain('Tylko Nazwa');
    expect(clientIdentity({ nip: '1111111111', companyName: '' })).toContain(
      '(nazwa nieznana), NIP 1111111111',
    );
  });
});

describe('ClaudeClassifier: results', () => {
  it("files a sales invoice from the client's NIP on the seller's side", async () => {
    const create = jest.fn().mockResolvedValue(
      answer({
        category: 'faktury_zakupu',
        year: 2026,
        month: 9,
        confidence: 0.95,
        client_role: 'seller',
        parties: [
          {
            role: 'seller',
            nip: '111-111-11-11',
            company_name: CLIENT.companyName,
            person_name: null,
          },
          {
            role: 'buyer',
            nip: '2222222222',
            company_name: 'Kontrahent Sp. z o.o.',
            person_name: null,
          },
        ],
      }),
    );
    const { c } = classifier(create);
    const result = (await c.classify(ctx({ client: CLIENT }))) as Classification;

    expect(result).toMatchObject({
      classifier: 'claude',
      model: 'claude-opus-5',
      confidence: 0.95,
      documentType: 'Faktura sprzedaży',
      folderPath: '01_Faktury/01_Faktury_sprzedaży/2026/09',
      fields: {
        category: 'faktury_sprzedazy',
        year: 2026,
        month: 9,
        direction: 'sprzedaz',
        directionSource: 'nip',
      },
    });
    expect(result.reviewReasons).toBeUndefined();
  });

  // Four of BCR's own sales invoices were filed as purchases when the model
  // was asked without an identity. It must not guess.
  it('flags an invoice without a client identity as DIRECTION_UNRESOLVED, with lowered confidence', async () => {
    const create = jest.fn().mockResolvedValue(
      answer({
        category: 'faktury_zakupu',
        year: 2026,
        month: 9,
        confidence: 0.97,
        client_role: 'buyer',
      }),
    );
    const { c } = classifier(create);
    const result = (await c.classify(ctx())) as Classification;
    expect(result.reviewReasons).toEqual([DIRECTION_UNRESOLVED]);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
    expect(result.fields['direction']).toBeUndefined();
  });

  it('keeps a dated suggestion without a date, for the acceptance policy to judge', async () => {
    const create = jest
      .fn()
      .mockResolvedValue(
        answer({ category: 'wyciagi_bankowe', confidence: 0.95, month: 13, year: 2026 }),
      );
    const { c } = classifier(create);
    const result = (await c.classify(ctx())) as Classification;
    expect(result.fields).toMatchObject({ category: 'wyciagi_bankowe' });
    expect(result.fields['month']).toBeUndefined();
    expect(result.folderPath).toBe('');
  });

  it('passes an unknown category through as a suggestion, with no folder', async () => {
    const create = jest
      .fn()
      .mockResolvedValue(answer({ category: 'totally_made_up', confidence: 0.99 }));
    const { c } = classifier(create);
    const result = (await c.classify(ctx())) as Classification;
    expect(result).toMatchObject({
      documentType: '',
      folderPath: '',
      fields: { category: 'totally_made_up' },
    });
  });

  it('keeps the month of an undated category and clamps the confidence', async () => {
    const create = jest
      .fn()
      .mockResolvedValue(answer({ category: 'umowy', confidence: 1.4, year: 2025, month: 3 }));
    const { c } = classifier(create);
    const result = (await c.classify(ctx())) as Classification;
    expect(result).toMatchObject({
      folderPath: '04_Umowy',
      confidence: 1,
      fields: { year: 2025, month: 3 },
    });
  });

  it('normalises parties and drops the ones with no signal', async () => {
    const create = jest.fn().mockResolvedValue(
      answer({
        category: 'umowy',
        confidence: 0.9,
        parties: [
          {
            role: 'seller',
            nip: '123-456-78-90',
            company_name: ' Dostawca Sp. z o.o. ',
            person_name: null,
          },
          { role: 'strange', nip: null, company_name: null, person_name: 'Jan Kowalski' },
          { role: 'unknown', nip: null, company_name: null, person_name: null },
        ],
      }),
    );
    const { c } = classifier(create);
    const result = (await c.classify(ctx())) as Classification;
    expect(result.parties).toEqual([
      { role: 'seller', nip: '1234567890', companyName: 'Dostawca Sp. z o.o.' },
      { role: 'unknown', personName: 'Jan Kowalski' },
    ]);
  });

  it('leaves parties undefined when none are returned, and defaults the client role', async () => {
    const create = jest.fn().mockResolvedValue({
      model: '',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify({ category: 'inne', confidence: 0.9 }) }],
    });
    const { c } = classifier(create);
    const result = (await c.classify(ctx())) as Classification;
    expect(result.parties).toBeUndefined();
    expect(result.fields['clientRole']).toBe('unknown');
    expect(result.model).toBe('claude-opus-5');
  });

  it('reports each response’s token usage, cache reads and writes included', async () => {
    const usage: ClaudeUsage[] = [];
    const create = jest.fn().mockResolvedValue(
      answer(
        { category: 'umowy', confidence: 0.9 },
        {
          usage: {
            input_tokens: 1200,
            output_tokens: 180,
            cache_read_input_tokens: 1800,
            cache_creation_input_tokens: 0,
          },
        },
      ),
    );
    const { c, lines } = classifier(create, { onUsage: (u) => usage.push(u) });
    const result = (await c.classify(ctx())) as Classification;
    const expected = {
      inputTokens: 1200,
      outputTokens: 180,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 0,
    };
    expect(usage).toEqual([{ model: 'claude-opus-5', ...expected }]);
    expect(result.usage).toEqual(expected);
    expect(lines.filter((l) => l['event'] === 'claude.usage')).toEqual([
      expect.objectContaining({
        model: 'claude-opus-5',
        effort: 'low',
        thinking: 'adaptive',
        stopReason: 'end_turn',
        ...expected,
      }),
    ]);
  });

  // A refused or truncated answer is billed too: the bill must count it.
  it('logs the usage of a response it cannot use', async () => {
    const create = jest
      .fn()
      .mockResolvedValue(
        answer({ category: 'umowy', confidence: 0.9 }, { stop_reason: 'refusal' }),
      );
    const { c, lines } = classifier(create);
    expect(await c.classify(ctx())).toEqual({
      outcome: 'no_result',
      reason: 'refusal',
      usage: {
        inputTokens: 1200,
        outputTokens: 180,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    expect(lines.filter((l) => l['event'] === 'claude.usage')).toEqual([
      expect.objectContaining({ inputTokens: 1200, outputTokens: 180, stopReason: 'refusal' }),
    ]);
  });

  it('logs usage as ids and counts only, never the file or the client', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c, lines } = classifier(create);
    await c.classify(ctx({ client: CLIENT }));
    const line = JSON.stringify(lines.filter((l) => l['event'] === 'claude.usage'));
    const leaked = [CLIENT.nip, CLIENT.companyName, '20260917', '.pdf'].filter((s) =>
      line.includes(s),
    );
    expect(leaked).toEqual([]);
  });
});

describe('ClaudeClassifier: long PDFs', () => {
  it('classifies a PDF over 5 pages from its first 4 and its last, and never changes the original', async () => {
    const original = await syntheticPdf(33);
    const before = Buffer.from(original);
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c, lines } = classifier(create);

    const result = (await c.classify(ctx({ readContent: async () => original }))) as Classification;

    const [block, instruction] = create.mock.calls[0][0].messages[0].content;
    const sent = await PDFDocument.load(Buffer.from(block.source.data, 'base64'));
    expect(sent.getPageCount()).toBe(5);
    expect(instruction.text).toContain(
      'Dokument ma 33 stron; załączono tylko strony 1–4 i ostatnią (33).',
    );
    expect(result.fields).toMatchObject({ pagesRead: 5, pageCount: 33 });
    expect(lines.filter((l) => l['event'] === 'claude.usage')).toEqual([
      expect.objectContaining({ pagesSent: 5, pageCount: 33 }),
    ]);
    expect(original.equals(before)).toBe(true);
  });

  it('sends a PDF of 5 pages whole', async () => {
    const pdf = await syntheticPdf(5);
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create);
    await c.classify(ctx({ readContent: async () => pdf }));
    const [block, instruction] = create.mock.calls[0][0].messages[0].content;
    expect(Buffer.from(block.source.data, 'base64').equals(pdf)).toBe(true);
    expect(instruction.text).not.toContain('stron');
  });

  it('gives no result, with its own reason, when a long PDF cannot be shortened', async () => {
    const pdf = await syntheticPdf(101);
    const copy = jest.spyOn(PDFDocument, 'create').mockRejectedValueOnce(new Error('broken'));
    const create = jest.fn();
    const { c, lines } = classifier(create);

    expect(await c.classify(ctx({ readContent: async () => pdf }))).toEqual({
      outcome: 'no_result',
      reason: 'pdf_trim_failed',
    });
    expect(create).not.toHaveBeenCalled();
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'claude.no_result',
        reason: 'pdf_trim_failed',
        pageCount: 101,
      }),
    );
    copy.mockRestore();
  });
});

describe('ClaudeClassifier: failures never throw', () => {
  it.each([
    ['an unsupported content type', { contentType: 'application/zip' }, 'unsupported_type'],
    [
      'a document over the size limit',
      { readContent: async () => Buffer.alloc(11 * 1024 * 1024) },
      'too_large',
    ],
    [
      'content that cannot be read',
      {
        readContent: async () => {
          throw new Error('download failed');
        },
      },
      'read_failed',
    ],
  ])('gives no result for %s, without calling the API', async (_label, over, reason) => {
    const create = jest.fn();
    const { c } = classifier(create);
    expect(await c.classify(ctx(over as Partial<ClassifierContext>))).toEqual({
      outcome: 'no_result',
      reason,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a refusal',
      answer({ category: 'umowy', confidence: 0.9 }, { stop_reason: 'refusal' }),
      'refusal',
    ],
    [
      'a truncated answer',
      answer({ category: 'umowy', confidence: 0.9 }, { stop_reason: 'max_tokens' }),
      'max_tokens',
    ],
    [
      'text that is not JSON',
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: 'Sorry' }],
      },
      'malformed_output',
    ],
    [
      'JSON of another shape',
      {
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: '{"category":1}' }],
      },
      'malformed_output',
    ],
    [
      'no text at all',
      { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      'malformed_output',
    ],
    ['a nonsense response', {}, 'internal_error'],
  ])('gives no result for %s', async (_label, response, reason) => {
    const create = jest.fn().mockResolvedValue(response);
    const { c } = classifier(create);
    const result = await c.classify(ctx());
    expect(result).toMatchObject({ outcome: 'no_result', reason });
    // A response the API billed carries its cost; an internal error has none to carry.
    expect('usage' in (result as object)).toBe(reason !== 'internal_error');
  });

  // 529 "Overloaded" parked two classifiable documents in review in the
  // evaluation. Transient failures are "retry later", never a result.
  it.each([
    [
      '429',
      Anthropic.APIError.generate(429, { type: 'error' }, 'rate limited', headers),
      'rate_limited',
      429,
    ],
    [
      '529',
      Anthropic.APIError.generate(529, { type: 'error' }, 'Overloaded', headers),
      'overloaded',
      529,
    ],
    [
      '500',
      Anthropic.APIError.generate(500, { type: 'error' }, 'boom', headers),
      'server_error',
      500,
    ],
    [
      '503',
      Anthropic.APIError.generate(503, { type: 'error' }, 'unavailable', headers),
      'server_error',
      503,
    ],
    [
      '408',
      Anthropic.APIError.generate(408, { type: 'error' }, 'timeout', headers),
      'timeout',
      408,
    ],
    [
      '409',
      Anthropic.APIError.generate(409, { type: 'error' }, 'conflict', headers),
      'conflict',
      409,
    ],
    [
      '401',
      Anthropic.APIError.generate(401, { type: 'error' }, 'bad key', headers),
      'unavailable',
      401,
    ],
    [
      '402',
      Anthropic.APIError.generate(402, { type: 'error' }, 'billing', headers),
      'unavailable',
      402,
    ],
    [
      '403',
      Anthropic.APIError.generate(403, { type: 'error' }, 'forbidden', headers),
      'unavailable',
      403,
    ],
    [
      '404',
      Anthropic.APIError.generate(404, { type: 'error' }, 'no model', headers),
      'unavailable',
      404,
    ],
    ['a timeout', new Anthropic.APIConnectionTimeoutError(), 'timeout', undefined],
    [
      'a lost connection',
      new Anthropic.APIConnectionError({ message: 'reset' }),
      'connection',
      undefined,
    ],
  ])('says retry later on %s', async (_label, error, reason, status) => {
    const create = jest.fn().mockRejectedValue(error);
    const { c, lines } = classifier(create);
    const expected = {
      outcome: 'retry_later',
      reason,
      ...(status !== undefined ? { status } : {}),
    };
    await expect(c.classify(ctx())).resolves.toEqual(expected);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'claude.retry_later', reason }));
  });

  it.each([
    ['400', 400],
    ['413', 413],
    ['422', 422],
  ])('gives no result on a %s: the request itself is refused', async (_label, status) => {
    const create = jest
      .fn()
      .mockRejectedValue(Anthropic.APIError.generate(status, { type: 'error' }, 'bad', headers));
    const { c } = classifier(create);
    expect(await c.classify(ctx())).toEqual({
      outcome: 'no_result',
      reason: 'invalid_request',
      status,
    });
  });

  it('gives no result on an error that is not the SDK’s', async () => {
    const create = jest.fn().mockRejectedValue(new TypeError('bug'));
    const { c } = classifier(create);
    expect(await c.classify(ctx())).toEqual({ outcome: 'no_result', reason: 'internal_error' });
  });

  it('logs codes only: never the file name or the client', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        Anthropic.APIError.generate(529, { type: 'error' }, 'Overloaded', headers),
      );
    const { c, lines } = classifier(create);
    await c.classify(ctx({ client: CLIENT }));
    await c.classify(ctx({ contentType: 'application/zip', client: CLIENT }));
    const serialized = JSON.stringify(lines);
    expect(['1111111111', 'ABCDEF', 'Klient'].filter((s) => serialized.includes(s))).toEqual([]);
  });
});

describe('classifyApiError', () => {
  it('treats a status-less SDK error as a refused request', () => {
    expect(classifyApiError(new Anthropic.APIUserAbortError())).toEqual({
      outcome: 'no_result',
      reason: 'invalid_request',
    });
  });
});

describe('ClaudeClassifier: invoice fields for the document index', () => {
  // Synthetic NIPs with valid checksums: 1234567819 (the client), 5260250274.
  const OWN = { nip: '1234567819', companyName: 'Klient Testowy Sp. z o.o.' };
  const purchase = (invoice: Record<string, unknown> | null, over: Record<string, unknown> = {}) =>
    answer({
      category: 'faktury_zakupu',
      year: 2026,
      month: 9,
      confidence: 0.93,
      client_role: 'buyer',
      parties: [
        {
          role: 'seller',
          nip: 'PL 526-025-02-74',
          company_name: 'Dostawca S.A.',
          person_name: null,
        },
        { role: 'buyer', nip: '1234567819', company_name: OWN.companyName, person_name: null },
      ],
      invoice,
      ...over,
    });
  const fullInvoice = {
    number: '  FV 12/09/2026 ',
    issue_date: '2026-09-12',
    sale_date: '2026-09-10',
    currency: 'pln',
    net_amount: '1 000,00',
    vat_amount: '230',
    gross_amount: '1230.00',
    ksef_number: '5260250274-20260912-0123456789ab-cd',
  };

  it('asks for the invoice block in the same call: required, closed, nullable strings only', () => {
    const schema = CLASSIFICATION_OUTPUT_SCHEMA as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toContain('invoice');
    const invoice = schema.properties['invoice'] as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { anyOf?: { type: string }[] }>;
    };
    expect(invoice.additionalProperties).toBe(false);
    expect(Object.keys(invoice.properties).sort()).toEqual([...invoice.required].sort());
    const notNullableStrings = Object.entries(invoice.properties)
      .filter(([, p]) => JSON.stringify(p.anyOf?.map((a) => a.type)) !== '["string","null"]')
      .map(([k]) => k);
    expect(notNullableStrings).toEqual([]);
  });

  it('stays within the limit on union-typed properties', () => {
    let unions = 0;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if ('anyOf' in (node as object)) unions += 1;
      for (const v of Object.values(node as object)) {
        if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    };
    walk(CLASSIFICATION_OUTPUT_SCHEMA);
    expect(unions).toBe(13);
  });

  it('tells the model which categories carry the fields, and not to guess', () => {
    const prompt = SYSTEM_PROMPT;
    expect(prompt).toContain(
      'invoice: dla kategorii faktury_sprzedazy, faktury_zakupu, faktury_korekty, faktury_noty',
    );
    expect(prompt).toContain('nie zgaduj i nie licz');
  });

  it('reads and normalises the fields of a purchase invoice, seller and buyer from the parties', async () => {
    const { c } = classifier(jest.fn().mockResolvedValue(purchase(fullInvoice)));
    const result = (await c.classify(ctx({ client: OWN }))) as Classification;
    expect(result.fields['category']).toBe('faktury_zakupu');
    expect(result.extraction).toEqual({
      invoiceNumber: 'FV 12/09/2026',
      issueDate: '2026-09-12',
      saleDate: '2026-09-10',
      currency: 'PLN',
      netAmount: '1000.00',
      vatAmount: '230.00',
      grossAmount: '1230.00',
      sellerNip: '5260250274',
      sellerName: 'Dostawca S.A.',
      buyerNip: '1234567819',
      buyerName: OWN.companyName,
      ksefNumber: '5260250274-20260912-0123456789AB-CD',
    });
  });

  it('nulls each invalid field and keeps the rest, and the classification', async () => {
    const { c } = classifier(
      jest.fn().mockResolvedValue(
        purchase(
          {
            ...fullInvoice,
            issue_date: '2026-02-30',
            currency: 'zł',
            net_amount: '1.000,00',
            ksef_number: '1234567810-20260912-0123456789AB-CD',
          },
          {
            parties: [
              { role: 'seller', nip: '5260250275', company_name: 'Dostawca', person_name: null },
              { role: 'buyer', nip: '1234567819', company_name: null, person_name: null },
            ],
          },
        ),
      ),
    );
    const result = (await c.classify(ctx({ client: OWN }))) as Classification;
    expect(result.confidence).toBe(0.93);
    expect(result.extraction).toMatchObject({
      invoiceNumber: 'FV 12/09/2026',
      issueDate: null,
      saleDate: '2026-09-10',
      currency: null,
      netAmount: null,
      grossAmount: '1230.00',
      sellerNip: null,
      sellerName: 'Dostawca',
      buyerNip: '1234567819',
      buyerName: null,
      ksefNumber: null,
    });
  });

  it('keeps the classification when the invoice block is malformed', async () => {
    const { c } = classifier(
      jest.fn().mockResolvedValue(purchase({ number: 12, gross_amount: 1230 } as never)),
    );
    const result = (await c.classify(ctx({ client: OWN }))) as Classification;
    expect(result.fields['category']).toBe('faktury_zakupu');
    expect(result.extraction?.invoiceNumber).toBeNull();
    expect(result.extraction?.grossAmount).toBeNull();
    // The parties still give seller and buyer.
    expect(result.extraction?.sellerNip).toBe('5260250274');
  });

  it('gives all-null fields for an invoice without an invoice block', async () => {
    const { c } = classifier(jest.fn().mockResolvedValue(purchase(null, { parties: [] })));
    const result = (await c.classify(ctx({ client: OWN }))) as Classification;
    expect(Object.values(result.extraction ?? {}).every((v) => v === null)).toBe(true);
  });

  it.each(['umowy', 'wyciagi_bankowe', 'nieposortowane', 'kategoria_z_kosmosu'])(
    'extracts nothing for %s, whatever the model wrote',
    async (category) => {
      const { c } = classifier(
        jest.fn().mockResolvedValue(purchase(fullInvoice, { category, year: 2026, month: 9 })),
      );
      const result = (await c.classify(ctx({ client: OWN }))) as Classification;
      expect(result.extraction).toBeUndefined();
    },
  );

  it('extracts for a note or receipt, and takes the issuer when there is no seller', () => {
    const extraction = buildExtraction({ ...fullInvoice, ksef_number: null }, [
      { role: 'issuer', nip: '5260250274', companyName: 'Stacja Paliw' },
      { role: 'recipient', personName: 'Jan Testowy' },
    ]);
    expect(extraction).toMatchObject({
      sellerNip: '5260250274',
      sellerName: 'Stacja Paliw',
      buyerNip: null,
      buyerName: 'Jan Testowy',
      ksefNumber: null,
    });
  });

  it('never logs the fields', async () => {
    const { c, lines } = classifier(
      jest.fn().mockResolvedValue(purchase(fullInvoice, { stop_reason: 'end_turn' })),
    );
    await c.classify(ctx({ client: OWN }));
    const serialized = JSON.stringify(lines);
    expect(['FV 12', '1230', '5260250274'].filter((v) => serialized.includes(v))).toEqual([]);
  });
});

describe('apiErrorDetail', () => {
  it('reads the API error type and message of a refused request, capped', () => {
    const err = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'x'.repeat(400) } },
      'bad',
      new Headers(),
    );
    const d = apiErrorDetail(err);
    expect(d.apiErrorType).toBe('invalid_request_error');
    expect(String(d.apiErrorMessage)).toHaveLength(300);
  });

  it('returns nothing for a non-API error', () => {
    expect(apiErrorDetail(new Error('boom'))).toEqual({});
  });
});

describe('classifyApiError: an exhausted credit balance', () => {
  const billing = new Anthropic.BadRequestError(
    400,
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    },
    'bad',
    new Headers(),
  );

  it('is "retry later", not a result, so the document is never sent to review for it', () => {
    expect(classifyApiError(billing)).toEqual({
      outcome: 'retry_later',
      reason: 'billing',
      status: 400,
    });
  });

  it('does not count against the document', () => {
    expect(countsAgainstDocument('billing')).toBe(false);
  });

  it('leaves an ordinary invalid request as no result', () => {
    const other = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0: bad block' } },
      'bad',
      new Headers(),
    );
    expect(classifyApiError(other)).toMatchObject({
      outcome: 'no_result',
      reason: 'invalid_request',
    });
  });
});

// 27 September 2026: with the credit used up, every waiting file was
// downloaded and sent again on every two-minute tick, all refused.
describe('ClaudeClassifier: a refusal of the account pauses the calls', () => {
  const billing = () =>
    new Anthropic.BadRequestError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
      'bad',
      new Headers(),
    );

  it('sends no request and reads no document for 15 minutes after a credit refusal', async () => {
    let now = 1_000_000;
    const create = jest.fn().mockRejectedValue(billing());
    const { c, lines } = classifier(create, { now: () => now });
    const readContent = jest.fn(async () => Buffer.from('%PDF-1.7 fake'));

    const first = await c.classify(ctx({ readContent }));
    now += CLAUDE_ACCOUNT_PAUSE_MS - 1;
    const during = await Promise.all([c.classify(ctx({ readContent })), c.classify(ctx())]);

    expect(first).toEqual({ outcome: 'retry_later', reason: 'billing', status: 400 });
    expect(during).toEqual([first, first]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(readContent).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l['event'] === 'claude.paused')).toEqual([
      expect.objectContaining({ reason: 'billing', status: 400, pauseMs: CLAUDE_ACCOUNT_PAUSE_MS }),
    ]);
  });

  it('tries again when the pause is over, and classifies once the account is back', async () => {
    let now = 1_000_000;
    const create = jest
      .fn()
      .mockRejectedValueOnce(billing())
      .mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create, { now: () => now });

    await c.classify(ctx());
    now += CLAUDE_ACCOUNT_PAUSE_MS;
    const after = await c.classify(ctx());
    const next = await c.classify(ctx());

    expect(create).toHaveBeenCalledTimes(3);
    expect(after).toMatchObject({ fields: { category: 'umowy' } });
    expect(next).not.toHaveProperty('outcome');
  });

  it('pauses on a key or workspace the API will not serve (401-404) too', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(
        Anthropic.APIError.generate(401, { type: 'error' }, 'Unauthorized', new Headers()),
      );
    const { c } = classifier(create, { now: () => 5 });

    await c.classify(ctx());
    const second = await c.classify(ctx());

    expect(second).toEqual({ outcome: 'retry_later', reason: 'unavailable', status: 401 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rate limited (429)', 429, 'rate_limited'],
    ['overloaded (529)', 529, 'overloaded'],
  ])(
    'does not pause when %s: that is capacity, not the account',
    async (_label, status, reason) => {
      const create = jest
        .fn()
        .mockRejectedValue(
          Anthropic.APIError.generate(status, { type: 'error' }, 'x', new Headers()),
        );
      const { c, lines } = classifier(create, { now: () => 5 });

      await c.classify(ctx());
      const second = await c.classify(ctx());

      expect(second).toMatchObject({ outcome: 'retry_later', reason });
      expect(create).toHaveBeenCalledTimes(2);
      expect(lines.filter((l) => l['event'] === 'claude.paused')).toEqual([]);
    },
  );
});

describe('classifierFingerprint', () => {
  it('is a short hex digest, the same for the same release', () => {
    expect(classifierFingerprint('claude-opus-5')).toMatch(/^[0-9a-f]{16}$/);
    expect(classifierFingerprint('claude-opus-5')).toBe(classifierFingerprint('claude-opus-5'));
    expect(classifierFingerprint('claude-opus-5')).toBe(
      classifierFingerprint('claude-opus-5', CLAUDE_EFFORT),
    );
  });

  it('changes with the model, the effort or the thinking', () => {
    const base = classifierFingerprint('claude-opus-5');
    expect(classifierFingerprint('claude-sonnet-5')).not.toBe(base);
    expect(classifierFingerprint('claude-opus-5', 'medium')).not.toBe(base);
    expect(classifierFingerprint('claude-opus-5', 'low', 'disabled')).not.toBe(base);
    expect(classifierFingerprint('claude-opus-5', CLAUDE_EFFORT, CLAUDE_THINKING)).toBe(base);
  });
});
