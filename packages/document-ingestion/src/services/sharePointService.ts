import { RetryHandlerOptions, type Client } from '@microsoft/microsoft-graph-client';
import {
  createLogger,
  SharePointError,
  ValidationError,
  type DriveItemRef,
  type Logger,
  type ResolvedSharePointTarget,
  type SharePointTarget,
} from '@bcr/shared';
import {
  encodeGraphPath,
  joinFolderPath,
  sanitizeFilename,
  sanitizeFolderPath,
} from '../utils/pathBuilder';
import { retry, AbortRetryError, type RetryOptions } from '../utils/retry';

/**
 * Cut-off for using a simple PUT vs. an upload session. The Graph docs
 * recommend ≤ 4 MiB for `PUT /content`.
 */
const SIMPLE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

/** 320 KiB-aligned chunk size for upload sessions (Graph requirement). */
const CHUNK_SIZE_BYTES = 5 * 320 * 1024; // ~1.5 MiB

/** Name attempts per upload: the original, then `_1` … `_10`. */
const MAX_NAME_SUFFIX = 10;

const DEFAULT_RETRY: RetryOptions = { retries: 3, minTimeoutMs: 250, factor: 2 };

export interface UploadDocumentArgs {
  readonly folderPath: string;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/**
 * A target that cannot be used, as opposed to a transient write failure.
 * The ingestion pipeline sends the document to quarantine instead:
 *
 *  - `drive_mismatch`: the path now resolves to a different drive than the
 *    one recorded for the client (a recreated Team can take the same URL).
 *  - `forbidden_site`: the path resolves to a site nothing may be filed to
 *    (BCR GROUP, or the quarantine for a client target). An incident
 *    indicator, not a grant problem — it is logged as
 *    `sharepoint.forbidden_site` and quarantined as `forbidden_target`.
 *  - `forbidden`: Graph refused access (401/403) — a missing or
 *    not-yet-propagated grant.
 *  - `site_not_found` / `drive_not_found`: the site or drive is gone.
 */
export class SharePointTargetError extends SharePointError {
  constructor(
    public readonly kind:
      | 'drive_mismatch'
      | 'site_not_found'
      | 'drive_not_found'
      | 'forbidden'
      | 'forbidden_site',
    message: string,
    cause?: unknown,
  ) {
    super(
      message,
      kind === 'forbidden' || kind === 'forbidden_site'
        ? 403
        : kind === 'drive_mismatch'
          ? 409
          : 404,
      cause,
    );
  }
}

/** Resolves the Graph id of a site nothing may be filed to. May reject. */
export type SiteIdLookup = () => Promise<string>;

export interface SharePointServiceOptions {
  /** Retry policy for transient Graph failures. Injected short in tests. */
  readonly retry?: RetryOptions;
  /**
   * Graph site ids (`host,siteCollectionGuid,webGuid`, or the GUID alone)
   * nothing may be written to: BCR GROUP. Checked on the RESOLVED site's
   * collection, so no spelling of a Directory path — and no subweb — can
   * reach them. An id that is not in one of those forms is refused at
   * construction: a guard that can never match would guard nothing.
   */
  readonly forbiddenSiteIds?: readonly string[];
  /**
   * Further forbidden sites whose ids are looked up rather than configured:
   * the quarantine, for client targets. A lookup that fails refuses the
   * target (fail closed) — it can't be shown not to be the forbidden site.
   */
  readonly forbiddenSiteLookups?: readonly SiteIdLookup[];
  /** Injected in tests; defaults to global `fetch` (upload-session chunks). */
  readonly fetch?: typeof fetch;
  /** Injected in tests; defaults to the `ingestion/sharePointService` logger. */
  readonly log?: Logger;
}

/**
 * Thin SharePoint façade over Microsoft Graph. Exposes only the operations
 * the ingestion API actually needs:
 *
 *  - resolve site + drive ids (cached), refusing a forbidden site and
 *    checking the recorded drive id
 *  - ensure a folder hierarchy exists
 *  - upload a file without ever overwriting (`conflictBehavior=fail`), taking
 *    the next free `_n` name on a 409 — no existence probes, so no race and
 *    no oracle telling a caller which names already exist
 *  - set list-item columns on an uploaded file (quarantine metadata)
 *
 * Accepted trade-off: a PUT that SharePoint committed but whose response was
 * lost (a network failure, or a 500/502/503/504 after the write) is retried,
 * the retry gets 409, and the file is stored again under the next `_n` name
 * — in the same client folder. Checking the
 * first name would be an existence probe, so instead the upload is logged as
 * `sharepoint.possible_duplicate` (ids only) for staff to de-duplicate.
 */
export class SharePointService {
  private readonly log: Logger;
  private readonly retryOptions: RetryOptions;
  private readonly fetchFn: typeof fetch;
  private readonly forbiddenSiteKeys: ReadonlySet<string>;
  private readonly forbiddenSiteLookups: readonly SiteIdLookup[];
  private resolvedTarget: Promise<ResolvedSharePointTarget> | undefined;

