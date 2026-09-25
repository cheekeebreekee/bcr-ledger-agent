import type {
  Classification,
  ClientDirectoryEntry,
  DocumentParty,
  IngestionSource,
  SharePointTarget,
} from '@bcr/shared';
import type { ClientDirectoryReader, ClientDirectorySnapshot } from './clientDirectoryReader';
import { applyInvoiceDirection, ClientResolver } from './clientResolver';

const fallbackTarget: SharePointTarget = {
  siteHostname: 'contoso.sharepoint.com',
  sitePath: '/sites/BCRGROUP',
  driveName: 'Documents',
};

function makeEntry(overrides: Partial<ClientDirectoryEntry>): ClientDirectoryEntry {
  return {
    listItemId: '1',
    title: 'Client',
    clientId: '0001',
    nip: '',
    companyNameAliases: [],
    personNames: [],
    userAadObjectIds: [],
    target: {
      siteHostname: 'client.sharepoint.com',
      sitePath: '/sites/Client-0001',
      driveName: 'Dokumenty',
    },
    isAdmin: false,
    active: true,
    ...overrides,
  };
}

function makeReader(entries: ClientDirectoryEntry[]): ClientDirectoryReader {
  const byNip = new Map<string, ClientDirectoryEntry>();
  const byUserAadObjectId = new Map<string, ClientDirectoryEntry>();
  for (const e of entries) {
    if (e.nip) byNip.set(e.nip, e);
    for (const aad of e.userAadObjectIds) if (aad) byUserAadObjectId.set(aad, e);
  }
  const snapshot: ClientDirectorySnapshot = {
    entries,
    byNip,
    byCompanyAlias: new Map(),
    byPersonName: new Map(),
    byUserAadObjectId,
    fetchedAt: 0,
  };
  return { getSnapshot: jest.fn().mockResolvedValue(snapshot) } as unknown as ClientDirectoryReader;
}

const baseSource: IngestionSource = {
  tenantId: 'tenant-1',
  channelId: 'msteams',
  conversationId: 'conv-1',
  activityId: 'act-1',
  teamsChannelId: undefined,
  userAadObjectId: undefined,
  userDisplayName: undefined,
};

describe('ClientResolver.resolve', () => {
  const opts = { fallbackTarget, fallbackClientId: 'bcr-group', fallbackTitle: 'BCR Group' };

  it('routes to fallback when no user id is provided', async () => {
    const resolver = new ClientResolver(makeReader([]), opts);
    const resolved = await resolver.resolve(baseSource);
    expect(resolved.source).toBe('fallback');
    expect(resolved.clientId).toBe('bcr-group');
    expect(resolved.target).toBe(fallbackTarget);
    expect(resolved.matchedBy).toBeUndefined();
  });

  it('routes to fallback when the user id is not in the directory', async () => {
    const resolver = new ClientResolver(makeReader([]), opts);
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
    });
    expect(resolved.source).toBe('fallback');
  });

  it('routes to the mapped client via userAadObjectId (1:1 DM path)', async () => {
    const entry = makeEntry({
      clientId: '0002',
      title: '[0002] PESKOVOI',
      nip: '9571185285',
      companyNameAliases: ['PESKOVOI Sp. z o.o.'],
      userAadObjectIds: ['ae3987d3-9a3a-4ff8-bcf7-713d24e79c48'],
      target: {
        siteHostname: 'contoso.sharepoint.com',
        sitePath: '/sites/PESKOVOI',
        driveName: 'Dokumenty',
      },
    });
    const resolver = new ClientResolver(makeReader([entry]), opts);
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
    });
    expect(resolved.source).toBe('directory');
    expect(resolved.matchedBy).toBe('userAadObjectId');
    expect(resolved.clientId).toBe('0002');
    expect(resolved.target).toEqual(entry.target);
    expect(resolved.nip).toBe('9571185285');
    expect(resolved.companyName).toBe('PESKOVOI Sp. z o.o.');
  });

  it('user id lookup is case-insensitive on the caller side', async () => {
    const entry = makeEntry({
      clientId: '0002',
      userAadObjectIds: ['ae3987d3-9a3a-4ff8-bcf7-713d24e79c48'],
    });
    const resolver = new ClientResolver(makeReader([entry]), opts);
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: 'AE3987D3-9A3A-4FF8-BCF7-713D24E79C48',
    });
    expect(resolved.matchedBy).toBe('userAadObjectId');
  });

  it('falls back when user id is registered on an admin row', async () => {
    const adminUser = makeEntry({
      clientId: 'admin-yahor',
      isAdmin: true,
      userAadObjectIds: ['ae3987d3-9a3a-4ff8-bcf7-713d24e79c48'],
      target: { siteHostname: '', sitePath: '', driveName: '' },
    });
    const resolver = new ClientResolver(makeReader([adminUser]), opts);
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
    });
    expect(resolved.source).toBe('fallback');
  });

  it('falls back to title as companyName when no aliases are set', async () => {
    const entry = makeEntry({
      clientId: '0002',
      title: 'PESKOVOI',
      companyNameAliases: [],
      userAadObjectIds: ['ae3987d3-9a3a-4ff8-bcf7-713d24e79c48'],
    });
    const resolver = new ClientResolver(makeReader([entry]), opts);
    const resolved = await resolver.resolve({
      ...baseSource,
      userAadObjectId: 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
    });
    expect(resolved.companyName).toBe('PESKOVOI');
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — post-classification refinement (content NIP + direction)
// ---------------------------------------------------------------------------

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    documentType: 'Nieposortowane',
    folderPath: '98_Nieposortowane/2026/02',
    confidence: 0.75,
    classifier: 'claude',
    fields: { category: 'nieposortowane', year: 2026, month: 2 },
    ...overrides,
  };
}

