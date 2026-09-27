import Anthropic from '@anthropic-ai/sdk';
import {
  buildFolderPath,
  categoryCatalog,
  createLogger,
  getCategory,
  hasInvoiceFields,
  isDocumentCategory,
  MAX_INVOICE_NUMBER_LENGTH,
  MAX_PARTY_NAME_LENGTH,
  normalizeAmount,
  normalizeCurrency,
  normalizeIsoDate,
  normalizeKsefNumber,
  normalizeNip,
  normalizeText,
  type Classification,
  type Classifier,
  type ClassifierContext,
  type ClassifierNoResult,
  type ClassifierRetryLater,
  type DocumentExtraction,
  type DocumentParty,
  type Logger,
  type PartyRole,
} from '@bcr/shared';
import { z } from 'zod';
import { settleInvoiceDirection, type ClientRole } from './invoiceDirection';
import { pdfForModel, type PdfForModel } from './pdfPreview';

/** The effort levels this classifier may run at (`output_config.effort`). */
export type ClaudeEffort = 'low' | 'medium' | 'high';

/** Token usage of one API response, for cost reporting. */
export interface ClaudeUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ClaudeClassifierOptions {
  readonly apiKey: string;
  /** Model id, e.g. `claude-opus-5`. */
  readonly model: string;
  /** Reject documents larger than this many bytes (don't send to the model). */
  readonly maxContentBytes: number;
  /** Defaults to {@link CLAUDE_EFFORT}. */
  readonly effort?: ClaudeEffort;
  /** Called with every response's token usage (the evaluation harness sums them). */
  readonly onUsage?: (usage: ClaudeUsage) => void;
  /** Injectable for tests. */
  readonly client?: Pick<Anthropic, 'messages'>;
  /** Injected in tests; defaults to the `ingestion/claude` logger. */
  readonly log?: Logger;
}

/**
 * The SDK default is 10 minutes with 2 retries, far past the batch's 150 s
 * deadline and the Functions front end's ~230 s: one slow call would fail the
 * whole card while the invocation went on filing. A timeout is "retry later",
 * never a classification.
 */
export const CLAUDE_REQUEST_TIMEOUT_MS = 45_000;
export const CLAUDE_MAX_RETRIES = 1;

/**
 * Thinking plus the JSON answer. On `claude-opus-5` a request without a
 * `thinking` field thinks (adaptively), and `max_tokens` caps thinking and
 * answer together, so this is far above the ~300 tokens the answer takes.
 */
export const CLAUDE_MAX_TOKENS = 8192;

/**
 * A short classification call: `low` effort keeps the adaptive thinking
 * brief. `effort` is valid on `claude-opus-5` and on `claude-opus-4-5`.
 */
export const CLAUDE_EFFORT: ClaudeEffort = 'low';

const PARTY_ROLES: readonly PartyRole[] = ['seller', 'buyer', 'issuer', 'recipient', 'unknown'];
const CLIENT_ROLES: readonly ClientRole[] = ['seller', 'buyer', 'none', 'unknown'];

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** The categories whose documents carry invoice fields, from the taxonomy. */
const INVOICE_FIELD_CATEGORIES = categoryCatalog.filter((c) => c.invoiceFields).map((c) => c.id);

const nullableString = (description: string) => ({
  ...nullable({ type: 'string' }),
  description,
});

/**
 * The searchable fields of an invoice, receipt or note, read in the same call.
 * Every value is a nullable string: amounts too, so no float ever rounds a
 * grosz away, and every one is validated after the call (`buildExtraction`).
 * Seller and buyer are not repeated here: they are the `parties`.
 */
