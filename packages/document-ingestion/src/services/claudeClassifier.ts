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
  type DocumentParty,
  type PartyRole,
} from '@bcr/shared';

export interface ClaudeClassifierOptions {
  readonly apiKey: string;
  /** Model id, e.g. `claude-opus-4-5-20251101`. */
  readonly model: string;
  /** Reject documents larger than this many bytes (don't send to the model). */
  readonly maxContentBytes: number;
  /** Below this confidence the result is discarded → manual review. */
  readonly confidenceThreshold: number;
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
  readonly parties?: readonly {
    readonly role: string;
    readonly nip?: string | null;
    readonly company_name?: string | null;
    readonly person_name?: string | null;
  }[];
}

const TOOL_NAME = 'classify_document';
const MAX_TOKENS = 1024;
/**
 * The SDK default is 10 minutes with 2 retries, far past the batch's 150 s
 * deadline and the Functions front end's ~230 s: one slow call would fail the
 * whole card while the invocation went on filing. A timeout is an API error
 * like any other, so the document falls through to manual review.
 */
export const CLAUDE_REQUEST_TIMEOUT_MS = 45_000;
export const CLAUDE_MAX_RETRIES = 1;

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

  constructor(opts: ClaudeClassifierOptions) {
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey,
        timeout: CLAUDE_REQUEST_TIMEOUT_MS,
        maxRetries: CLAUDE_MAX_RETRIES,
      });
    this.model = opts.model;
    this.maxContentBytes = opts.maxContentBytes;
    this.confidenceThreshold = opts.confidenceThreshold;
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
        system: this.systemPrompt(ctx.client),
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
      ...(input.parties && input.parties.length > 0
        ? { parties: normalizeParties(input.parties) }
        : {}),
    };
  }

  private systemPrompt(client: ClassifierContext['client']): string {
    // When the caller has pre-resolved a client (via channel, user identity,
    // or a prior turn), we prime Claude with that identity so it can decide
    // invoice direction (sales vs purchase) confidently. When absent, Claude
    // is instructed to extract parties without deciding direction — the
    // resolver then infers direction post-classification.
    const identity = client && (client.nip || client.companyName)
      ? `Dokumenty należą do klienta: ${client.companyName || '(nazwa nieznana)'}` +
        `${client.nip ? `, NIP: ${client.nip}` : ''}. ` +
        'Gdy na fakturze klient występuje jako SPRZEDAWCA/WYSTAWCA, jest to faktura ' +
        'sprzedaży. Gdy klient jest NABYWCĄ/KUPUJĄCYM, jest to faktura zakupu. ' +
        'Porównuj nazwę firmy oraz NIP, aby ustalić kierunek faktury.'
      : 'Tożsamość klienta nie jest podana. Wyodrębnij WSZYSTKIE strony (parties) ' +
        'występujące w dokumencie z ich rolami i numerami NIP — kierunek faktury ' +
        '(sprzedaż/zakup) zostanie ustalony później na podstawie tych danych. ' +
        'Jeśli nie potrafisz jednoznacznie określić kategorii bez tożsamości klienta, ' +
        'wybierz kategorię "nieposortowane" — nadal jednak WYPEŁNIJ pole parties.';

    return [
      'Jesteś asystentem księgowym polskiego biura rachunkowego. Twoim zadaniem jest ' +
        'sklasyfikowanie załączonego dokumentu i przypisanie go do właściwej kategorii ' +
        'w strukturze folderów SharePoint klienta.',
      identity,
      'Zawsze wywołuj narzędzie "classify_document". Dla kategorii datowanych podaj rok ' +
        '(RRRR) i miesiąc (1-12) na podstawie daty dokumentu (np. daty wystawienia faktury ' +
        'lub okresu wyciągu). Ustaw "confidence" rzetelnie: niska wartość, gdy nie masz ' +
        'pewności. Krótko uzasadnij wybór w polu "reasoning" (po polsku). ' +
        'Wypełniaj pole "parties" dla faktur, umow i innych dokumentów, na których ' +
        'występują zidentyfikowane strony (firmy z NIP-em lub osoby fizyczne).',
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
          parties: {
            type: 'array',
            description:
              'Strony zidentyfikowane w dokumencie. Wypełniaj dla faktur ' +
              '(sprzedawca + nabywca), umów (strony umowy) i innych dokumentów, ' +
              'na których występują zidentyfikowane podmioty.',
            items: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  enum: ['seller', 'buyer', 'issuer', 'recipient', 'unknown'],
                  description:
                    'Rola strony: seller=sprzedawca/wystawca faktury, ' +
                    'buyer=nabywca/kupujący, issuer=wystawca dokumentu (nie faktury), ' +
                    'recipient=adresat/odbiorca, unknown=nieokreślona.',
                },
                nip: {
                  type: ['string', 'null'],
                  description: 'NIP strony (tylko cyfry, można zwrócić z formatowaniem).',
                },
                company_name: {
                  type: ['string', 'null'],
                  description: 'Pełna nazwa firmy, jeśli strona jest osobą prawną.',
                },
                person_name: {
                  type: ['string', 'null'],
                  description: 'Imię i nazwisko, jeśli strona jest osobą fizyczną.',
                },
              },
              required: ['role'],
            },
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
          ...(Array.isArray(input.parties) ? { parties: input.parties } : {}),
        };
      }
    }
  }
  return null;
}

const PARTY_ROLES = new Set<PartyRole>([
  'seller',
  'buyer',
  'issuer',
  'recipient',
  'unknown',
]);

/**
 * Turn the raw tool output into the immutable `DocumentParty` shape. Drops
 * entries that carry no useful signal (no NIP, no name, no person name) and
 * normalizes NIPs to digits-only so downstream lookups don't have to.
 */
function normalizeParties(
  raw: NonNullable<ClassifyToolInput['parties']>,
): readonly DocumentParty[] {
  const out: DocumentParty[] = [];
  for (const p of raw) {
    const role: PartyRole = PARTY_ROLES.has(p.role as PartyRole)
      ? (p.role as PartyRole)
      : 'unknown';
    const nip = typeof p.nip === 'string' ? p.nip.replace(/\D+/g, '') : '';
    const companyName = typeof p.company_name === 'string' ? p.company_name.trim() : '';
    const personName = typeof p.person_name === 'string' ? p.person_name.trim() : '';
    if (!nip && !companyName && !personName) continue;
    out.push({
      role,
      ...(nip ? { nip } : {}),
      ...(companyName ? { companyName } : {}),
      ...(personName ? { personName } : {}),
    });
  }
  return out;
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
