import {
  DOCUMENT_EXTRACTION_FIELDS,
  invoiceCategoryForDirection,
  isDocumentCategory,
  MAX_INVOICE_NUMBER_LENGTH,
  MAX_PARTY_NAME_LENGTH,
  normalizeAmount,
  normalizeCurrency,
  normalizeIsoDate,
  normalizeKsefNumber,
  normalizeNip,
  normalizeText,
  type DocumentCategory,
  type DocumentExtractionField,
} from '@bcr/shared';
import { z } from 'zod';

/**
 * A truth label for "an invoice, direction not asserted": the category is
 * right if the classifier picked either invoice folder. Used when the truth
 * does not say which side the client is on.
 */
export const INVOICE_FAMILY = 'faktura';

export type TruthCategory = DocumentCategory | typeof INVOICE_FAMILY;
export type TruthDirection = 'sprzedaz' | 'zakup';

/** The invoice fields a truth entry asserts, each already in its compared form. */
export type TruthFields = Readonly<Partial<Record<DocumentExtractionField, string>>>;

/**
 * One labelled document. `truth.json` is an array of these:
 *
 *     [{ "file": "fv-01.pdf", "category": "faktury_zakupu", "month": "2026-09",
 *        "direction": "zakup",
 *        "fields": { "invoiceNumber": "FV/12/2026", "grossAmount": "1230.00",
 *                    "sellerNip": "526-025-02-74" } }]
 *
 * `file` is a name inside the `--dir` folder (no path). `month` is the
 * document's month, `YYYY-MM`, or `""` when it has none. `direction` is
 * optional; when given, `category` is the matching invoice folder or
 * `faktura`. `fields` is optional too, and so is each of its keys (those of
 * `DocumentExtraction`): only the fields given are scored.
 */
export interface TruthEntry {
  readonly file: string;
  readonly category: TruthCategory;
  readonly month: string;
  readonly direction?: TruthDirection;
  readonly fields?: TruthFields;
}

/**
 * How a field is compared, truth and extraction alike: the extraction's own
 * validators, so `526-025-02-74` equals `5260250274` and `1 230,00` equals
 * `1230.00`; invoice numbers ignore case and spaces, names compare as
 * {@link normalizeName}. `null`: not a valid value.
 */
export const FIELD_COMPARATORS: Readonly<
  Record<DocumentExtractionField, (value: string) => string | null>
> = {
  invoiceNumber: (v) =>
    normalizeText(v, MAX_INVOICE_NUMBER_LENGTH)?.replace(/\s+/g, '').toUpperCase() ?? null,
  issueDate: normalizeIsoDate,
  saleDate: normalizeIsoDate,
  currency: normalizeCurrency,
  netAmount: normalizeAmount,
  vatAmount: normalizeAmount,
  grossAmount: normalizeAmount,
  sellerNip: normalizeNip,
  sellerName: (v) => normalizeName(normalizeText(v, MAX_PARTY_NAME_LENGTH) ?? '') || null,
  buyerNip: normalizeNip,
  buyerName: (v) => normalizeName(normalizeText(v, MAX_PARTY_NAME_LENGTH) ?? '') || null,
  ksefNumber: normalizeKsefNumber,
};

const fieldsSchema = z
  .object(
    Object.fromEntries(DOCUMENT_EXTRACTION_FIELDS.map((f) => [f, z.string().optional()])) as Record<
      DocumentExtractionField,
      z.ZodOptional<z.ZodString>
    >,
  )
  .strict()
  .transform((fields, ctx) => {
    const out: Partial<Record<DocumentExtractionField, string>> = {};
    for (const field of DOCUMENT_EXTRACTION_FIELDS) {
      const raw = fields[field];
      if (raw === undefined) continue;
      const compared = FIELD_COMPARATORS[field](raw);
      if (compared === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'not a valid value' });
        continue;
      }
      out[field] = compared;
    }
    return out;
  });

const MONTH = /^(\d{4}-(0[1-9]|1[0-2]))?$/;

const entrySchema = z
  .object({
    file: z
      .string()
      .min(1)
      .refine(
        (f) => !/[\\/]/.test(f) && f !== '.' && f !== '..',
        'must be a file name, not a path',
      ),
    category: z
      .string()
      .refine(
        (c) => c === INVOICE_FAMILY || isDocumentCategory(c),
        `must be a category id or "${INVOICE_FAMILY}"`,
      ),
    month: z.string().regex(MONTH, 'must be YYYY-MM or ""'),
    direction: z.enum(['sprzedaz', 'zakup']).optional(),
    fields: fieldsSchema.optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (
      e.direction &&
      e.category !== INVOICE_FAMILY &&
      e.category !== invoiceCategoryForDirection(e.direction)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `direction ${e.direction} does not match category ${e.category}`,
      });
    }
  });