const INVOICE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    `Dane faktury, paragonu lub noty do wyszukiwania: tylko dla kategorii ` +
    `${INVOICE_FIELD_CATEGORIES.join(', ')}. Dla innych kategorii każde pole null.`,
  properties: {
    number: nullableString('Numer dokumentu, dokładnie jak na dokumencie.'),
    issue_date: nullableString('Data wystawienia, RRRR-MM-DD.'),
    sale_date: nullableString(
      'Data sprzedaży lub wykonania usługi, RRRR-MM-DD, tylko gdy jest podana.',
    ),
    currency: nullableString('Waluta dokumentu, kod ISO 4217, np. PLN, EUR.'),
    net_amount: nullableString(
      'Suma netto dokumentu: cyfry z kropką dziesiętną, bez spacji i waluty, np. 1234.50.',
    ),
    vat_amount: nullableString('Suma VAT dokumentu, w tym samym zapisie.'),
    gross_amount: nullableString('Suma brutto dokumentu, w tym samym zapisie.'),
    ksef_number: nullableString('Numer KSeF, tylko gdy jest na dokumencie.'),
  },
  required: [
    'number',
    'issue_date',
    'sale_date',
    'currency',
    'net_amount',
    'vat_amount',
    'gross_amount',
    'ksef_number',
  ],
  additionalProperties: false,
};

/**
 * The structured output the model must return (`output_config.format`). The
 * category enum is the taxonomy's, so the model can never name a category no
 * folder exists for. Numeric bounds are not supported by structured outputs:
 * they are checked here, after parsing. Every property is required, and
 * optional values are nullable (`anyOf` with `null`): 13 union-typed
 * properties in all, well inside the API's limit on them.
 */
export const CLASSIFICATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: categoryCatalog.map((c) => c.id),
      description: 'Identyfikator kategorii docelowej.',
    },
    year: { ...nullable({ type: 'integer' }), description: 'Rok daty dokumentu (RRRR).' },
    month: { ...nullable({ type: 'integer' }), description: 'Miesiąc daty dokumentu (1-12).' },
    confidence: { type: 'number', description: 'Pewność klasyfikacji, od 0 do 1.' },
    client_role: {
      type: 'string',
      enum: [...CLIENT_ROLES],
      description:
        'Rola klienta na fakturze: seller (sprzedawca/wystawca), buyer (nabywca), ' +
        'none (klient nie jest stroną), unknown (nie da się ustalić lub brak tożsamości klienta).',
    },
    reasoning: { type: 'string', description: 'Jedno krótkie zdanie uzasadnienia po polsku.' },
    parties: {
      type: 'array',
      description: 'Strony dokumentu: sprzedawca i nabywca faktury, strony umowy, wystawca.',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: [...PARTY_ROLES] },
          nip: nullable({ type: 'string' }),
          company_name: nullable({ type: 'string' }),
          person_name: nullable({ type: 'string' }),
        },
        required: ['role', 'nip', 'company_name', 'person_name'],
        additionalProperties: false,
      },
    },
    invoice: INVOICE_OUTPUT_SCHEMA,
  },
  required: [
    'category',
    'year',
    'month',
    'confidence',
    'client_role',
    'reasoning',
    'parties',
    'invoice',
  ],
  additionalProperties: false,
};

const optionalText = z.string().nullable().optional();

/** Parses the answer. Lenient on what the schema already constrains; strict on what we use. */
const modelOutput = z.object({
  category: z.string(),
  year: z.number().int().nullable().optional(),
  month: z.number().int().nullable().optional(),
  confidence: z.number(),
  client_role: z.enum(['seller', 'buyer', 'none', 'unknown']).optional(),
  reasoning: z.string().optional(),
  parties: z
    .array(
      z.object({
        role: z.string(),
        nip: z.string().nullable().optional(),
        company_name: z.string().nullable().optional(),
        person_name: z.string().nullable().optional(),
      }),
    )
    .optional(),
  // Lenient: a malformed invoice block loses its fields, never the classification.
  invoice: z
    .object({
      number: optionalText,
      issue_date: optionalText,
      sale_date: optionalText,
      currency: optionalText,
      net_amount: optionalText,
      vat_amount: optionalText,
      gross_amount: optionalText,
      ksef_number: optionalText,
    })
    .nullable()
    .optional()
    .catch(null),
});
type ModelOutput = z.infer<typeof modelOutput>;

