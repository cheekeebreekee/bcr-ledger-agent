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
   * `activity.conversation.conversationType`: `personal` for a 1:1 chat with
   * the bot, `groupChat` or `channel` otherwise. Only `personal` is ever
   * processed; the bot refuses anything else before downloading, and the
   * ingestion API re-checks it.
   */
  readonly conversationType: string | undefined;
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

/**
 * Successful classification + upload outcome for one document, filed inside
 * the uploader's own client space. Carries no model free text: the card
 * renders a fixed Polish label per category, never the model's reasoning.
 */
export interface IngestionUploadResult {
  readonly driveItemId: string;
  /** Link into the uploader's own client space only. */
  readonly webUrl: string;
  readonly folderPath: string;
  readonly finalFilename: string;
  readonly classification: {
    /** Polish label of the category (from the taxonomy, not the model). */
    readonly documentType: string;
    /** `folderTaxonomy` category id, e.g. `faktury_zakupu`. */
    readonly categoryId: string;
    readonly confidence: number;
    readonly classifier: string;
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

/**
 * Per-document outcome inside a batch response.
 *
 *  - `uploaded`: filed in the uploader's client space; `result` is set.
 *  - `quarantined`: held in the staff-only quarantine because the upload could
 *    not be tied to exactly one client. Deliberately carries no link, folder,
 *    stored name or client name — the uploader learns nothing about where it
 *    went or which clients exist.
 *  - `rejected`: not stored; `error` explains why (generic, Polish-rendered by
 *    the bot).
 */
export interface IngestionBatchItemResult {
  readonly filename: string;
  readonly status: 'uploaded' | 'quarantined' | 'rejected';
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
