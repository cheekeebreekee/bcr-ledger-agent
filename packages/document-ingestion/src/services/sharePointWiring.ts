import type { Client } from '@microsoft/microsoft-graph-client';
import type { IngestionConfig, SharePointTarget } from '@bcr/shared';
import { SharePointServiceFactory } from './sharePointServiceFactory';
import { cachedSiteIdLookup } from './sharePointService';

export type SharePointWiringConfig = Pick<
  IngestionConfig,
  | 'clientDirectorySiteId'
  | 'quarantineSiteHostname'
  | 'quarantineSitePath'
  | 'quarantineDriveName'
  | 'quarantineRootFolder'
>;

export interface SharePointWiring {
  readonly quarantineTarget: SharePointTarget;
  /** BCR GROUP's site id: nothing, client or quarantine, is written there. */
  readonly bcrGroupSiteIds: readonly string[];
  /**
   * Client targets: refused when the RESOLVED site is BCR GROUP's collection
   * or the quarantine's, whatever spelling the row's path used. The
   * quarantine's id is looked up on first use and kept; while it can't be
   * looked up, client targets are refused (their documents go to quarantine).
   */
  readonly clientSharePointFactory: SharePointServiceFactory;
  /** The quarantine target alone: guarded against BCR GROUP, not against itself. */
  readonly quarantineSharePointFactory: SharePointServiceFactory;
}

/**
 * The two SharePoint factories and what each refuses. Kept out of runtime.ts
 * (which is cold-start wiring, excluded from coverage) so that swapping the
 * factories or dropping a guard fails a test instead of silently filing a
 * client's document into the quarantine or BCR GROUP.
 */
export function createSharePointWiring(
  graph: Client,
  config: SharePointWiringConfig,
): SharePointWiring {
  const quarantineTarget: SharePointTarget = {
    siteHostname: config.quarantineSiteHostname,
    sitePath: config.quarantineSitePath,
    driveName: config.quarantineDriveName,
    ...(config.quarantineRootFolder ? { rootFolder: config.quarantineRootFolder } : {}),
  };
  // The Client Directory lives on the BCR GROUP site, so its site id is BCR
  // GROUP's: whatever a Directory row's path says, nothing is ever written there.
  const bcrGroupSiteIds = [config.clientDirectorySiteId];
  return {
    quarantineTarget,
    bcrGroupSiteIds,
    clientSharePointFactory: new SharePointServiceFactory(graph, {
      forbiddenSiteIds: bcrGroupSiteIds,
      forbiddenSiteLookups: [cachedSiteIdLookup(graph, quarantineTarget)],
    }),
    quarantineSharePointFactory: new SharePointServiceFactory(graph, {
      forbiddenSiteIds: bcrGroupSiteIds,
    }),
  };
}