/**
 * Content-based classifier backed by Anthropic Claude. Reads the actual
 * document (PDF / image / text) and suggests a category of the BCR SharePoint
 * taxonomy, with the document's month, a confidence and the parties. Whether
 * that suggestion is filed or sent to review is the acceptance policy's call.
 *
 * Contract: this classifier NEVER throws and never rejects. It returns
 *  - a {@link Classification}: the model's suggestion, with invoice direction
 *    settled from the client's own identity (or flagged unresolved) and, for
 *    an invoice, receipt or note, its searchable fields (`extraction`), each
 *    validated or `null` — a bad field never costs the classification;
 *  - `retry_later` for a failure that is not about the document — 429, 529,
 *    another 5xx, a timeout, a lost connection, or an account/configuration
 *    error (401, 402, 403, 404): the caller tries again later and never files
 *    the document for review because of it;
 *  - `no_result` for a failure about the document or the request — an
 *    unsupported type, oversize, a PDF that could not be shortened, a 400,
 *    413 or 422, a refusal, malformed or truncated output — so the fallback
 *    files it in `98_Nieposortowane` for manual review.
 */
export class ClaudeClassifier implements Classifier {
  readonly name = 'claude';
  private readonly log: Logger;
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;
  private readonly maxContentBytes: number;
  private readonly effort: ClaudeEffort;
  private readonly onUsage: ((usage: ClaudeUsage) => void) | undefined;

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
    this.effort = opts.effort ?? CLAUDE_EFFORT;
    this.onUsage = opts.onUsage;
    this.log = opts.log ?? createLogger('ingestion/claude');
  }

  async classify(
    ctx: ClassifierContext,
  ): Promise<Classification | ClassifierNoResult | ClassifierRetryLater> {
    try {
      let content: Buffer;
      try {
        content = await ctx.readContent();
      } catch {
        return this.noResult('read_failed');
      }
      if (content.length > this.maxContentBytes) return this.noResult('too_large');

      const input = await this.modelInput(content, ctx.contentType);
      if ('outcome' in input) return input;

      let message: Anthropic.Message;
      try {
        message = await this.client.messages.create({
          model: this.model,
          max_tokens: CLAUDE_MAX_TOKENS,
          system: systemPrompt(ctx.client),
          output_config: {
            effort: this.effort,
            format: { type: 'json_schema', schema: CLASSIFICATION_OUTPUT_SCHEMA },
          },
          messages: [
            {
              role: 'user',
              content: [
                input.block,
                { type: 'text', text: userInstruction(ctx.filename, input.preview) },
              ],
            },
          ],
        });
      } catch (err) {
        return this.apiFailure(err);
      }
      this.reportUsage(message);

      if (message.stop_reason === 'refusal') return this.noResult('refusal');
      if (message.stop_reason === 'max_tokens') return this.noResult('max_tokens');
      const output = parseOutput(message);
      if (!output) return this.noResult('malformed_output');

      return settleInvoiceDirection(
        toClassification(output, message.model || this.model, input.preview),
        ctx.client,
      );
    } catch (err) {
      this.log.warn(
        { event: 'claude.no_result', reason: 'internal_error', err: describeError(err) },
        'claude.no_result',
      );
      return { outcome: 'no_result', reason: 'internal_error' };
    }
  }

  // -------------------------------------------------------------------------

  /** The content block for the model, or why there is none. */
  private async modelInput(
    content: Buffer,
    contentType: string,
  ): Promise<
    | { readonly block: Anthropic.Messages.ContentBlockParam; readonly preview?: PdfPreview }
    | ClassifierNoResult
  > {
    const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (type === 'application/pdf') {
      const pdf: PdfForModel = await pdfForModel(content);
      if (pdf.kind === 'trim_failed') {
        return this.noResult('pdf_trim_failed', undefined, { pageCount: pdf.pageCount });
      }
      const bytes = pdf.kind === 'first_pages' ? pdf.content : content;
      return {
        block: {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
        },
        ...(pdf.kind === 'first_pages'
          ? { preview: { pages: pdf.pages, pageCount: pdf.pageCount } }
          : {}),
      };
    }
    if (isImageType(type)) {
      return {
        block: {
          type: 'image',
          source: { type: 'base64', media_type: type, data: content.toString('base64') },
        },
      };
    }
    if (type.startsWith('text/')) {
      return { block: { type: 'text', text: content.toString('utf-8') } };
    }
    return this.noResult('unsupported_type');
  }

  /** Transient or account failures are "retry later"; request failures are "no result". */
  private apiFailure(err: unknown): ClassifierNoResult | ClassifierRetryLater {
    const failure = classifyApiError(err);
    if (failure.outcome === 'retry_later') {
      this.log.warn(
        {
          event: 'claude.retry_later',
          reason: failure.reason,
          model: this.model,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
        },
        'claude.retry_later',
      );
      return failure;
    }
    return this.noResult(failure.reason, failure.status, apiErrorDetail(err));
  }

  private noResult(
    reason: string,
    status?: number,
    extra: Record<string, unknown> = {},
  ): ClassifierNoResult {
    this.log.info(
      {
        event: 'claude.no_result',
        reason,
        model: this.model,
        ...(status !== undefined ? { status } : {}),
        ...extra,
      },
      'claude.no_result',
    );
    return { outcome: 'no_result', reason, ...(status !== undefined ? { status } : {}) };
  }

  private reportUsage(message: Anthropic.Message): void {
    if (!this.onUsage || !message.usage) return;
    this.onUsage({
      model: message.model || this.model,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
    });
  }
}

