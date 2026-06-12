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

export interface IngestionRequestPayload {
  readonly filename: string;
  readonly contentType: string;
  /** Base64 encoded bytes. Bytes >4 MiB should use an upload-session route instead. */
  readonly contentBase64: string;
  readonly source: {
    readonly tenantId: string;
    readonly channelId: string;
    readonly conversationId: string;
    readonly activityId: string;
    /** Present when the message came from a signed-in Teams user. */
    readonly userAadObjectId: string | undefined;
    readonly userDisplayName: string | undefined;
  };
}

export interface IngestionResponsePayload {
  readonly status: 'uploaded' | 'queued' | 'rejected';
  readonly result?: {
    readonly driveItemId: string;
    readonly webUrl: string;
    readonly folderPath: string;
    readonly finalFilename: string;
    readonly classification: {
      readonly documentType: string;
      readonly confidence: number;
      readonly classifier: string;
    };
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
