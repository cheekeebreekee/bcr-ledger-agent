import type { Client } from '@microsoft/microsoft-graph-client';
import { ValidationError } from '@bcr/shared';
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

  // A forbidden id that could never equal a resolved site's collection would
  // leave the BCR GROUP guard guarding nothing — refuse it at cold start.
  it.each([
    ["Graph's path form", 'contoso.sharepoint.com:/sites/BCRGROUP:'],
    ['a two-part id', 'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111'],
  ])('refuses at construction a forbidden site id in %s', (_label, id) => {
    expect(() => new SharePointServiceFactory(graph, { forbiddenSiteIds: [id] })).toThrow(ValidationError);
  });

  it('accepts a three-part forbidden site id', () => {
    const id =
      'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,' +
      '22222222-2222-2222-2222-222222222222';
    expect(() => new SharePointServiceFactory(graph, { forbiddenSiteIds: [id] })).not.toThrow();
  });
});
