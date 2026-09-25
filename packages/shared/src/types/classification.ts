/**
 * Output of a single classifier strategy.
 *
 * `confidence` is on `[0, 1]`. A classifier should return `null` if it
 * has nothing useful to say (i.e. the file does not match its pattern).
 */
export interface Classification {
  readonly documentType: string;
  readonly confidence: number;
  /** Identifier of the classifier that produced this result. */
  readonly classifier: string;
  /** Computed SharePoint folder path, relative to the drive root. */
  readonly folderPath: string;
  /** Optional structured fields extracted from the filename/content. */
  readonly fields: Readonly<Record<string, string | number | undefined>>;
  /**
   * Parties identified in the document content (relevant for invoices and
   * contracts). Populated by content-based classifiers such as Claude;
   * `undefined` when no extraction was performed. Consumers use this to
   * cross-reference against the Client Directory and to determine invoice
   * direction (sales vs purchase) post-classification.
   */
  readonly parties?: readonly DocumentParty[];
}

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
   * Optional client identity hint injected by the caller AFTER routing has
   * pre-resolved a client. When present, content-based classifiers can use
   * it to determine invoice direction (sales/purchase) during classification
   * instead of leaving direction ambiguous. Absent when the request routes
   * to the fallback bucket \u2014 direction is derived post-classification
   * from extracted parties in that case.
   */
  readonly client?: {
    readonly nip: string;
    readonly companyName: string;
  };
}

export interface Classifier {
  readonly name: string;
  classify(ctx: ClassifierContext): Promise<Classification | null>;
}
