import type { Client } from '@microsoft/microsoft-graph-client';
import {
  createLogger,
  SharePointError,
  type DriveItemRef,
  type ResolvedSharePointTarget,
  type SharePointTarget,
} from '@bcr/shared';
import { sanitizeFolderPath, sanitizeFilename, joinFolderPath } from '../utils/pathBuilder';
import { retry, AbortRetryError } from '../utils/retry';

/**
 * Cut-off for using a simple PUT vs. an upload session. The Graph docs
 * recommend ≤ 4 MiB for `PUT /content`.
 */
const SIMPLE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

/** 320 KiB-aligned chunk size for upload sessions (Graph requirement). */
const CHUNK_SIZE_BYTES = 5 * 320 * 1024; // ~1.5 MiB

export interface UploadDocumentArgs {
  readonly folderPath: string;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/**
 * Thin SharePoint façade over Microsoft Graph. Exposes only the operations
 * the ingestion API actually needs:
 *
 *  - resolve site + drive ids (cached)
 *  - ensure a folder hierarchy exists
 *  - upload a file (with simple or chunked strategy)
 *  - resolve filename collisions with `_n` suffixes
 */
export class SharePointService {
  private readonly log = createLogger('ingestion/sharePointService');
  private resolvedTarget: Promise<ResolvedSharePointTarget> | undefined;

  constructor(
    private readonly graph: Client,
    private readonly target: SharePointTarget,
  ) {}

  async uploadDocument(args: UploadDocumentArgs): Promise<DriveItemRef> {
    const target = await this.getResolvedTarget();
    const cleanFolder = sanitizeFolderPath(joinFolderPath(target.rootFolder, args.folderPath));
    const cleanFilename = sanitizeFilename(args.filename);

    await this.ensureFolderPath(target.driveId, cleanFolder);
    const finalFilename = await this.resolveCollisionFreeName(
      target.driveId,
      cleanFolder,
      cleanFilename,
    );
    const fullPath = `${cleanFolder}/${finalFilename}`.replace(/^\/+/, '');

    this.log.info({ fullPath, sizeBytes: args.content.length }, 'uploading to SharePoint');

    if (args.content.length <= SIMPLE_UPLOAD_LIMIT_BYTES) {
      return this.simpleUpload(target.driveId, fullPath, args.content, args.contentType);
    }
    return this.chunkedUpload(target.driveId, fullPath, args.content, args.contentType);
  }

  // -------------------------------------------------------------------------

  private getResolvedTarget(): Promise<ResolvedSharePointTarget> {
    if (!this.resolvedTarget) {
      this.resolvedTarget = this.resolveTarget().catch((err) => {
        // Don't cache the failure — let the next request try again.
        this.resolvedTarget = undefined;
        throw err;
      });
    }
    return this.resolvedTarget;
  }

  private async resolveTarget(): Promise<ResolvedSharePointTarget> {
    const sitePath = this.target.sitePath.replace(/^\/+/, '');
    const site = (await this.graph
      .api(`/sites/${this.target.siteHostname}:/${sitePath}`)
      .get()) as { id: string };
    const drives = (await this.graph.api(`/sites/${site.id}/drives`).get()) as {
      value: { id: string; name: string }[];
    };
    const drive = drives.value.find((d: { id: string; name: string }) => d.name === this.target.driveName);
    if (!drive) {
      throw new SharePointError(
        `Drive "${this.target.driveName}" not found in site ${this.target.sitePath}`,
        404,
      );
    }
    return { ...this.target, siteId: site.id, driveId: drive.id };
  }

  /**
   * Walk the folder hierarchy from the drive root, creating each segment
   * that doesn't yet exist. Idempotent — a 409 (folder already exists) is
   * treated as success.
   */
  private async ensureFolderPath(driveId: string, folderPath: string): Promise<void> {
    const segments = folderPath.split('/').filter(Boolean);
    let parent = 'root';

    for (const segment of segments) {
      try {
        await this.graph
          .api(`/drives/${driveId}/items/${parent}/children`)
          .post({
            name: segment,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'fail',
          });
      } catch (err) {
        if (!isConflictError(err)) {
          throw new SharePointError(`Failed to create folder "${segment}"`, 502, err);
        }
      }
      // Re-fetch parent id (whether we created it or it already existed).
      const item = (await this.graph
        .api(`/drives/${driveId}/items/${parent}:/${segment}`)
        .get()) as { id: string };
      parent = item.id;
    }
  }

