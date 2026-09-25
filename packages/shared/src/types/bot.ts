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
  /**
   * Bot Framework platform id — always the literal `"msteams"` for Teams.
   * Do NOT use this to identify a specific Teams channel; use `teamsChannelId` instead.
   */
  readonly channelId: string;
  /**
   * The Bot Framework conversation id (`activity.conversation.id`). For a
   * channel-scoped Teams conversation this is derived from the Teams channel
   * id but may include a `;messageid=...` suffix on reply threads.
   */
  readonly conversationId: string;
  readonly activityId: string;
  /**
   * The Teams channel id (`activity.channelData.channel.id`), format
   * `19:<hash>@thread.tacv2`. Present only for messages posted inside a
   * team channel — undefined for 1:1 personal chats and group chats.
   *
   * Kept as observability only: Teams channel messages don't reliably
   * deliver file attachments to bots (files drop-attached in a channel
   * bypass Bot Framework entirely, and `@mention` messages only carry
   * the mention HTML). Routing is user-identity-based; this field is
   * logged for support/telemetry.
   */
  readonly teamsChannelId: string | undefined;
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

/**
 * Response of `GET /api/user-target?userAadObjectId={guid}`. Tells the
 * caller (currently the bot's Personal Tab handler) which SharePoint site
 * a given Teams user belongs to, so the tab can send them there directly.
 */
export interface UserTargetResponsePayload {
  /** Directory client id, or the fallback client id when no user match. */
  readonly clientId: string;
  /** Human-readable client name (from `Title` or fallback title). */
  readonly title: string;
  /** How the client was resolved: `'directory'` for a user match, `'fallback'` otherwise. */
  readonly source: 'directory' | 'fallback';
  /** SharePoint hostname, e.g. `bcrgroupeu.sharepoint.com`. */
  readonly siteHostname: string;
  /** Site path, e.g. `/sites/0002PESKOVOISp.zo.o.-Ksigowo`. */
  readonly sitePath: string;
  /** Drive display name (Polish locale usually `Dokumenty`). */
  readonly driveName: string;
  /** Best-effort deep link to the client's document library homepage. */
  readonly sharepointWebUrl: string;
}
