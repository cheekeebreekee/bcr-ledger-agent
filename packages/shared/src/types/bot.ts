/**
 * Bot Framework / Teams-specific shared types. These are intentionally
 * structural so we don't drag the heavy `botbuilder` dependency into
 * packages that don't need it.
 */
export interface TeamsAttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  /**
   * Microsoft Graph downloadUrl OR Bot Framework attachment service URL,
   * depending on whether the file was uploaded via Teams (Graph) or
   * sent inline by an emulator (Bot Framework).
   */
  readonly contentUrl: string;
  readonly source: 'graph' | 'bot-framework';
}

/** Where an ingestion request originated (shared by single & batch calls). */
export interface IngestionSource {
  readonly tenantId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly activityId: string;
  /** Present when the message came from a signed-in Teams user. */
  readonly userAadObjectId: string | undefined;
  readonly userDisplayName: string | undefined;
}

/** A single document to classify and file. */
export interface IngestionDocument {
  readonly filename: string;
  readonly contentType: string;
  /** Base64 encoded bytes. Bytes >4 MiB should use an upload-session route instead. */
  readonly contentBase64: string;
}

export interface IngestionRequestPayload extends IngestionDocument {
  readonly source: IngestionSource;
}

/** Successful classification + upload outcome for one document. */
export interface IngestionUploadResult {
  readonly driveItemId: string;
  readonly webUrl: string;
  readonly folderPath: string;
  readonly finalFilename: string;
  readonly classification: {
    readonly documentType: string;
    readonly confidence: number;
    readonly classifier: string;
    /** Short justification (in Polish) for why this folder was chosen. */
    readonly reasoning?: string;
  };
}

export interface IngestionResponsePayload {
  readonly status: 'uploaded' | 'queued' | 'rejected';
  readonly result?: IngestionUploadResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Batch ingestion. Multiple documents from the same Teams activity are
 * classified and filed in a single request so the user gets one consolidated
 * summary table instead of a card per file.
 */
export interface IngestionBatchRequestPayload {
  readonly documents: readonly IngestionDocument[];
  readonly source: IngestionSource;
}

/** Per-document outcome inside a batch response. */
export interface IngestionBatchItemResult {
  readonly filename: string;
  readonly status: 'uploaded' | 'rejected';
  readonly result?: IngestionUploadResult;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface IngestionBatchResponsePayload {
  readonly status: 'completed';
  readonly results: readonly IngestionBatchItemResult[];
}
