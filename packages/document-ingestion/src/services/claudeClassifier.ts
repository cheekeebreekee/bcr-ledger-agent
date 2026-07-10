import Anthropic from '@anthropic-ai/sdk';
import {
  buildFolderPath,
  categoryCatalog,
  createLogger,
  getCategory,
  isDocumentCategory,
  type Classification,
  type Classifier,
  type ClassifierContext,
  type DocumentCategory,
} from '@bcr/shared';

export interface ClaudeClassifierOptions {
  readonly apiKey: string;
  /** Model id, e.g. `claude-opus-4-5-20251101`. */
  readonly model: string;
  /** Reject documents larger than this many bytes (don't send to the model). */
  readonly maxContentBytes: number;
  /** Below this confidence the result is discarded → manual review. */
  readonly confidenceThreshold: number;
  /** Client legal/company name — lets the model decide invoice direction. */
  readonly clientCompanyName?: string;
  /** Client tax id (NIP) — primary signal for invoice direction. */
  readonly clientNip?: string;
  /** Injectable for tests. */
  readonly client?: Pick<Anthropic, 'messages'>;
}

/** Shape the model must return via the forced `classify_document` tool. */
interface ClassifyToolInput {
  readonly category: string;
  readonly year?: number | null;
  readonly month?: number | null;
  readonly confidence: number;
  readonly reasoning?: string;
}

const TOOL_NAME = 'classify_document';
const MAX_TOKENS = 1024;

/**
 * Content-based classifier backed by Anthropic Claude. Reads the actual
 * document (PDF / image / text), then routes it into the BCR SharePoint
 * taxonomy. Unlike filename rules, it can tell a sales invoice from a
 * purchase invoice by comparing parties against the client's own identity.
 *
 * Contract: this classifier NEVER throws. Any failure (unsupported type,
 * oversize, API error, malformed output, low confidence) returns `null` so
 * the {@link ClassificationService} falls through to the fallback, which
 * routes the file to `98_Nieposortowane` for manual review.
 */
export class ClaudeClassifier implements Classifier {
  readonly name = 'claude';
  private readonly log = createLogger('ingestion/claude');
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;
  private readonly maxContentBytes: number;
  private readonly confidenceThreshold: number;
  private readonly clientCompanyName: string | undefined;
  private readonly clientNip: string | undefined;

  constructor(opts: ClaudeClassifierOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxContentBytes = opts.maxContentBytes;
    this.confidenceThreshold = opts.confidenceThreshold;
    this.clientCompanyName = opts.clientCompanyName || undefined;
    this.clientNip = opts.clientNip || undefined;
  }

