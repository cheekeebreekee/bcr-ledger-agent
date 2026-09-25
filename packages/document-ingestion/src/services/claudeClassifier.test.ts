import type Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MAX_RETRIES, CLAUDE_REQUEST_TIMEOUT_MS, ClaudeClassifier } from './claudeClassifier';
import type { ClassifierContext } from '@bcr/shared';

type CreateFn = jest.Mock;

const makeClient = (create: CreateFn) => ({ messages: { create } }) as never;

const toolMessage = (input: unknown) => ({
  content: [{ type: 'tool_use', name: 'classify_document', input }],
});

const ctx = (
  overrides: Partial<ClassifierContext> = {},
): ClassifierContext => ({
  filename: 'dokument.pdf',
  contentType: 'application/pdf',
  readContent: async () => Buffer.from('%PDF-1.7 fake'),
  ...overrides,
});

const baseOpts = {
  apiKey: 'test-key',
  model: 'claude-opus-4-5-20251101',
  maxContentBytes: 10 * 1024 * 1024,
  confidenceThreshold: 0.6,
};

describe('ClaudeClassifier', () => {
  it('bounds each API call well inside the batch deadline', () => {
    const c = new ClaudeClassifier(baseOpts);
    const client = (c as unknown as { client: Anthropic }).client;
    expect(client.timeout).toBe(CLAUDE_REQUEST_TIMEOUT_MS);
    expect(client.maxRetries).toBe(CLAUDE_MAX_RETRIES);
    // Worst case: the first attempt and one retry both time out.
    expect(CLAUDE_REQUEST_TIMEOUT_MS * (CLAUDE_MAX_RETRIES + 1)).toBeLessThan(150_000);
  });

  it('turns a timeout into null so the document goes to manual review', async () => {
    const create: CreateFn = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    await expect(c.classify(ctx())).resolves.toBeNull();
  });

  it('classifies a sales invoice into a dated folder', async () => {
    const create: CreateFn = jest.fn().mockResolvedValue(
      toolMessage({
        category: 'faktury_sprzedazy',
        year: 2026,
        month: 3,
        confidence: 0.95,
        reasoning: 'Klient jest sprzedawcą',
      }),
    );
    const c = new ClaudeClassifier({
      ...baseOpts,
      client: makeClient(create),
    });

    const result = await c.classify(ctx());
    expect(result).not.toBeNull();
    expect(result?.classifier).toBe('claude');
    expect(result?.folderPath).toBe('01_Faktury/01_Faktury_sprzedaży/2026/03');
    expect(result?.documentType).toBe('Faktura sprzedaży');
    expect(result?.fields.category).toBe('faktury_sprzedazy');
    expect(result?.fields.reasoning).toBe('Klient jest sprzedawcą');
  });

  it('passes a PDF as a document content block', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'umowy', confidence: 0.9 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });

    await c.classify(ctx({ contentType: 'application/pdf' }));

    const arg = create.mock.calls[0][0];
    expect(arg.tool_choice).toEqual({ type: 'tool', name: 'classify_document' });
    const blocks = arg.messages[0].content;
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
    });
  });

  it('passes an image as an image content block', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'inne', confidence: 0.9 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });

    await c.classify(
      ctx({ contentType: 'image/png', readContent: async () => Buffer.from('img') }),
    );

    const blocks = create.mock.calls[0][0].messages[0].content;
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
  });

  it('passes text as a text content block', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'korespondencja', confidence: 0.8 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });

    await c.classify(
      ctx({ contentType: 'text/plain', readContent: async () => Buffer.from('Szanowni Państwo') }),
    );

    const blocks = create.mock.calls[0][0].messages[0].content;
    expect(blocks[0]).toEqual({ type: 'text', text: 'Szanowni Państwo' });
  });

  it('returns null for unsupported content types', async () => {
    const create: CreateFn = jest.fn();
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    const result = await c.classify(
      ctx({ contentType: 'application/zip', readContent: async () => Buffer.from('PK') }),
    );
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when the document is too large', async () => {
    const create: CreateFn = jest.fn();
    const c = new ClaudeClassifier({
      ...baseOpts,
      maxContentBytes: 4,
      client: makeClient(create),
    });
    const result = await c.classify(
      ctx({ readContent: async () => Buffer.from('way too big') }),
    );
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when confidence is below the threshold', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'faktury_zakupu', year: 2026, month: 2, confidence: 0.4 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    expect(await c.classify(ctx())).toBeNull();
  });

  it('returns null when the model picks an unknown category', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'totally_made_up', confidence: 0.99 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    expect(await c.classify(ctx())).toBeNull();
  });

  it('returns null when a dated category lacks a usable date', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'wyciagi_bankowe', confidence: 0.95 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    expect(await c.classify(ctx())).toBeNull();
  });

  it('routes a confident nieposortowane result using the current date', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'nieposortowane', confidence: 0.9 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    const result = await c.classify(ctx());
    expect(result?.folderPath).toMatch(/^98_Nieposortowane\/\d{4}\/\d{2}$/);
  });

  it('returns null when the model returns no tool block', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'no tool' }] });
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    expect(await c.classify(ctx())).toBeNull();
  });

  it('returns null when the API throws', async () => {
    const create: CreateFn = jest.fn().mockRejectedValue(new Error('rate limited'));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    expect(await c.classify(ctx())).toBeNull();
  });

  it('does NOT prime the system prompt with client identity when ctx.client is absent', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'inne', confidence: 0.9 }));
    const c = new ClaudeClassifier({
      ...baseOpts,
      client: makeClient(create),
    });
    await c.classify(ctx());
    const system = create.mock.calls[0][0].system as string;
    expect(system).not.toContain('ACME Sp. z o.o.');
    expect(system).not.toContain('1234567890');
    expect(system).toMatch(/Tożsamość klienta nie jest podana/);
  });

  it('primes the system prompt with client identity when ctx.client is provided', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'faktury_sprzedazy', year: 2026, month: 3, confidence: 0.9 }));
    const c = new ClaudeClassifier({
      ...baseOpts,
      client: makeClient(create),
    });
    await c.classify(
      ctx({ client: { nip: '9571185285', companyName: 'PESKOVOI Sp. z o.o.' } }),
    );
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('PESKOVOI Sp. z o.o.');
    expect(system).toContain('9571185285');
    expect(system).toContain('SPRZEDAWCA');
    expect(system).toContain('NABYWCĄ');
  });

  it('extracts parties from the tool output when returned', async () => {
    const create: CreateFn = jest.fn().mockResolvedValue(
      toolMessage({
        category: 'nieposortowane',
        year: 2026,
        month: 2,
        confidence: 0.75,
        parties: [
          { role: 'seller', nip: '865-256-72-40', company_name: 'Autorud Stalowa Wola Sp. z o.o.' },
          { role: 'buyer', nip: '9571185285', company_name: 'PESKOVOI Sp. z o.o.' },
          { role: 'unknown', nip: null, company_name: null, person_name: null }, // dropped: no signal
        ],
      }),
    );
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    const result = await c.classify(ctx());
    expect(result?.parties).toEqual([
      { role: 'seller', nip: '8652567240', companyName: 'Autorud Stalowa Wola Sp. z o.o.' },
      { role: 'buyer', nip: '9571185285', companyName: 'PESKOVOI Sp. z o.o.' },
    ]);
  });

  it('leaves parties undefined when the tool omits them', async () => {
    const create: CreateFn = jest
      .fn()
      .mockResolvedValue(toolMessage({ category: 'inne', confidence: 0.9 }));
    const c = new ClaudeClassifier({ ...baseOpts, client: makeClient(create) });
    const result = await c.classify(ctx());
    expect(result?.parties).toBeUndefined();
  });
});