// ---------------------------------------------------------------------------

interface PdfPreview {
  readonly pages: number;
  readonly pageCount: number;
}

/**
 * The SDK's typed errors, most specific first. Everything that says nothing
 * about the document is `retry_later`: the SDK has already retried it once.
 */
export function classifyApiError(err: unknown): ClassifierNoResult | ClassifierRetryLater {
  const retryLater = (reason: string, status?: number): ClassifierRetryLater => ({
    outcome: 'retry_later',
    reason,
    ...(status !== undefined ? { status } : {}),
  });
  if (err instanceof Anthropic.APIConnectionTimeoutError) return retryLater('timeout');
  if (err instanceof Anthropic.APIConnectionError) return retryLater('connection');
  if (err instanceof Anthropic.RateLimitError) return retryLater('rate_limited', 429);
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 529) return retryLater('overloaded', status);
    if (status !== undefined && status >= 500) return retryLater('server_error', status);
    if (status === 408) return retryLater('timeout', status);
    if (status === 409) return retryLater('conflict', status);
    if (status === 401 || status === 402 || status === 403 || status === 404) {
      return retryLater('unavailable', status);
    }
    return {
      outcome: 'no_result',
      reason: 'invalid_request',
      ...(status !== undefined ? { status } : {}),
    };
  }
  return { outcome: 'no_result', reason: 'internal_error' };
}

/**
 * The rules, in Polish like the documents. The client's identity is the only
 * client data in it, and only the bound client's own.
 */
