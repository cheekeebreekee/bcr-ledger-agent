/**
 * Output of a single classifier strategy.
 *
 * `confidence` is on `[0, 1]`. It is the classifier's suggestion only: the
 * ingestion acceptance policy decides whether it is filed under its category
 * or sent to manual review.
 */
export interface Classification {
  readonly documentType: string;
  readonly confidence: number;
  /** Identifier of the classifier that produced this result. */
  readonly classifier: string;
  /**
   * Folder path the classifier computed, relative to the drive root; `''` when
   * it could not build one (a dated category without a date). Never used to
   * file a document: the acceptance policy rebuilds the path from the category.
   */
  readonly folderPath: string;
  /** Optional structured fields extracted from the filename/content. */
  readonly fields: Readonly<Record<string, string | number | undefined>>;
  /**
   * Parties identified in the document content (relevant for invoices and
   * contracts). Populated by content-based classifiers such as Claude;
   * `undefined` when no extraction was performed. Used to settle invoice
   * direction (sales vs purchase) from the bound client's own NIP.
   */
  readonly parties?: readonly DocumentParty[];
  /** The model that answered (`message.model`), for model-backed classifiers. */
  readonly model?: string;
  /**
   * Review flags raised while classifying, e.g. `DIRECTION_UNRESOLVED`. They
   * are only flags: the acceptance policy is what sends a document to review.
   */
  readonly reviewReasons?: readonly string[];
  /**
   * The searchable fields of an invoice, receipt or note, read from the
   * content in the same model call and validated after it. Only for the
   * categories the taxonomy marks `invoiceFields`; absent otherwise. Client
   * data: written to the document index, never logged.
   */
  readonly extraction?: DocumentExtraction;
}

/**
 * The fields the document index is searched by, for an invoice, a receipt or
 * a note. Every value is normalised or `null` (not on the document, or not
 * valid — a wrong NIP or amount is worse than none): see
 * `parsers/invoiceFields.ts`. Seller and buyer come from the parties.
 */
export interface DocumentExtraction {
  /** As printed, whitespace collapsed. */
  readonly invoiceNumber: string | null;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string | null;
  /** `YYYY-MM-DD`: the date of sale or of the service, when printed. */
  readonly saleDate: string | null;
  /** ISO 4217, e.g. `PLN`. */
  readonly currency: string | null;
  /** Decimal strings with two places, e.g. `1234.50`; negative on a correction. */
  readonly netAmount: string | null;
  readonly vatAmount: string | null;
  readonly grossAmount: string | null;
  /** Ten digits with a valid checksum. */
  readonly sellerNip: string | null;
  readonly sellerName: string | null;
  readonly buyerNip: string | null;
  readonly buyerName: string | null;
  /** Upper-cased; see `normalizeKsefNumber`. */
  readonly ksefNumber: string | null;
}

/** The keys of {@link DocumentExtraction}, in a stable order. */
export const DOCUMENT_EXTRACTION_FIELDS = [
  'invoiceNumber',
  'issueDate',
  'saleDate',
  'currency',
  'netAmount',
  'vatAmount',
  'grossAmount',
  'sellerNip',
  'sellerName',
  'buyerNip',
  'buyerName',
  'ksefNumber',
] as const satisfies readonly (keyof DocumentExtraction)[];

export type DocumentExtractionField = (typeof DOCUMENT_EXTRACTION_FIELDS)[number];

/** The role a party plays in a document. */
export type PartyRole = 'seller' | 'buyer' | 'issuer' | 'recipient' | 'unknown';

/** A single party (organisation or individual) referenced in a document. */
export interface DocumentParty {
  readonly role: PartyRole;
  /** Digits-only NIP if extractable, otherwise `undefined`. */
  readonly nip?: string;
  /** Company / organisation name, when the party is a legal entity. */
  readonly companyName?: string;
  /** Full name, when the party is an individual (owner, signatory, etc.). */
  readonly personName?: string;
}

export interface ClassifierContext {
  readonly filename: string;
  /** Lazy access to the document bytes (only read if needed). */
  readonly readContent: () => Promise<Buffer>;
  readonly contentType: string;
  /**
   * The bound client's own identity, injected by the caller AFTER routing has
   * resolved the client. Content-based classifiers use it to tell sales from
   * purchase invoices; without it, invoice direction stays unresolved and the
   * document goes to manual review. It never selects or changes the client.
   */
  readonly client?: {
    readonly nip: string;
    readonly companyName: string;
  };
}

/**
 * A classifier that could not classify the document for a reason that is
 * about the document or the request (unsupported type, too large, a 400,
 * malformed output, a refusal). The next classifier runs; the document ends
 * up in manual review.
 */
export interface ClassifierNoResult {
  readonly outcome: 'no_result';
  /** A code, never free text: `unsupported_type`, `too_large`, `pdf_trim_failed`, … */
  readonly reason: string;
  /** The model API's HTTP status, when there was one. */
  readonly status?: number;
}

/**
 * A classifier that could not classify the document NOW (rate limit, overload,
 * a 5xx, a timeout, a lost connection). Not a classification result: the
 * document must be tried again later, never filed for review because of it.
 */
export interface ClassifierRetryLater {
  readonly outcome: 'retry_later';
  /** A code: `rate_limited`, `overloaded`, `server_error`, `timeout`, `connection`, … */
  readonly reason: string;
  /** The model API's HTTP status, when there was one (429, 529, 5xx). */
  readonly status?: number;
}

/** What a classifier returns. `null` is a no-result without a reason. */
export type ClassifierResult = Classification | ClassifierNoResult | ClassifierRetryLater | null;

export interface Classifier {
  readonly name: string;
  classify(ctx: ClassifierContext): Promise<ClassifierResult>;
}

/** Whether a classifier said "try again later" rather than giving a result. */
export function isRetryLater(result: ClassifierResult): result is ClassifierRetryLater {
  return result !== null && 'outcome' in result && result.outcome === 'retry_later';
}

/** Whether a classifier gave up on the document, with a reason. */
export function isNoResult(result: ClassifierResult): result is ClassifierNoResult {
  return result !== null && 'outcome' in result && result.outcome === 'no_result';
}
