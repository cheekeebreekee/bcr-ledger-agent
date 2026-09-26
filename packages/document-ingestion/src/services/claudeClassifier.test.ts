import Anthropic from '@anthropic-ai/sdk';
import type { Classification, ClassifierContext, Logger } from '@bcr/shared';
import { PDFDocument } from 'pdf-lib';
import {
  CLASSIFICATION_OUTPUT_SCHEMA,
  CLAUDE_EFFORT,
  CLAUDE_MAX_RETRIES,
  CLAUDE_MAX_TOKENS,
  CLAUDE_REQUEST_TIMEOUT_MS,
  ClaudeClassifier,
  classifyApiError,
  systemPrompt,
  type ClaudeUsage,
} from './claudeClassifier';
import { DIRECTION_UNRESOLVED } from './invoiceDirection';

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
          reasoning: 'Uzasadnienie.',
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

  it('runs at another effort when told to', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create, { effort: 'medium' });
    await c.classify(ctx());
    expect(create.mock.calls[0][0].output_config.effort).toBe('medium');
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

  it('primes only the bound client’s own identity, with the rules from the evaluation', async () => {
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create);
    await c.classify(ctx({ client: { nip: '111-111-11-11', companyName: CLIENT.companyName } }));
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('Klient Testowy Sp. z o.o., NIP 1111111111');
    expect(system).toContain('client_role');
    for (const rule of [
      'klantenbon',
      'BEZ danych nabywcy',
      'pro forma',
      'OWU',
      '450 zł',
      'rachunek hotelowy',
    ]) {
      expect(system).toContain(rule);
    }
  });

  it('tells the model when no identity is given, and that direction is not its call', () => {
    const system = systemPrompt(undefined);
    expect(system).toMatch(/Tożsamość klienta nie jest podana/);
    expect(system).toMatch(/client_role na unknown/);
    expect(systemPrompt({ nip: '', companyName: 'Tylko Nazwa' })).toContain('Tylko Nazwa');
    expect(systemPrompt({ nip: '1111111111', companyName: '' })).toContain(
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

  it('reports each response’s token usage', async () => {
    const usage: ClaudeUsage[] = [];
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create, { onUsage: (u) => usage.push(u) });
    await c.classify(ctx());
    expect(usage).toEqual([{ model: 'claude-opus-5', inputTokens: 1200, outputTokens: 180 }]);
  });
});

describe('ClaudeClassifier: long PDFs', () => {
  it('classifies a PDF over 100 pages from its first 20, and never changes the original', async () => {
    const original = await syntheticPdf(101);
    const before = Buffer.from(original);
    const create = jest.fn().mockResolvedValue(answer({ category: 'umowy', confidence: 0.9 }));
    const { c } = classifier(create);

    const result = (await c.classify(ctx({ readContent: async () => original }))) as Classification;

    const [block, instruction] = create.mock.calls[0][0].messages[0].content;
    const sent = await PDFDocument.load(Buffer.from(block.source.data, 'base64'));
    expect(sent.getPageCount()).toBe(20);
    expect(instruction.text).toContain('Dokument ma 101 stron; załączono tylko pierwsze 20.');
    expect(result.fields).toMatchObject({ pagesRead: 20, pageCount: 101 });
    expect(original.equals(before)).toBe(true);
  });

  it('sends a PDF of 100 pages whole', async () => {
    const pdf = await syntheticPdf(100);
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
    expect(await c.classify(ctx())).toEqual({ outcome: 'no_result', reason });
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
