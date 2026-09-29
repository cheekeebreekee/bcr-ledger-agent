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
  /**
   * Digits-only NIP. Empty string if none. Confirms the row's client account
   * (its UPN is `{nip}@bcr-group.pl`, `clientAccountVerdict`); never used to
   * find a row.
   */
  readonly nip: string;
  /** Company-name variants (already parsed from the multi-line SharePoint field). */
  readonly companyNameAliases: readonly string[];
  /**
   * The client's `{NIP}@` Member account id: the one id that routes for the
   * row; any other id never routes (a guest is refused, a Member who is not
   * the row's `{NIP}@bcr-group.pl` account is quarantined as
   * `not_client_account`). Written only by the binding tool. Parsed from the
   * multi-line `UserAadObjectIds` SharePoint column. One id per line.
   */
  readonly userAadObjectIds: readonly string[];
  /** Where documents for this client are filed. */
  readonly target: SharePointTarget;
  /**
   * Team (M365 group) id from the `TeamId` column, when recorded. Written by
   * the binding tool together with RootFolder and DriveId; a client row
   * without it routes nobody (`unbound_target`), and two rows sharing it are a
   * target conflict. An upload routes only when this is the uploader's one
   * and only Team (`membership_mismatch` otherwise). Logged with the routing
   * decision and `document.filed`.
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
 * space. Quarantine is for Members only: a guest, a non-Member, a deleted
 * user or an unreadable account is refused ({@link RefusalReason}) and
 * nothing is stored for it. Every case where a Member cannot be tied to
 * exactly one client ends here — never in BCR GROUP, never in "the client
 * whose NIP is in the document".
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
 *  - `not_client_account`: a Member bound on the row who is not its client
 *    account: their `userPrincipalName` is not `{row NIP}@bcr-group.pl`
 *    (staff bound by mistake, another client's account), or the row has no
 *    valid 10-digit NIP. Checked before the Teams read.
 *  - `membership_mismatch`: the uploader's Teams, read from Entra at upload
 *    time, are not exactly the row's `TeamId`: they are not in that Team, or
 *    they are also in another one. A client account added to a second
 *    client's Team after being bound would otherwise file that client's
 *    documents into the first client's space.
 *  - `membership_unverified`: the uploader's Teams could not be read (no
 *    grant, not yet in the token, the user gone, Graph down after retries),
 *    so the row's Team cannot be shown to be their only one.
 */
export type QuarantineReason =
  | 'unmapped'
  | 'staff'
  | 'conflict'
  | 'stale_directory'
  | 'forbidden_target'
  | 'target_unwritable'
  | 'unbound_target'
  | 'membership_mismatch'
  | 'membership_unverified'
  | 'not_client_account';

/**
 * Why nothing was done for a request: not a client account. Nothing is
 * stored, classified, indexed or searched for these, and they are never a
 * quarantine reason.
 *
 *  - `no_identity`: no user id, or not a GUID (validation already refuses it).
 *  - `identity_unverified`: the account could not be read from Entra (the bot
 *    path answers `RetryLater`, search `unavailable`).
 *  - `unknown_user`: Entra has no such user (deleted).
 *  - `guest`: an Entra Guest — bound on a row or not, of any Team. Guests have
 *    no capability in the ledger.
 *  - `not_member`: a `userType` that is neither Member nor Guest (or none).
 */
export type RefusalReason =
  | 'no_identity'
  | 'identity_unverified'
  | 'unknown_user'
  | 'guest'
  | 'not_member';

/** The uploader is the client account of exactly one active client row. */
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

/** The request comes from no client account: refused, with nothing stored and no target. */
export interface RefusedResolution {
  readonly source: 'refused';
  readonly reason: RefusalReason;
}

/**
 * The outcome of resolving an ingestion request. The client comes from the
 * authenticated uploader identity only — document content can never select or
 * change it. A request that is not from a Member is refused before the
 * Directory is consulted.
 */
export type ResolvedClient = DirectoryClientResolution | QuarantineResolution | RefusedResolution;