export function systemPrompt(client: ClassifierContext['client']): string {
  const nip = client?.nip.replace(/\D+/g, '') ?? '';
  const name = client?.companyName.trim() ?? '';
  const identity =
    nip || name
      ? `Dokument należy do klienta: ${name || '(nazwa nieznana)'}${nip ? `, NIP ${nip}` : ''}. ` +
        'W polu client_role wskaż rolę klienta na fakturze, porównując jego NIP (same cyfry) ' +
        'i nazwę z danymi sprzedawcy i nabywcy: seller, gdy klient jest sprzedawcą lub ' +
        'wystawcą; buyer, gdy jest nabywcą; none, gdy nie jest żadną ze stron; unknown, gdy ' +
        'nie da się tego ustalić. Nie zgaduj: rola musi wynikać z danych na dokumencie.'
      : 'Tożsamość klienta nie jest podana. Nie ustalaj, czy faktura jest sprzedażowa, czy ' +
        'zakupowa: ustaw client_role na unknown. Kierunek faktury ustali księgowy.';

  return [
    'Jesteś asystentem księgowym polskiego biura rachunkowego. Klasyfikujesz jeden dokument ' +
      'klienta do kategorii w strukturze folderów SharePoint tego klienta.',
    identity,
    '',
    'Zasady:',
    '- Kategorię wybierasz na podstawie TREŚCI dokumentu, nie nazwy pliku.',
    '- Faktura to także faktura uproszczona, zaliczkowa, rozliczeniowa, faktura KSeF oraz ' +
      'faktura zagraniczna (invoice, factuur, Rechnung). Faktura trafia do faktury_sprzedazy ' +
      'albo faktury_zakupu, zależnie od roli klienta.',
    '- Paragon fiskalny z NIP-em nabywcy (do 450 zł brutto) to faktura uproszczona, czyli faktura.',
    '- Paragon, potwierdzenie płatności kartą, wydruk z terminala i zagraniczny paragon ' +
      '(klantenbon, receipt, Kassenbon) BEZ danych nabywcy to faktury_noty: dowód księgowy ' +
      'niebędący fakturą VAT.',
    '- Zagraniczna faktura, bilet lub rachunek hotelowy, który wskazuje nabywcę (firmę lub ' +
      'osobę), to faktura.',
    '- Faktura pro forma to inne. Polisa, ogólne warunki ubezpieczenia (OWU) i warunki ' +
      'polisy to umowy.',
    '- Faktura korygująca i anulowanie faktury to faktury_korekty; nota księgowa, ' +
      'obciążeniowa lub uznaniowa to faktury_noty.',
    '- year i month to data dokumentu: data wystawienia faktury, data transakcji paragonu, ' +
      'okres wyciągu. Podaj je zawsze, gdy da się je odczytać; w przeciwnym razie null.',
    '- confidence (0-1) ustaw rzetelnie: niska, gdy nie masz pewności kategorii.',
    '- parties: sprzedawca i nabywca faktury (lub strony umowy, wystawca pisma) z NIP-em ' +
      'i nazwą, jeśli są na dokumencie.',
    '- nieposortowane wybierz tylko wtedy, gdy dokument jest nieczytelny albo nie pasuje ' +
      'do żadnej kategorii.',
    `- invoice: dla kategorii ${INVOICE_FIELD_CATEGORIES.join(', ')} przepisz z dokumentu ` +
      'numer, datę wystawienia, datę sprzedaży, walutę, sumy netto, VAT i brutto oraz numer ' +
      'KSeF. Kwoty zapisuj cyframi z kropką dziesiętną, bez spacji i symbolu waluty (np. ' +
      '1234.50; ujemne na korekcie in minus). Pole, którego nie ma na dokumencie albo którego ' +
      'nie da się odczytać, ustaw na null: nie zgaduj i nie licz. Dla pozostałych kategorii ' +
      'wszystkie pola invoice ustaw na null.',
    '',
    'Kategorie:',
    categoryCatalog.map((c) => `- ${c.id} (${c.polishLabel}): ${c.description}`).join('\n'),
  ].join('\n');
}

function userInstruction(filename: string, preview: PdfPreview | undefined): string {
  return [
    `Nazwa pliku (jedynie wskazówka, może być myląca): "${filename}".`,
    ...(preview
      ? [
          `Dokument ma ${preview.pageCount} stron; załączono tylko pierwsze ${preview.pages}. ` +
            'Sklasyfikuj cały dokument na ich podstawie.',
        ]
      : []),
    'Sklasyfikuj dokument na podstawie jego TREŚCI, nie nazwy pliku.',
  ].join(' ');
}

