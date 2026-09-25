import type { Client } from '@microsoft/microsoft-graph-client';
import { SharePointServiceFactory } from './sharePointServiceFactory';

const graph = { api: jest.fn() } as unknown as Client;

describe('SharePointServiceFactory', () => {
  it('returns the same instance for identical targets', () => {
    const factory = new SharePointServiceFactory(graph);
    const a = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
    });
    const b = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
    });
    expect(a).toBe(b);
    expect(factory.size()).toBe(1);
  });

  it('creates a new instance for a different site path', () => {
    const factory = new SharePointServiceFactory(graph);
    const a = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
    });
    const b = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/y',
      driveName: 'Documents',
    });
    expect(a).not.toBe(b);
    expect(factory.size()).toBe(2);
  });

  it('treats hostname as case-insensitive but path as case-sensitive', () => {
    const factory = new SharePointServiceFactory(graph);
    const a = factory.forTarget({
      siteHostname: 'Contoso.SharePoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
    });
    const b = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
    });
    const c = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/X',
      driveName: 'Documents',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('distinguishes on rootFolder', () => {
    const factory = new SharePointServiceFactory(graph);
    const a = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
    });
    const b = factory.forTarget({
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/x',
      driveName: 'Documents',
      rootFolder: 'BCR',
    });
    expect(a).not.toBe(b);
  });
});