  private async resolveCollisionFreeName(
    driveId: string,
    folderPath: string,
    desired: string,
  ): Promise<string> {
    const { name, ext } = splitExtension(desired);
    let candidate = desired;
    for (let i = 1; i <= 10; i++) {
      const exists = await this.fileExists(driveId, folderPath, candidate);
      if (!exists) return candidate;
      candidate = `${name}_${i}${ext}`;
    }
    throw new SharePointError(`Too many filename collisions for "${desired}"`, 409);
  }

  private async fileExists(driveId: string, folderPath: string, filename: string): Promise<boolean> {
    try {
      const path = `${folderPath}/${filename}`.replace(/^\/+/, '');
      await this.graph.api(`/drives/${driveId}/root:/${path}`).get();
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  private async simpleUpload(
    driveId: string,
    fullPath: string,
    content: Buffer,
    contentType: string,
  ): Promise<DriveItemRef> {
    return retry(
      async () => {
        try {
          return (await this.graph
            .api(`/drives/${driveId}/root:/${fullPath}:/content`)
            .header('Content-Type', contentType)
            .put(content)) as DriveItemRef;
        } catch (err) {
          if (isRetryableError(err)) throw err;
          throw new AbortRetryError(err instanceof Error ? err.message : String(err));
        }
      },
      { retries: 3, minTimeoutMs: 250, factor: 2 },
    );
  }

  private async chunkedUpload(
    driveId: string,
    fullPath: string,
    content: Buffer,
    _contentType: string,
  ): Promise<DriveItemRef> {
    const session = await this.graph
      .api(`/drives/${driveId}/root:/${fullPath}:/createUploadSession`)
      .post({
        item: { '@microsoft.graph.conflictBehavior': 'rename' },
      });

    const uploadUrl: string = session.uploadUrl;
    let offset = 0;
    let lastResponse: unknown;

    while (offset < content.length) {
      const end = Math.min(offset + CHUNK_SIZE_BYTES, content.length);
      const chunk = content.subarray(offset, end);
      const rangeHeader = `bytes ${offset}-${end - 1}/${content.length}`;

      lastResponse = await retry(
        async () => {
          const res = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Length': String(chunk.length),
              'Content-Range': rangeHeader,
            },
            body: chunk,
          });
          if (res.status === 202) {
            return await res.json();
          }
          if (res.status === 200 || res.status === 201) {
            return (await res.json()) as DriveItemRef;
          }
          const text = await res.text();
          if (res.status >= 500) throw new Error(`Chunk upload HTTP ${res.status}: ${text}`);
          throw new AbortRetryError(`Chunk upload HTTP ${res.status}: ${text}`);
        },
        { retries: 3, minTimeoutMs: 500, factor: 2 },
      );

      offset = end;
    }
    return lastResponse as DriveItemRef;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for unit tests.
// ---------------------------------------------------------------------------

export function splitExtension(filename: string): { name: string; ext: string } {
  const i = filename.lastIndexOf('.');
  if (i <= 0) return { name: filename, ext: '' };
  return { name: filename.slice(0, i), ext: filename.slice(i) };
}

function isConflictError(err: unknown): boolean {
  return graphStatus(err) === 409;
}

function isNotFoundError(err: unknown): boolean {
  return graphStatus(err) === 404;
}

function isRetryableError(err: unknown): boolean {
  const status = graphStatus(err);
  if (status === undefined) return true; // network blip
  return status === 429 || (status >= 500 && status < 600);
}

function graphStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const candidate = (err as { statusCode?: number; status?: number }).statusCode ??
      (err as { statusCode?: number; status?: number }).status;
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}