function parseOutput(message: Anthropic.Message): ModelOutput | null {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = modelOutput.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function toClassification(
  output: ModelOutput,
  model: string,
  preview: PdfPreview | undefined,
): Classification {
  const category = output.category;
  const def = isDocumentCategory(category) ? getCategory(category) : undefined;
  const date = validDate(output.year, output.month);
  let folderPath = '';
  if (def && (!def.dated || date)) folderPath = buildFolderPath(def.id, date);
  const parties = normalizeParties(output.parties ?? []);
  return {
    documentType: def?.polishLabel ?? '',
    folderPath,
    confidence: clamp(output.confidence),
    classifier: 'claude',
    model,
    fields: {
      category,
      ...(date ? { year: date.year, month: date.month } : {}),
      clientRole: output.client_role ?? 'unknown',
      ...(output.reasoning ? { reasoning: output.reasoning } : {}),
      ...(preview ? { pagesRead: preview.pages, pageCount: preview.pageCount } : {}),
    },
    ...(parties.length > 0 ? { parties } : {}),
    ...(hasInvoiceFields(category)
      ? { extraction: buildExtraction(output.invoice ?? null, parties) }
      : {}),
  };
}

/**
 * The index fields of an invoice, receipt or note: the model's `invoice`
 * block and the seller and buyer from its parties, each validated on its own
 * (`@bcr/shared` `invoiceFields`). An invalid value becomes `null`: a NIP
 * with a wrong checksum, an amount in any other notation, a date that does
 * not exist, a currency that is not ISO 4217. Exported for tests.
 */
export function buildExtraction(
  invoice: ModelOutput['invoice'],
  parties: readonly DocumentParty[],
): DocumentExtraction {
  const seller = partyOn(parties, ['seller', 'issuer']);
  const buyer = partyOn(parties, ['buyer', 'recipient']);
  return {
    invoiceNumber: normalizeText(invoice?.number, MAX_INVOICE_NUMBER_LENGTH),
    issueDate: normalizeIsoDate(invoice?.issue_date),
    saleDate: normalizeIsoDate(invoice?.sale_date),
    currency: normalizeCurrency(invoice?.currency),
    netAmount: normalizeAmount(invoice?.net_amount),
    vatAmount: normalizeAmount(invoice?.vat_amount),
    grossAmount: normalizeAmount(invoice?.gross_amount),
    sellerNip: normalizeNip(seller?.nip),
    sellerName: normalizeText(seller?.companyName ?? seller?.personName, MAX_PARTY_NAME_LENGTH),
    buyerNip: normalizeNip(buyer?.nip),
    buyerName: normalizeText(buyer?.companyName ?? buyer?.personName, MAX_PARTY_NAME_LENGTH),
    ksefNumber: normalizeKsefNumber(invoice?.ksef_number),
  };
}

/** The first party in the first of `roles` that has one (seller before issuer). */
function partyOn(
  parties: readonly DocumentParty[],
  roles: readonly PartyRole[],
): DocumentParty | undefined {
  for (const role of roles) {
    const party = parties.find((p) => p.role === role);
    if (party) return party;
  }
  return undefined;
}

/**
 * Turn the raw output into the immutable `DocumentParty` shape. Drops entries
 * that carry no useful signal (no NIP, no name, no person name) and
 * normalizes NIPs to digits-only so downstream comparisons don't have to.
 */
function normalizeParties(raw: NonNullable<ModelOutput['parties']>): readonly DocumentParty[] {
  const out: DocumentParty[] = [];
  for (const p of raw) {
    const role = (PARTY_ROLES as readonly string[]).includes(p.role)
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

const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

function isImageType(type: string): type is (typeof IMAGE_MEDIA_TYPES)[number] {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

function validDate(
  year: number | null | undefined,
  month: number | null | undefined,
): { year: number; month: number } | undefined {
  if (
    typeof year === 'number' &&
    Number.isInteger(year) &&
    year >= 1000 &&
    year <= 9999 &&
    typeof month === 'number' &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
  ) {
    return { year, month };
  }
  return undefined;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** The error's class name only: an SDK message can quote the request. */
/**
 * For a request the API refused (4xx), its error type and message: they
 * describe the request (a schema rule, a page limit), never the document, and
 * without them a 400 cannot be diagnosed. Capped, and empty when absent.
 */
export function apiErrorDetail(err: unknown): Record<string, unknown> {
  if (!(err instanceof Anthropic.APIError)) return {};
  const body = err.error as { error?: { type?: unknown; message?: unknown } } | undefined;
  const type = typeof body?.error?.type === 'string' ? body.error.type : undefined;
  const message =
    typeof body?.error?.message === 'string' ? body.error.message.slice(0, 300) : undefined;
  return {
    ...(type ? { apiErrorType: type } : {}),
    ...(message ? { apiErrorMessage: message } : {}),
  };
}

function describeError(err: unknown): Record<string, unknown> {
  return err instanceof Error ? { name: err.name } : { type: typeof err };
}
