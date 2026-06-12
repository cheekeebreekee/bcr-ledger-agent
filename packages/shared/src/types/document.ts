/**
 * A document accepted from a Teams chat attachment, normalised and
 * ready to be ingested by the document-ingestion API.
 */
export interface IncomingDocument {
  /** Original filename as supplied by Teams, including extension. */
  readonly filename: string;

  /** MIME type (e.g. `application/pdf`). */
  readonly contentType: string;

  /** Raw bytes of the document. */
  readonly content: Buffer;

  /** Size in bytes. Mirrors `content.length` but kept for convenience. */
  readonly sizeBytes: number;

  /** Metadata propagated from the Teams activity for tracing/auditing. */
  readonly source: IncomingDocumentSource;
}

export interface IncomingDocumentSource {
  readonly tenantId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly activityId: string;
  readonly userAadObjectId: string | undefined;
  readonly userDisplayName: string | undefined;
}

/**
 * The result of a successful ingestion.
 */
export interface IngestionResult {
  readonly driveItemId: string;
  readonly webUrl: string;
  readonly folderPath: string;
  readonly finalFilename: string;
  readonly classification: {
    readonly documentType: string;
    readonly confidence: number;
    readonly classifier: string;
  };
}
