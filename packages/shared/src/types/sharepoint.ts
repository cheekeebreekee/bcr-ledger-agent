/**
 * Identifies a target SharePoint site + drive ("Documents" library by default).
 * Resolved once during cold-start from configuration.
 */
export interface SharePointTarget {
  readonly siteHostname: string;
  readonly sitePath: string;
  readonly driveName: string;
  /** Optional sub-folder under the drive root that prefixes every upload. */
  readonly rootFolder?: string;
  /**
   * Drive id recorded for this target (Directory `DriveId` column). When set,
   * the drive resolved from `sitePath` + `driveName` must have exactly this id;
   * otherwise the path now points somewhere else (a deleted and recreated
   * Team can take the same URL) and nothing is written there.
   */
  readonly expectedDriveId?: string;
}

/**
 * Resolved Microsoft Graph identifiers for a SharePoint target. Cached
 * after the first lookup so we avoid hitting `/sites/{hostname}:/path`
 * on every request.
 */
export interface ResolvedSharePointTarget extends SharePointTarget {
  readonly siteId: string;
  readonly driveId: string;
}

/**
 * Minimal subset of the Microsoft Graph `driveItem` response.
 * Avoids pulling in `@microsoft/microsoft-graph-types` from the shared
 * package so consumers can choose their own dependency surface.
 */
export interface DriveItemRef {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly parentReference?: {
    readonly driveId: string;
    readonly path: string;
  };
  readonly size?: number;
}
