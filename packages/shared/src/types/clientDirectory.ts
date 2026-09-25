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
  /** Person full names (already parsed from the multi-line SharePoint field). */
  readonly personNames: readonly string[];
  /**
   * AAD object ids of users who are allowed to file documents for this
   * client via 1:1 DMs with the bot. Parsed from the multi-line
   * `UserAadObjectIds` SharePoint column. One id per line.
   */
  readonly userAadObjectIds: readonly string[];
  /** Where documents for this client are filed. */
  readonly target: SharePointTarget;
  /** True for BCR staff / admin rows (content-based routing applies). */
  readonly isAdmin: boolean;
  /** `Status == "Active"` — inactive rows are excluded from lookups. */
  readonly active: boolean;
}

/**
 * The outcome of resolving an incoming ingestion request to a client.
 * Either a real Client Directory row matched, or we fell back to the
 * configured fallback bucket (BCR Group).
 */
export interface ResolvedClient {
  /** Short business key. Matches `ClientDirectoryEntry.clientId` when `source === 'directory'`. */
  readonly clientId: string;
  /** Human-readable label for logs. */
  readonly title: string;
  /** Which mechanism resolved this request. */
  readonly source: 'directory' | 'fallback';
  /** How the directory match was made (only meaningful when `source === 'directory'`). */
  readonly matchedBy?: 'userAadObjectId' | 'nip' | 'companyName' | 'personName';
  /** Where to file the document. */
  readonly target: SharePointTarget;
  /** Client tax id (for downstream direction detection). May be empty. */
  readonly nip: string;
  /** Canonical company name (for downstream direction detection). May be empty. */
  readonly companyName: string;
}
