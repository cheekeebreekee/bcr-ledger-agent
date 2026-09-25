import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointTarget } from '@bcr/shared';
import { SharePointService, type SharePointServiceOptions } from './sharePointService';

/**
 * Caches one `SharePointService` per unique target so we amortize the
 * cold-start site/drive resolution across many uploads. Necessary now
 * that a single Function App worker files documents for many clients
 * (multi-tenant routing, ARCHITECTURE.md \u00a74.2).
 *
 * Cache key uses hostname + path + drive + optional root folder so two
 * identical `SharePointTarget` objects (from separate Directory rows or
 * config) share the same underlying service instance.
 */
export class SharePointServiceFactory {
  private readonly cache = new Map<string, SharePointService>();

  constructor(
    private readonly graph: Client,
    private readonly serviceOptions: SharePointServiceOptions = {},
  ) {}

  forTarget(target: SharePointTarget): SharePointService {
    const key = cacheKey(target);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const service = new SharePointService(this.graph, target, this.serviceOptions);
    this.cache.set(key, service);
    return service;
  }

  /** For tests. */
  size(): number {
    return this.cache.size;
  }
}

function cacheKey(t: SharePointTarget): string {
  // sitePath is case-sensitive in SharePoint URLs but SharePoint itself
  // treats hostnames as case-insensitive. Normalize hostname only so we
  // don't accidentally split a case-varied write across two instances.
  // expectedDriveId is part of the key: two rows naming the same path but
  // pinned to different drives must not share a resolved drive id.
  return [
    t.siteHostname.toLowerCase(),
    t.sitePath,
    t.driveName,
    t.rootFolder ?? '',
    t.expectedDriveId ?? '',
  ].join('|');
}
