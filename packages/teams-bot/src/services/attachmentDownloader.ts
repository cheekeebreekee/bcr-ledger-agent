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
 *
 * Error messages never include the attachment name or URL: they end up in
 * logs, and both are user data (the URL also carries a SAS token).
 */
export interface DownloadedAttachment {
  readonly content: Buffer;
  readonly contentType: string;
}

/** The subset of undici's `request` the downloader uses; injectable for tests. */
export type DownloadFetcher = (
  url: string,
  options: { method: 'GET' },
) => Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: { arrayBuffer(): Promise<ArrayBuffer> };
}>;

export interface AttachmentDownloaderOptions {
  /** Optional override for tests. Defaults to undici's `request`. */
  readonly fetcher?: DownloadFetcher;
}

interface TeamsDownloadInfoContent {
  readonly downloadUrl: string;
  readonly uniqueId?: string;
  readonly fileType?: string;
}

const TEAMS_FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';
const OCTET_STREAM = 'application/octet-stream';

export class AttachmentDownloader {
  private readonly log = createLogger('bot/attachmentDownloader');
  private readonly fetcher: DownloadFetcher;

  constructor(opts: AttachmentDownloaderOptions = {}) {
    this.fetcher = opts.fetcher ?? request;
  }

  async download(attachment: Attachment): Promise<DownloadedAttachment> {
    if (attachment.contentType?.startsWith(TEAMS_FILE_DOWNLOAD_INFO)) {
      return this.downloadTeamsFile(attachment);
    }
    if (attachment.contentUrl) {
      return this.downloadFromUrl(attachment.contentUrl, attachment.contentType ?? OCTET_STREAM);
    }
    if (typeof attachment.content === 'string') {
      // Inline base64 (rare, but seen in some channels)
      return {
        content: Buffer.from(attachment.content, 'base64'),
        contentType: attachment.contentType ?? OCTET_STREAM,
      };
    }
    throw new Error('Attachment has no downloadable payload');
  }

  private async downloadTeamsFile(attachment: Attachment): Promise<DownloadedAttachment> {
    const content = attachment.content as TeamsDownloadInfoContent | undefined;
    if (!content?.downloadUrl) {
      throw new Error('Teams file attachment is missing a downloadUrl');
    }
    const inferredContentType = mimeFromExtension(attachment.name) ?? OCTET_STREAM;
    return this.downloadFromUrl(content.downloadUrl, inferredContentType);
  }

  private async downloadFromUrl(
    url: string,
    fallbackContentType: string,
  ): Promise<DownloadedAttachment> {
    // No URL in the log: it carries a SAS token and the tenant host.
    this.log.debug('GET attachment');
    const { statusCode, body, headers } = await this.fetcher(url, { method: 'GET' });
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
export function mimeFromExtension(filename: string | undefined): string | undefined {
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
