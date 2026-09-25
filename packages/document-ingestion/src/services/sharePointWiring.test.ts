import type { Client } from '@microsoft/microsoft-graph-client';
import type { SharePointTarget } from '@bcr/shared';
import { createSharePointWiring, type SharePointWiringConfig } from './sharePointWiring';

const HOST = 'contoso.sharepoint.com';
const siteId = (collection: string) => `${HOST},${collection},99999999-9999-9999-9999-999999999999`;
const BCR_GROUP = '11111111-1111-1111-1111-111111111111';
const QUARANTINE = '22222222-2222-2222-2222-222222222222';
const CLIENT_A = '33333333-3333-3333-3333-333333333333';

/** Which collection each site path resolves to in the fake tenant. */
const SITES: Record<string, string> = {
  '/sites/ClientA': CLIENT_A,
  '/sites/Kwarantanna': QUARANTINE,
  // Paths a Directory row could carry that Graph resolves elsewhere.
  '/sites/LooksLikeAClient': QUARANTINE,
  '/sites/AlsoLooksLikeAClient': BCR_GROUP,
};

function fakeTenant(): { client: Client; puts: string[] } {
  const puts: string[] = [];
  const api = (path: string) => {
    const request = {
      query: () => request,
      header: () => request,
      middlewareOptions: () => request,
      get: async () => {
        const site = /^\/sites\/[^:]+:(\/sites\/[^/]+)$/.exec(path);
        if (site) {
          const collection = SITES[site[1] ?? ''];
          if (!collection) throw Object.assign(new Error('not found'), { statusCode: 404 });
          return { id: siteId(collection) };
        }
        const drives = /^\/sites\/[^,]+,([^,]+),[^/]+\/drives$/.exec(path);
        if (drives) return { value: [{ id: `drive-${drives[1] ?? ''}`, name: 'Dokumenty' }] };
        return { id: `folder:${path}` };
      },
      post: async () => ({}),
      put: async () => {
        puts.push(path);
        return {
          id: 'item',
          name: 'f.pdf',
          webUrl: 'u',
          parentReference: { driveId: path.split('/')[2] },
        };
      },
      patch: async () => ({}),
    };
    return request;
  };
  return { client: { api } as unknown as Client, puts };
}

const config: SharePointWiringConfig = {
  clientDirectorySiteId: siteId(BCR_GROUP),
  quarantineSiteHostname: HOST,
  quarantineSitePath: '/sites/Kwarantanna',
  quarantineDriveName: 'Dokumenty',
  quarantineRootFolder: 'Kwarantanna',
};

const target = (sitePath: string): SharePointTarget => ({
  siteHostname: HOST,
  sitePath,
  driveName: 'Dokumenty',
});
const doc = {
  folderPath: '01_Faktury',
  filename: 'f.pdf',
  contentType: 'application/pdf',
  content: Buffer.from('x'),
};

describe('createSharePointWiring', () => {
  it('files a client document into the client site', async () => {
    const { client, puts } = fakeTenant();
    const { clientSharePointFactory } = createSharePointWiring(client, config);
    await expect(
      clientSharePointFactory.forTarget(target('/sites/ClientA')).uploadDocument(doc),
    ).resolves.toMatchObject({
      id: 'item',
    });
    expect(puts).toHaveLength(1);
  });

  it.each([
    ['the quarantine', '/sites/LooksLikeAClient'],
    ['BCR GROUP', '/sites/AlsoLooksLikeAClient'],
  ])(
    'refuses a client target that resolves to %s, before anything is written',
    async (_label, sitePath) => {
      const { client, puts } = fakeTenant();
      const { clientSharePointFactory } = createSharePointWiring(client, config);
      await expect(
        clientSharePointFactory.forTarget(target(sitePath)).uploadDocument(doc),
      ).rejects.toMatchObject({
        kind: 'forbidden_site',
      });
      expect(puts).toEqual([]);
    },
  );

  it('lets the quarantine factory write to the quarantine, which the client factory refuses', async () => {
    const { client, puts } = fakeTenant();
    const wiring = createSharePointWiring(client, config);
    await expect(
      wiring.clientSharePointFactory.forTarget(wiring.quarantineTarget).uploadDocument(doc),
    ).rejects.toMatchObject({ kind: 'forbidden_site' });
    await expect(
      wiring.quarantineSharePointFactory.forTarget(wiring.quarantineTarget).uploadDocument(doc),
    ).resolves.toMatchObject({ id: 'item' });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain('Kwarantanna');
  });

  it('refuses a quarantine that resolves to BCR GROUP', async () => {
    const { client, puts } = fakeTenant();
    const wiring = createSharePointWiring(client, {
      ...config,
      quarantineSitePath: '/sites/AlsoLooksLikeAClient',
    });
    await expect(
      wiring.quarantineSharePointFactory.forTarget(wiring.quarantineTarget).uploadDocument(doc),
    ).rejects.toMatchObject({ kind: 'forbidden_site' });
    expect(puts).toEqual([]);
  });

  it('builds the quarantine target from the settings, with its root folder only when set', () => {
    const { client } = fakeTenant();
    expect(createSharePointWiring(client, config).quarantineTarget).toEqual({
      siteHostname: HOST,
      sitePath: '/sites/Kwarantanna',
      driveName: 'Dokumenty',
      rootFolder: 'Kwarantanna',
    });
    expect(
      createSharePointWiring(client, { ...config, quarantineRootFolder: '' }).quarantineTarget,
    ).not.toHaveProperty('rootFolder');
  });
});
