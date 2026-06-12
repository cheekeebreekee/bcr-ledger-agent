import type { Attachment } from 'botbuilder';
import { request } from 'undici';
import { createLogger } from '@bcr/shared';

/**
 * Downloads the bytes behind a Teams / Bot Framework `Attachment`.
 *
 * Two attachment shapes need to be supported:
 *
 *   1. **Teams file picker** — `contentType` is
 *      `application/vnd.microsoft.teams.file.download.info` and
 *      `content.downloadUrl` is a pre-authorised Microsoft Graph SAS URL.
 *      We can fetch it with no auth header.
 *
 *   2. **Bot Framework attachment** (used by the emulator and channels
 *      such as Web Chat) — `contentUrl` points to the bot's attachment
 *      service. The URL itself is signed, so again no auth header is
 *      required, but the underlying bytes might be base64 in `content`.
 */
export interface DownloadedAttachment {
  readonly content: Buffer;
  readonly contentType: string;
}

interface TeamsDownloadInfoContent {
  readonly downloadUrl: string;
  readonly uniqueId?: string;
  readonly fileType?: string;
}

export class AttachmentDownloader {
  private readonly log = createLogger('bot/attachmentDownloader');

  async download(attachment: Attachment): Promise<DownloadedAttachment> {
    if (attachment.contentType?.startsWith('application/vnd.microsoft.teams.file.download.info')) {
      return this.downloadTeamsFile(attachment);
    }
    if (attachment.contentUrl) {
      return this.downloadFromUrl(attachment.contentUrl, attachment.contentType ?? 'application/octet-stream');
    }
    if (typeof attachment.content === 'string') {
      // Inline base64 (rare, but seen in some channels)
      return {
        content: Buffer.from(attachment.content, 'base64'),
        contentType: attachment.contentType ?? 'application/octet-stream',
      };
    }
    throw new Error(`Attachment "${attachment.name}" has no downloadable payload`);
  }

  private async downloadTeamsFile(attachment: Attachment): Promise<DownloadedAttachment> {
    const content = attachment.content as TeamsDownloadInfoContent | undefined;
    if (!content?.downloadUrl) {
      throw new Error(`Teams file "${attachment.name}" is missing a downloadUrl`);
    }
    const inferredContentType = mimeFromExtension(attachment.name) ?? 'application/octet-stream';
    return this.downloadFromUrl(content.downloadUrl, inferredContentType);
  }

  private async downloadFromUrl(url: string, fallbackContentType: string): Promise<DownloadedAttachment> {
    this.log.debug({ url: redactSas(url) }, 'GET attachment');
    const { statusCode, body, headers } = await request(url, { method: 'GET' });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Attachment download failed with HTTP ${statusCode}`);
    }
    const buf = Buffer.from(await body.arrayBuffer());
    const contentType =
      (typeof headers['content-type'] === 'string' ? headers['content-type'] : undefined) ??
      fallbackContentType;
    return { content: buf, contentType };
  }
}

/** Guess content-type from extension for the cases where headers lie. */
function mimeFromExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'csv':
      return 'text/csv';
    default:
      return undefined;
  }
}

/** Replace SAS tokens with `***` for safe logging. */
function redactSas(url: string): string {
  return url.replace(/([?&])(sig|sv|st|se|tempauth|UniqueId)=[^&]+/gi, '$1$2=***');
}