  constructor(
    private readonly graph: Client,
    private readonly target: SharePointTarget,
    opts: SharePointServiceOptions = {},
  ) {
    this.log = opts.log ?? createLogger('ingestion/sharePointService');
    this.retryOptions = opts.retry ?? DEFAULT_RETRY;
    this.fetchFn = opts.fetch ?? fetch;
    this.forbiddenSiteKeys = forbiddenSiteKeys(opts.forbiddenSiteIds ?? []);
    this.forbiddenSiteLookups = opts.forbiddenSiteLookups ?? [];
  }

  async uploadDocument(args: UploadDocumentArgs): Promise<DriveItemRef> {
    const target = await this.getResolvedTarget();
    const cleanFolder = sanitizeFolderPath(joinFolderPath(target.rootFolder, args.folderPath));
    const cleanFilename = sanitizeFilename(args.filename);
    const { name, ext } = splitExtension(cleanFilename);

    await this.ensureFolderPath(target.driveId, cleanFolder);

    // Set once a name is found taken right after a network failure on it:
    // that earlier attempt may have been stored after all.
    let mayBeStoredAlready = false;
    for (let n = 0; n <= MAX_NAME_SUFFIX; n++) {
      const candidate = n === 0 ? cleanFilename : `${name}_${n}${ext}`;
      const encodedPath = encodeGraphPath(`${cleanFolder}/${candidate}`);
      const outcome =
        args.content.length <= SIMPLE_UPLOAD_LIMIT_BYTES
          ? await this.simpleUpload(target.driveId, encodedPath, args.content, args.contentType)
          : await this.chunkedUpload(target.driveId, encodedPath, args.content);
      if (isNameTaken(outcome)) {
        mayBeStoredAlready ||= outcome.afterUncertainFailure;
        continue;
      }
      this.assertSameDrive(outcome, target.driveId);
      this.log.info(
        { driveItemId: outcome.id, sizeBytes: args.content.length, nameSuffix: n },
        'uploaded to SharePoint',
      );
      if (mayBeStoredAlready) {
        this.log.warn(
          { event: 'sharepoint.possible_duplicate', driveItemId: outcome.id, nameSuffix: n },
          'sharepoint.possible_duplicate',
        );
      }
      return outcome;
    }
    throw new SharePointError('Too many filename collisions', 409);
  }

  /**
   * Set list-item columns on an uploaded file, e.g. the quarantine columns
   * `UploaderOid` / `QuarantineReason`. Best-effort: the upload already
   * happened, and the same facts are in the audit log event.
   */
  async setListItemFields(
    driveItemId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const target = await this.getResolvedTarget();
    try {
      await this.withRetry(
        () =>
          this.graph
            .api(`/drives/${target.driveId}/items/${driveItemId}/listItem/fields`)
            .patch(fields) as Promise<unknown>,
      );
      return true;
    } catch (err) {
      this.log.warn(
        { err: describeGraphError(err), driveItemId },
        'setting list-item fields failed',
      );
      return false;
    }
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
    const sitePath = encodeGraphPath(this.target.sitePath);
    let site: { id: string };
    try {
      site = (await this.withRetry(() =>
        this.graph.api(`/sites/${this.target.siteHostname}:/${sitePath}`).get(),
      )) as { id: string };
    } catch (err) {
      throw classifyTargetError(err, 'site_not_found', 'Site could not be resolved');
    }
    await this.assertSiteAllowed(site.id);
    let drives: { value: { id: string; name: string }[] };
    try {
      drives = (await this.withRetry(() =>
        this.graph.api(`/sites/${site.id}/drives`).get(),
      )) as typeof drives;
    } catch (err) {
      throw classifyTargetError(err, 'drive_not_found', 'Drives could not be listed');
    }
    const drive = drives.value.find((d) => d.name === this.target.driveName);
    if (!drive) {
      throw new SharePointTargetError('drive_not_found', 'Drive not found on the target site');
    }
    if (this.target.expectedDriveId && drive.id !== this.target.expectedDriveId) {
      throw new SharePointTargetError(
        'drive_mismatch',
        'The target path resolves to a different drive than the one recorded for this client',
      );
    }
    return { ...this.target, siteId: site.id, driveId: drive.id };
  }