describe('ClientResolver.resolvePostClassification', () => {
  const opts = { fallbackTarget, fallbackClientId: 'bcr-group', fallbackTitle: 'BCR Group' };

  const peskovoi = makeEntry({
    clientId: '0002',
    title: '[0002] PESKOVOI',
    nip: '9571185285',
    companyNameAliases: ['PESKOVOI Sp. z o.o.'],
    target: {
      siteHostname: 'contoso.sharepoint.com',
      sitePath: '/sites/PESKOVOI',
      driveName: 'Dokumenty',
    },
  });

  it('promotes fallback to a Directory client when a party NIP matches', async () => {
    const resolver = new ClientResolver(makeReader([peskovoi]), opts);
    const preResolved = await resolver.resolve(baseSource);
    expect(preResolved.source).toBe('fallback');

    const parties: DocumentParty[] = [
      { role: 'seller', nip: '8652567240', companyName: 'Autorud' },
      { role: 'buyer', nip: '9571185285', companyName: 'PESKOVOI Sp. z o.o.' },
    ];
    const post = await resolver.resolvePostClassification(
      preResolved,
      makeClassification({ parties }),
    );

    expect(post.promotedFromFallback).toBe(true);
    expect(post.client.source).toBe('directory');
    expect(post.client.matchedBy).toBe('nip');
    expect(post.client.clientId).toBe('0002');
    expect(post.client.target).toEqual(peskovoi.target);
  });

  it('flips a nieposortowane invoice to faktury_zakupu when client is a buyer', async () => {
    const resolver = new ClientResolver(makeReader([peskovoi]), opts);
    const preResolved = await resolver.resolve(baseSource);

    const parties: DocumentParty[] = [
      { role: 'seller', nip: '8652567240', companyName: 'Autorud' },
      { role: 'buyer', nip: '9571185285', companyName: 'PESKOVOI' },
    ];
    const post = await resolver.resolvePostClassification(
      preResolved,
      makeClassification({ parties }),
    );

    expect(post.promotedFromFallback).toBe(true);
    expect(post.directionCorrection).toBe('zakup');
    expect(post.classification.folderPath).toBe('01_Faktury/02_Faktury_zakupu/2026/02');
    expect(post.classification.fields.category).toBe('faktury_zakupu');
    expect(post.classification.documentType).toBe('Faktura zakupu');
  });

  it('flips a nieposortowane invoice to faktury_sprzedazy when client is a seller', async () => {
    const resolver = new ClientResolver(makeReader([peskovoi]), opts);
    const preResolved = await resolver.resolve(baseSource);

    const parties: DocumentParty[] = [
      { role: 'seller', nip: '9571185285', companyName: 'PESKOVOI' },
      { role: 'buyer', nip: '8652567240', companyName: 'Autorud' },
    ];
    const post = await resolver.resolvePostClassification(
      preResolved,
      makeClassification({ parties }),
    );

    expect(post.directionCorrection).toBe('sprzedaz');
    expect(post.classification.folderPath).toBe('01_Faktury/01_Faktury_sprzedaży/2026/02');
    expect(post.classification.fields.category).toBe('faktury_sprzedazy');
  });

  it('keeps fallback when multiple Directory clients appear in the same document', async () => {
    const otherClient = makeEntry({
      clientId: '0003',
      nip: '8652567240',
      title: 'Autorud',
    });
    const resolver = new ClientResolver(makeReader([peskovoi, otherClient]), opts);
    const preResolved = await resolver.resolve(baseSource);

    const parties: DocumentParty[] = [
      { role: 'seller', nip: '8652567240' },
      { role: 'buyer', nip: '9571185285' },
    ];
    const post = await resolver.resolvePostClassification(
      preResolved,
      makeClassification({ parties }),
    );

    expect(post.promotedFromFallback).toBeUndefined();
    expect(post.client.source).toBe('fallback');
  });

  it('does nothing when no parties are extracted', async () => {
    const resolver = new ClientResolver(makeReader([peskovoi]), opts);
    const preResolved = await resolver.resolve(baseSource);
    const post = await resolver.resolvePostClassification(preResolved, makeClassification());
    expect(post.promotedFromFallback).toBeUndefined();
    expect(post.directionCorrection).toBeUndefined();
    expect(post.classification).toEqual(makeClassification());
  });

  it('does not modify categories outside of the invoice / nieposortowane whitelist', async () => {
    const resolver = new ClientResolver(makeReader([peskovoi]), opts);
    const preResolved = await resolver.resolve(baseSource);
    const parties: DocumentParty[] = [
      { role: 'seller', nip: '9571185285', companyName: 'PESKOVOI' },
      { role: 'buyer', nip: '8652567240' },
    ];
    const post = await resolver.resolvePostClassification(
      preResolved,
      makeClassification({
        documentType: 'Umowa',
        folderPath: '03_Umowy',
        fields: { category: 'umowy' },
        parties,
      }),
    );
    // Direction is not touched for umowy, but the fallback promotion still runs.
    expect(post.promotedFromFallback).toBe(true);
    expect(post.directionCorrection).toBeUndefined();
    expect(post.classification.folderPath).toBe('03_Umowy');
  });
});

