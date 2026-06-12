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
}

export interface ClassifierContext {
  readonly filename: string;
  /** Lazy access to the document bytes (only read if needed). */
  readonly readContent: () => Promise<Buffer>;
  readonly contentType: string;
}

export interface Classifier {
  readonly name: string;
  classify(ctx: ClassifierContext): Promise<Classification | null>;
}