  /**
   * Refuse a resolved site in a forbidden site collection, before anything
   * is listed or written there. Anything that cannot be compared — a site id
   * in an unexpected form, a forbidden site that cannot be looked up — is
   * refused too: the guard fails closed.
   */
  private async assertSiteAllowed(siteId: string): Promise<void> {
    if (this.forbiddenSiteKeys.size === 0 && this.forbiddenSiteLookups.length === 0) return;
    const key = siteCollectionKey(siteId);
    if (!key) throw new SharePointError('The resolved site id could not be checked', 502);
    if (this.forbiddenSiteKeys.has(key)) throw this.forbiddenSite(key);
    for (const lookup of this.forbiddenSiteLookups) {
      let forbiddenId: string;
      try {
        forbiddenId = await lookup();
      } catch (err) {
        throw new SharePointError('A forbidden site could not be looked up', 502, err);
      }
      const forbiddenKey = siteCollectionKey(forbiddenId);
      if (!forbiddenKey) throw new SharePointError('A forbidden site id could not be checked', 502);
      if (forbiddenKey === key) throw this.forbiddenSite(key);
    }
  }

  private forbiddenSite(siteCollectionId: string): SharePointTargetError {
    // Ids only: the collection GUID says which guarded site it was, and the
    // pipeline's own line carries the client and Directory row.
    this.log.error(
      { event: 'sharepoint.forbidden_site', siteCollectionId },
      'sharepoint.forbidden_site',
    );
    return new SharePointTargetError(
      'forbidden_site',
      'The target resolves to a site nothing may be filed to',
    );
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
        await this.withRetry(() =>
          this.graph.api(`/drives/${driveId}/items/${parent}/children`).post({
            name: segment,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'fail',
          }),
        );
      } catch (err) {
        if (graphStatus(err) === 403) {
          throw new SharePointTargetError('forbidden', 'No write access to the target drive', err);
        }
        if (graphStatus(err) !== 409) {
          throw new SharePointError('Failed to create a folder', 502, err);
        }
      }
      // Re-fetch parent id (whether we created it or it already existed).
      let item: { id: string };
      try {
        item = (await this.withRetry(() =>
          this.graph
            .api(`/drives/${driveId}/items/${parent}:/${encodeURIComponent(segment)}`)
            .get(),
        )) as { id: string };
      } catch (err) {
        if (graphStatus(err) === 403) {
          throw new SharePointTargetError('forbidden', 'No access to the target drive', err);
        }
        throw new SharePointError('Failed to read a folder', 502, err);
      }
      parent = item.id;
    }
  }

  /** PUT that never overwrites. */
  private async simpleUpload(
    driveId: string,
    encodedPath: string,
    content: Buffer,
    contentType: string,
  ): Promise<DriveItemRef | NameTaken> {
    // The SDK's own retries are switched off for this PUT: a retry it made
    // after a 503/504 that SharePoint had in fact committed would come back
    // as 409 with nothing telling us the first try may be stored. Every
    // retry is ours, so every uncertain failure is recorded.
    let uncertainFailure = false;
    try {
      return await retry(async () => {
        try {
          return (await this.graph
            .api(`/drives/${driveId}/root:/${encodedPath}:/content`)
            .query({ '@microsoft.graph.conflictBehavior': 'fail' })
            .header('Content-Type', contentType)
            .middlewareOptions([new RetryHandlerOptions(0, 0)])
            .put(content)) as DriveItemRef;
        } catch (err) {
          if (mayHaveCommitted(err)) uncertainFailure = true;
          if (isRetryableError(err, { sdkRetries: false })) throw err;
          throw new StatusAbort(err);
        }
      }, this.retryOptions);
    } catch (err) {
      const cause = err instanceof StatusAbort ? err.original : err;
      if (graphStatus(cause) === 409) {
        return { nameTaken: true, afterUncertainFailure: uncertainFailure };
      }
      if (graphStatus(cause) === 403) {
        throw new SharePointTargetError('forbidden', 'No write access to the target drive', cause);
      }
      throw new SharePointError('Upload failed', 502, cause);
    }
  }

  /** Upload session that never overwrites. */
  private async chunkedUpload(
    driveId: string,
    encodedPath: string,
    content: Buffer,
  ): Promise<DriveItemRef | NameTaken> {
    let session: { uploadUrl: string };
    try {
      session = (await this.withRetry(() =>
        this.graph
          .api(`/drives/${driveId}/root:/${encodedPath}:/createUploadSession`)
          .post({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
      )) as { uploadUrl: string };
    } catch (err) {
      // Creating a session stores nothing, so a 409 here is someone else's file.
      if (graphStatus(err) === 409) return { nameTaken: true, afterUncertainFailure: false };
      if (graphStatus(err) === 403) {
        throw new SharePointTargetError('forbidden', 'No write access to the target drive', err);
      }
      throw new SharePointError('Upload session could not be created', 502, err);
    }

    let offset = 0;
    let lastResponse: unknown;
    while (offset < content.length) {
      const end = Math.min(offset + CHUNK_SIZE_BYTES, content.length);
      const chunk = content.subarray(offset, end);
      const rangeHeader = `bytes ${offset}-${end - 1}/${content.length}`;

      let chunkUncertain = false;
      let outcome: unknown;
      try {
        outcome = await retry(async () => {
          let res: Response;
          try {
            res = await this.fetchFn(session.uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Length': String(chunk.length), 'Content-Range': rangeHeader },
              body: chunk,
            });
          } catch (err) {
            chunkUncertain = true;
            throw err;
          }
          if (res.status === 202 || res.status === 200 || res.status === 201) {
            return (await res.json()) as unknown;
          }
          // A name taken while the session was open is reported on the last chunk.
          if (res.status === 409) return 'conflict' as const;
          // No SDK middleware on this raw fetch: its throttling is ours to retry.
          if (res.status >= 500 || res.status === 429) {
            if (res.status >= 500) chunkUncertain = true;
            throw new Error(`Chunk upload HTTP ${res.status}`);
          }
          throw new AbortRetryError(`Chunk upload HTTP ${res.status}`);
        }, this.retryOptions);
      } catch (err) {
        // After retries, like the simple PUT: a SharePointError, which the
        // pipeline turns into a quarantine, never a bare rejection.
        throw new SharePointError('Upload failed', 502, err);
      }

      if (outcome === 'conflict') {
        return { nameTaken: true, afterUncertainFailure: chunkUncertain };
      }
      lastResponse = outcome;
      offset = end;
    }
    return lastResponse as DriveItemRef;
  }

  private withRetry<T>(call: () => Promise<T>): Promise<T> {
    return withGraphRetry(call, this.retryOptions);
  }

  /**
   * The item must be in the drive we addressed. Anything else means the
   * write went somewhere we did not intend; stop and say so loudly.
   */
  private assertSameDrive(item: DriveItemRef, driveId: string): void {
    const actual = item.parentReference?.driveId;
    if (actual && actual !== driveId) {
      this.log.error(
        { event: 'sharepoint.drive_mismatch', driveItemId: item.id },
        'uploaded item is not in the addressed drive',
      );
      throw new SharePointTargetError(
        'drive_mismatch',
        'Uploaded item landed in an unexpected drive',
      );
    }
  }
}