  async classify(ctx: ClassifierContext): Promise<Classification | null> {
    try {
      const content = await ctx.readContent();
      if (content.length > this.maxContentBytes) {
        this.log.warn(
          { filename: ctx.filename, sizeBytes: content.length, limit: this.maxContentBytes },
          'document exceeds size limit for AI classification, skipping',
        );
        return null;
      }

      const block = buildDocumentBlock(content, ctx.contentType);
      if (!block) {
        this.log.warn(
          { filename: ctx.filename, contentType: ctx.contentType },
          'unsupported content type for AI classification, skipping',
        );
        return null;
      }

      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: this.systemPrompt(),
        tools: [this.toolDefinition()],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: [block, { type: 'text', text: this.userInstruction(ctx.filename) }],
          },
        ],
      });

      const input = extractToolInput(message);
      if (!input) {
        this.log.warn({ filename: ctx.filename }, 'model returned no tool output');
        return null;
      }

      return this.toClassification(input, ctx.filename);
    } catch (err) {
      this.log.warn({ err, filename: ctx.filename }, 'AI classification failed, skipping');
      return null;
    }
  }

  // -------------------------------------------------------------------------

  private toClassification(
    input: ClassifyToolInput,
    filename: string,
  ): Classification | null {
    if (!isDocumentCategory(input.category)) {
      this.log.warn({ filename, category: input.category }, 'model returned unknown category');
      return null;
    }

    const confidence = clamp(input.confidence);
    if (confidence < this.confidenceThreshold) {
      this.log.info(
        { filename, category: input.category, confidence },
        'classification below threshold, routing to manual review',
      );
      return null;
    }

    const category = input.category;
    const def = getCategory(category);
    const date = resolveDate(category, input.year, input.month);

    if (def.dated && !date) {
      this.log.warn(
        { filename, category },
        'dated category without a usable date, routing to manual review',
      );
      return null;
    }

    let folderPath: string;
    try {
      folderPath = buildFolderPath(category, date);
    } catch (err) {
      this.log.warn({ err, filename, category }, 'failed to build folder path');
      return null;
    }

    return {
      documentType: def.polishLabel,
      folderPath,
      confidence,
      classifier: this.name,
      fields: {
        category,
        ...(date ? { year: date.year, month: date.month } : {}),
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      },
    };
  }

  private systemPrompt(): string {
    const identity =
      this.clientCompanyName || this.clientNip
        ? `Dokumenty należą do klienta: ${this.clientCompanyName ?? '(nazwa nieznana)'}` +
          `${this.clientNip ? `, NIP: ${this.clientNip}` : ''}. ` +
          'Gdy na fakturze klient występuje jako SPRZEDAWCA/WYSTAWCA, jest to faktura ' +
          'sprzedaży. Gdy klient jest NABYWCĄ/KUPUJĄCYM, jest to faktura zakupu. ' +
          'Porównuj nazwę firmy oraz NIP, aby ustalić kierunek faktury.'
        : 'Tożsamość klienta nie została podana — przy fakturach kieruj się treścią dokumentu, ' +
          'a w razie wątpliwości wybierz kategorię "nieposortowane".';

    return [
      'Jesteś asystentem księgowym polskiego biura rachunkowego. Twoim zadaniem jest ' +
        'sklasyfikowanie załączonego dokumentu i przypisanie go do właściwej kategorii ' +
        'w strukturze folderów SharePoint klienta.',
      identity,
      'Zawsze wywołuj narzędzie "classify_document". Dla kategorii datowanych podaj rok ' +
        '(RRRR) i miesiąc (1-12) na podstawie daty dokumentu (np. daty wystawienia faktury ' +
        'lub okresu wyciągu). Ustaw "confidence" rzetelnie: niska wartość, gdy nie masz ' +
        'pewności. Krótko uzasadnij wybór w polu "reasoning" (po polsku).',
      '',
      'Dostępne kategorie:',
      categoryCatalog
        .map((c) => `- ${c.id} (${c.polishLabel}): ${c.description}`)
        .join('\n'),
    ].join('\n');
  }

  private userInstruction(filename: string): string {
    return (
      `Nazwa pliku (jedynie wskazówka, może być myląca): "${filename}". ` +
      'Sklasyfikuj dokument na podstawie jego TREŚCI, nie nazwy pliku.'
    );
  }

  private toolDefinition(): Anthropic.Tool {
    return {
      name: TOOL_NAME,
      description:
        'Zwraca kategorię dokumentu w taksonomii folderów klienta oraz datę dokumentu.',
      input_schema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: categoryCatalog.map((c) => c.id),
            description: 'Identyfikator kategorii docelowej.',
          },
          year: {
            type: ['integer', 'null'],
            description: 'Rok dokumentu (RRRR). Wymagany dla kategorii datowanych.',
          },
          month: {
            type: ['integer', 'null'],
            minimum: 1,
            maximum: 12,
            description: 'Miesiąc dokumentu (1-12). Wymagany dla kategorii datowanych.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Pewność klasyfikacji w zakresie 0-1.',
          },
          reasoning: {
            type: 'string',
            description: 'Krótkie uzasadnienie wyboru kategorii (po polsku).',
          },
        },
        required: ['category', 'confidence'],
      },
    };
  }
}

// ---------------------------------------------------------------------------

const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function buildDocumentBlock(
  content: Buffer,
  contentType: string,
): Anthropic.Messages.ContentBlockParam | null {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (type === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: content.toString('base64') },
    };
  }

  if (IMAGE_MEDIA_TYPES.has(type)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: content.toString('base64'),
      },
    };
  }

  if (type.startsWith('text/')) {
    return { type: 'text', text: content.toString('utf-8') };
  }

  return null;
}

function extractToolInput(message: Anthropic.Message): ClassifyToolInput | null {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === TOOL_NAME) {
      const input = block.input as Partial<ClassifyToolInput> | undefined;
      if (
        input &&
        typeof input.category === 'string' &&
        typeof input.confidence === 'number'
      ) {
        return {
          category: input.category,
          year: input.year ?? null,
          month: input.month ?? null,
          confidence: input.confidence,
          ...(typeof input.reasoning === 'string' ? { reasoning: input.reasoning } : {}),
        };
      }
    }
  }
  return null;
}

function resolveDate(
  category: DocumentCategory,
  year: number | null | undefined,
  month: number | null | undefined,
): { year: number; month: number } | undefined {
  if (isValidYear(year) && isValidMonth(month)) {
    return { year, month };
  }
  // The manual-review bucket is always dated; fall back to "now" when the
  // model couldn't read a date off the document.
  if (category === 'nieposortowane') {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }
  return undefined;
}

function isValidYear(year: number | null | undefined): year is number {
  return typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999;
}

function isValidMonth(month: number | null | undefined): month is number {
  return typeof month === 'number' && Number.isInteger(month) && month >= 1 && month <= 12;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