describe('applyInvoiceDirection', () => {
  it('returns null when parties is empty', () => {
    expect(
      applyInvoiceDirection(makeClassification({ parties: [] }), '9571185285'),
    ).toBeNull();
  });

  it('returns null when the current category is neither invoice nor nieposortowane', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          fields: { category: 'umowy', year: 2026, month: 2 },
          parties: [{ role: 'seller', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });

  it('returns null when the current category already matches the party role', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          documentType: 'Faktura sprzedaży',
          folderPath: '01_Faktury/01_Faktury_sprzedaży/2026/02',
          fields: { category: 'faktury_sprzedazy', year: 2026, month: 2 },
          parties: [{ role: 'seller', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });

  it('returns null when year/month are missing (cannot rebuild path)', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          fields: { category: 'nieposortowane' },
          parties: [{ role: 'buyer', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });

  it('flips nieposortowane → faktury_zakupu for a buyer client', () => {
    const applied = applyInvoiceDirection(
      makeClassification({
        parties: [{ role: 'buyer', nip: '9571185285' }],
      }),
      '9571185285',
    );
    expect(applied?.direction).toBe('zakup');
    expect(applied?.classification.fields.category).toBe('faktury_zakupu');
    expect(applied?.classification.folderPath).toBe('01_Faktury/02_Faktury_zakupu/2026/02');
  });

  it('ignores party roles other than seller/buyer', () => {
    expect(
      applyInvoiceDirection(
        makeClassification({
          parties: [{ role: 'unknown', nip: '9571185285' }],
        }),
        '9571185285',
      ),
    ).toBeNull();
  });
});
