/**
 * Types describing the multi-tenant Client Directory (see
 * `docs/client-directory-admin-guide.md` and `ARCHITECTURE.md §4.2`).
 *
 * The directory is a SharePoint list read at runtime by the ingestion
 * function to decide **whose** SharePoint space a document belongs in.
 * Every "client" the agent files documents for has exactly one row here.
 */

import type { SharePointTarget } from './sharepoint';

/**
 * One normalized row from the `Client Directory` SharePoint list. Field
 * names mirror the list's SharePoint column internal names (PascalCase)
 * except that `Status` is exposed as a boolean `active` for convenience.
 */
export interface ClientDirectoryEntry {
  /** SharePoint list item id (numeric string). Useful for logging only. */
  readonly listItemId: string;
  /** Canonical display name (`Title` column), e.g. `[0002] PESKOVOI Sp. z o.o. - Księgowość`. */
  readonly title: string;
  /** Short stable business key, e.g. `0002`. */
  readonly clientId: string;
  /** Digits-only NIP. Empty string if none. */
  readonly nip: string;
  /** Company-name variants (already parsed from the multi-line SharePoint field). */
  readonly companyNameAliases: readonly string[];
  /**
   * AAD object ids of users who are allowed to file documents for this
   * client via 1:1 DMs with the bot. Parsed from the multi-line
   * `UserAadObjectIds` SharePoint column. One id per line.
   */
  readonly userAadObjectIds: readonly string[];
  /** Where documents for this client are filed. */
  readonly target: SharePointTarget;
  /**
   * Team (M365 group) id from the `TeamId` column, when recorded. Written by
   * the binding tool together with RootFolder and DriveId; a client row
   * without it routes nobody (`unbound_target`), and two rows sharing it are a
   * target conflict. Logged with the routing decision and `document.filed`.
   */
  readonly teamId?: string;
  /**
   * True for BCR staff rows. A staff member's uploads are held in quarantine;
   * their ids must never appear on a client row.
   */
  readonly isAdmin: boolean;
  /** `Status == "Active"` — inactive rows are excluded from lookups. */
  readonly active: boolean;
}

/**
 * Why an upload was sent to the staff-only quarantine instead of a client's
 * space. Every case where the uploader cannot be tied to exactly one client
 * ends here — never in BCR GROUP, never in "the client whose NIP is in the
 * document".
 *
 *  - `unmapped`: the uploader's AAD id is on no active Directory row.
 *  - `staff`: the uploader is BCR staff (an `IsAdmin` row). Staff pick the
 *    client explicitly in a later phase; until then their uploads are held.
 *  - `conflict`: the uploader's id is on more than one row (two clients, or a
 *    client and an admin row), or their row shares a site, DriveId or TeamId
 *    with another row.
 *  - `stale_directory`: the Directory could not be read recently enough, or the
 *    row's drive no longer matches the drive id recorded for it.
 *  - `forbidden_target`: the row points at a site no client may be filed to
 *    (BCR GROUP, the quarantine itself, another SharePoint host, a path that
 *    is not exactly `/sites|teams/<name>`), or its path resolved in Graph to
 *    BCR GROUP's or the quarantine's site collection.
 *  - `target_unwritable`: the client's site could not be written (no grant,
 *    site or drive gone) after retries.
 *  - `unbound_target`: the uploader's one row lacks RootFolder, DriveId or
 *    TeamId — the binding tool, which writes all three together, has not
 *    bound it — so it routes nobody.
 */
export type QuarantineReason =
  | 'unmapped'
  | 'staff'
  | 'conflict'
  | 'stale_directory'
  | 'forbidden_target'
  | 'target_unwritable'
  | 'unbound_target';

/** The uploader is bound to exactly one active client row. */
export interface DirectoryClientResolution {
  readonly source: 'directory';
  /** Short business key, e.g. `0002`. Not unique in the live list — log `listItemId` too. */
  readonly clientId: string;
  /** SharePoint list item id of the matched row: the unambiguous row reference. */
  readonly listItemId: string;
  /** Human-readable label. Never logged or returned to callers. */
  readonly title: string;
  /** Routing is identity-only; there is no other way to match. */
  readonly matchedBy: 'userAadObjectId';
  /** Where to file the document. */
  readonly target: SharePointTarget;
  /** The row's Team (M365 group) id. An id, so it may be logged. */
  readonly teamId: string;
  /** The bound client's own NIP, used only to derive invoice direction. May be empty. */
  readonly nip: string;
  /** The bound client's name, used only to prime classification. May be empty. */
  readonly companyName: string;
}

/** The upload cannot be tied to exactly one client; it goes to the staff quarantine. */
export interface QuarantineResolution {
  readonly source: 'quarantine';
  readonly reason: QuarantineReason;
  /** The quarantine site (never a client site). */
  readonly target: SharePointTarget;
}

/**
 * The outcome of resolving an ingestion request. The client comes from the
 * authenticated uploader identity only — document content can never select or
 * change it.
 */
export type ResolvedClient = DirectoryClientResolution | QuarantineResolution;