/**
 * A lookup of one site's Graph id (`GET /sites/{host}:/{path}`), for
 * {@link SharePointServiceOptions.forbiddenSiteLookups}. The first success is
 * kept for the life of the process; a failure is not, so the next upload asks
 * again — and is refused meanwhile.
 */
export function cachedSiteIdLookup(
  graph: Client,
  site: Pick<SharePointTarget, 'siteHostname' | 'sitePath'>,
  opts: { readonly retry?: RetryOptions } = {},
): SiteIdLookup {
  const path = `/sites/${site.siteHostname}:/${encodeGraphPath(site.sitePath)}`;
  let pending: Promise<string> | undefined;
  return () => {
    if (!pending) {
      const get = () => graph.api(path).get() as Promise<{ id: string }>;
      pending = withGraphRetry(get, opts.retry ?? DEFAULT_RETRY)
        .then((found) => found.id)
        .catch((err: unknown) => {
          pending = undefined;
          throw err;
        });
    }
    return pending;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for unit tests.
// ---------------------------------------------------------------------------

export function splitExtension(filename: string): { name: string; ext: string } {
  const i = filename.lastIndexOf('.');
  if (i <= 0) return { name: filename, ext: '' };
  return { name: filename.slice(0, i), ext: filename.slice(i) };
}

/** The name is taken. `afterUncertainFailure`: an earlier try at it may have been stored. */
interface NameTaken {
  readonly nameTaken: true;
  readonly afterUncertainFailure: boolean;
}

function isNameTaken(outcome: DriveItemRef | NameTaken): outcome is NameTaken {
  return 'nameTaken' in outcome;
}

/** Wraps a non-retryable Graph error so `retry` stops but the status survives. */
class StatusAbort extends AbortRetryError {
  constructor(public readonly original: unknown) {
    super('non-retryable Graph error');
  }
}

/**
 * Retry a Graph SDK call on network failures, 500 and 502 only; any other
 * error stops at once with its status intact (see {@link StatusAbort}).
 */
async function withGraphRetry<T>(call: () => Promise<T>, opts: RetryOptions): Promise<T> {
  try {
    return await retry(async () => {
      try {
        return await call();
      } catch (err) {
        if (isRetryableError(err)) throw err;
        throw new StatusAbort(err);
      }
    }, opts);
  } catch (err) {
    throw err instanceof StatusAbort ? err.original : err;
  }
}

function classifyTargetError(
  err: unknown,
  notFoundKind: 'site_not_found' | 'drive_not_found',
  message: string,
): SharePointError {
  const status = graphStatus(err);
  if (status === 403 || status === 401) return new SharePointTargetError('forbidden', message, err);
  if (status === 404) return new SharePointTargetError(notFoundKind, message, err);
  return new SharePointError(message, 502, err);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The site-collection GUID (lower-case) of a Graph site id
 * (`hostname,siteCollectionGuid,webGuid`) or of a bare GUID; `null` for
 * anything else — Graph's path form `host:/sites/X:` or a two-part id would
 * never equal a resolved site's collection, so they are not guessed at.
 */
export function siteCollectionKey(id: string): string | null {
  const parts = id.trim().toLowerCase().split(',');
  const guid = parts.length === 3 ? parts[1] : parts.length === 1 ? parts[0] : undefined;
  return guid && GUID.test(guid) ? guid : null;
}

/** The collection keys of the configured forbidden sites; refuses any it can't read. */
export function forbiddenSiteKeys(ids: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const id of ids) {
    const key = siteCollectionKey(id);
    if (!key) {
      throw new ValidationError(
        'A forbidden site id is not a Graph site id (host,siteGuid,webGuid)',
      );
    }
    keys.add(key);
  }
  return keys;
}

/** A failed write whose request may still have been committed by SharePoint. */
function mayHaveCommitted(err: unknown): boolean {
  const status = graphStatus(err);
  return isNetworkFailure(err) || status === 500 || status === 502 || status === 503 || status === 504;
}

/** The Graph SDK reports a failed fetch (reset, DNS, timeout) as statusCode -1. */
function isNetworkFailure(err: unknown): boolean {
  const status = graphStatus(err);
  return status === undefined || status <= 0;
}

/**
 * Whether an app-level retry is worth it. The Graph SDK's RetryHandler
 * already retries 429, 503 and 504 (up to three times, honouring
 * Retry-After), so repeating those here multiplied a brownout past the
 * Functions HTTP limit. Only failures the SDK does not retry are ours:
 * network failures, 500 and 502 — plus 429/503/504 on a request whose SDK
 * retries are off or do not apply (`sdkRetries: false`: the content PUT).
 */
function isRetryableError(
  err: unknown,
  opts: { readonly sdkRetries: boolean } = { sdkRetries: true },
): boolean {
  if (isNetworkFailure(err)) return true;
  const status = graphStatus(err);
  if (status === 500 || status === 502) return true;
  return !opts.sdkRetries && (status === 429 || status === 503 || status === 504);
}

export function graphStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const candidate =
      (err as { statusCode?: number; status?: number }).statusCode ??
      (err as { statusCode?: number; status?: number }).status;
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

/** Status and Graph error code only — never the request URL (it contains paths). */
function describeGraphError(err: unknown): {
  status: number | undefined;
  code: string | undefined;
} {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return { status: graphStatus(err), code: typeof code === 'string' ? code : undefined };
}