/**
 * Reads a parsed `truth.json`. Throws with every problem listed by entry
 * index; an entry with a direction gets the matching invoice category.
 */
export function parseTruth(json: unknown): TruthEntry[] {
  const parsed = z.array(entrySchema).safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? `[${i.path.join('.')}]` : 'truth'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid truth file: ${issues}`);
  }
  const seen = new Set<string>();
  const entries: TruthEntry[] = [];
  for (const e of parsed.data) {
    if (seen.has(e.file)) throw new Error(`Invalid truth file: "${e.file}" is listed twice`);
    seen.add(e.file);
    const category: TruthCategory = e.direction
      ? invoiceCategoryForDirection(e.direction)
      : (e.category as TruthCategory);
    entries.push({
      file: e.file,
      category,
      month: e.month,
      ...(e.direction ? { direction: e.direction } : {}),
      ...(e.fields && Object.keys(e.fields).length > 0 ? { fields: e.fields } : {}),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The independent reviewers' arbiter report → truth.json
// ---------------------------------------------------------------------------

/** One row of the arbiter report (`tools/out/evaluations/*.json`, local only). */
export interface ArbiterRow {
  readonly local?: string;
  readonly reviewerCategory?: string;
  readonly pipelineCategory?: string;
  readonly month?: string;
  readonly seller?: string;
  readonly buyer?: string;
  readonly verdict?: string;
  readonly adjudication?: {
    readonly winner?: string;
    readonly correctCategory?: string;
  };
}

/** Whose documents they are: used to set the direction of invoices. */
export interface ClientIdentity {
  readonly name?: string;
  readonly nip?: string;
}

const DIRECTION_UNKNOWN = 'direction_unknown';

/**
 * Converts the arbiter report into truth entries. The category is the
 * reviewers' when they agreed with the pipeline, otherwise the arbiter's
 * winner (`reviewer`: the leading category id of `correctCategory`;
 * `pipeline`; `both_acceptable`: the reviewer's). "direction_unknown"
 * becomes the invoice family. With a client identity, an invoice whose
 * seller or buyer (and not both) names the client gets that direction.
 * Throws on a row it cannot place, naming its index only.
 */
export function arbiterToTruth(
  rows: readonly ArbiterRow[],
  client: ClientIdentity = {},
): TruthEntry[] {
  return parseTruth(
    rows.map((row, index) => {
      const file = baseName(row.local ?? '');
      if (!file) throw new Error(`Arbiter row ${index}: no file`);
      const decided = decidedCategory(row);
      const category = decided === DIRECTION_UNKNOWN ? INVOICE_FAMILY : decided;
      if (category !== INVOICE_FAMILY && !isDocumentCategory(category)) {
        throw new Error(`Arbiter row ${index}: no category id in its verdict`);
      }
      const month = MONTH.test(row.month ?? '') ? (row.month ?? '') : '';
      const direction = isInvoiceTruth(category)
        ? (directionOf(row, client) ?? explicitDirection(category))
        : undefined;
      return { file, category, month, ...(direction ? { direction } : {}) };
    }),
  );
}

function decidedCategory(row: ArbiterRow): string {
  const reviewer = row.reviewerCategory ?? '';
  if (row.verdict === 'agree') return reviewer;
  switch (row.adjudication?.winner) {
    case 'pipeline':
      return row.pipelineCategory ?? '';
    case 'reviewer': {
      const lead = /^[a-z_]+/.exec(row.adjudication.correctCategory ?? '')?.[0] ?? '';
      return lead === DIRECTION_UNKNOWN || isDocumentCategory(lead) ? lead : reviewer;
    }
    default:
      return reviewer;
  }
}

function isInvoiceTruth(category: string): boolean {
  return (
    category === INVOICE_FAMILY || category === 'faktury_sprzedazy' || category === 'faktury_zakupu'
  );
}

function explicitDirection(category: string): TruthDirection | undefined {
  if (category === 'faktury_sprzedazy') return 'sprzedaz';
  if (category === 'faktury_zakupu') return 'zakup';
  return undefined;
}

/** The client's side, when exactly one of seller and buyer names it. */
function directionOf(row: ArbiterRow, client: ClientIdentity): TruthDirection | undefined {
  const seller = names(row.seller ?? '', client);
  const buyer = names(row.buyer ?? '', client);
  if (seller === buyer) return undefined;
  return seller ? 'sprzedaz' : 'zakup';
}

function names(party: string, client: ClientIdentity): boolean {
  const nip = (client.nip ?? '').replace(/\D+/g, '');
  if (nip.length === 10 && party.replace(/\D+/g, '').includes(nip)) return true;
  const name = normalizeName(client.name ?? '');
  if (name.length < 3) return false;
  const text = normalizeName(party);
  return text.includes(name);
}

/** Lower case, no diacritics, no punctuation: `BCR Group Sp. z o.o.` → `bcr group sp z o o`. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}
