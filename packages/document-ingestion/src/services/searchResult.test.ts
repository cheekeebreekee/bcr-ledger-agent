import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientViewRow } from '@bcr/ledger-db';
import { defangLinks, type SharePointTarget } from '@bcr/shared';
import type { SearchInterpretation } from './searchInterpreter';
import {
  MAX_WEB_URL_CHARS,
  counterpartyOf,
  guardedWebUrl,
  normalizeSearchQuestion,
  toResultItem,
  toSearchFilter,
  withoutReviewCategories,
} from './searchResult';

const NOW = new Date('2026-09-28T10:00:00Z');
/** The asking client's own NIP, and two other valid ones (synthetic). */
const OWN_NIP = '1234567819';
const OTHER_NIP = '5260250274';

const nothing: SearchInterpretation = {
  intent: 'search',
  categories: null,
  period: null,
  amount: null,
  currency: null,
  counterparty: null,
  invoice_number: null,
  status: null,
};
const interp = (over: Partial<SearchInterpretation>): SearchInterpretation => ({
  ...nothing,
  ...over,
});
const noPeriod = {
  year: null,
  month: null,
  quarter: null,
  to_year: null,
  to_month: null,
  offset: null,
  count: null,
};

describe('normalizeSearchQuestion', () => {
  it('drops bidi and zero-width characters, and collapses controls and whitespace', () => {
    expect(normalizeSearchQuestion('  faktury‮ od​ Kowal‍skiego\n\tz  marca\u0007 ')).toBe(
      'faktury od Kowalskiego z marca',
    );
  });

  it('composes to NFC, so a decomposed ą matches a composed one', () => {
    expect(normalizeSearchQuestion('kąt')).toBe('kąt');
  });

  it('is empty for a question of whitespace and invisible characters only', () => {
    expect(normalizeSearchQuestion(' ​⁦ \n')).toBe('');
  });
});

describe('toSearchFilter', () => {
  it('turns an empty interpretation into an empty filter (the newest documents)', () => {
    expect(toSearchFilter(nothing, 'pokaż moje dokumenty', NOW)).toEqual({
      ok: true,
      filter: {},
      notes: [],
    });
  });

  it('keeps categories once each, and resolves the period in Warsaw', () => {
    const r = toSearchFilter(
      interp({
        categories: ['faktury_zakupu', 'faktury_zakupu', 'faktury_korekty'],
        period: { ...noPeriod, kind: 'month', month: 3 },
        status: 'filed',
      }),
      'zarchiwizowane faktury zakupu i korekty z marca',
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      filter: {
        categories: ['faktury_zakupu', 'faktury_korekty'],
        monthFrom: '2026-03',
        monthTo: '2026-03',
        status: 'filed',
      },
      notes: [],
    });
  });

  it('drops categories for documents in review, which have none yet, and says so', () => {
    // A review row's category is always nieposortowane: categories + in_review could never match.
    const r = toSearchFilter(
      interp({
        categories: ['faktury_sprzedazy', 'faktury_zakupu'],
        currency: 'EUR',
        status: 'in_review',
      }),
      'faktury do weryfikacji w euro',
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      filter: { currency: 'EUR', status: 'in_review' },
      notes: ['categories_in_review'],
    });
  });

  it('drops nieposortowane alone with in_review silently: it is what in_review means', () => {
    expect(
      withoutReviewCategories({ categories: ['nieposortowane'], status: 'in_review' }),
    ).toEqual({ filter: { status: 'in_review' }, notes: [] });
    expect(withoutReviewCategories({ categories: ['umowy'] })).toEqual({
      filter: { categories: ['umowy'] },
      notes: [],
    });
  });

  it('says when the period was cut', () => {
    const r = toSearchFilter(
      interp({ period: { ...noPeriod, kind: 'last_n_months', count: 400 } }),
      'ostatnie 400 miesięcy',
      NOW,
    );
    expect(r).toMatchObject({ ok: true, notes: ['period_clamped'] });
  });

  it('does not understand a period it cannot read', () => {
    const r = toSearchFilter(
      interp({ period: { ...noPeriod, kind: 'month', month: 13 } }),
      'x',
      NOW,
    );
    expect(r).toEqual({ ok: false, reason: 'period_month' });
  });

  it('normalises amounts, and turns a minimum above the maximum round', () => {
    const r = toSearchFilter(
      interp({ amount: { min: '5 000,5', max: '1000' }, currency: 'pln' }),
      'faktury od 5 000,5 do 1000 zł',
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      filter: { grossMin: '1000.00', grossMax: '5000.50', currency: 'PLN' },
      notes: [],
    });
  });

  it('keeps a lone bound', () => {
    const r = toSearchFilter(interp({ amount: { min: null, max: '200' } }), 'do 200', NOW);
    expect(r).toMatchObject({ ok: true, filter: { grossMax: '200.00' } });
  });

  it.each([
    ['a negative amount', { amount: { min: '-100', max: null } }, 'amount'],
    ['an amount it cannot read', { amount: { min: '1.234,50', max: null } }, 'amount'],
    ['an amount too large for the index', { amount: { min: '1'.repeat(13), max: null } }, 'amount'],
    ['a currency that is not ISO 4217', { currency: 'ZŁ' }, 'currency'],
  ] as const)('does not understand %s', (_label, over, reason) => {
    expect(toSearchFilter(interp(over), 'faktury', NOW)).toEqual({ ok: false, reason });
  });

  it('keeps a NIP whose digits the question holds, however it was written', () => {
    for (const written of ['123-456-78-19', '123 456 78 19', 'PL1234567819', '1234567819']) {
      const r = toSearchFilter(
        interp({ counterparty: { nip: written, name: null } }),
        `faktury od NIP ${written}`,
        NOW,
      );
      expect(r).toEqual({ ok: true, filter: { counterpartyNip: OWN_NIP }, notes: [] });
    }
  });

  // The model can never search for a number the asker did not write: another
  // client's NIP, say, planted by a prompt injection.
  it('drops a NIP the question does not hold, with a note', () => {
    const r = toSearchFilter(
      interp({ counterparty: { nip: OTHER_NIP, name: null } }),
      'faktury od NIP 1234567819',
      NOW,
    );
    expect(r).toEqual({ ok: true, filter: {}, notes: ['nip_dropped'] });
  });

  it('drops a NIP when the question holds no number at all', () => {
    const r = toSearchFilter(
      interp({ counterparty: { nip: OWN_NIP, name: null } }),
      'faktury od mojego dostawcy',
      NOW,
    );
    expect(r).toEqual({ ok: true, filter: {}, notes: ['nip_dropped'] });
  });

  it('drops a NIP that fails the checksum, with a note', () => {
    const r = toSearchFilter(
      interp({ counterparty: { nip: '1234567890', name: null } }),
      'faktury od NIP 1234567890',
      NOW,
    );
    expect(r).toEqual({ ok: true, filter: {}, notes: ['nip_dropped'] });
  });

  it('keeps a name and an invoice number the question holds, in any case', () => {
    const r = toSearchFilter(
      interp({ counterparty: { nip: null, name: 'kowalski' }, invoice_number: 'fv/2025/07/113' }),
      'Faktura FV/2025/07/113 od KOWALSKIEGO',
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      filter: { counterpartyName: 'kowalski', invoiceNumber: 'fv/2025/07/113' },
      notes: [],
    });
  });

  it('matches a name across whitespace the model collapsed', () => {
    const r = toSearchFilter(
      interp({ counterparty: { nip: null, name: '  Kowalski   Transport ' } }),
      'faktury od Kowalski  Transport',
      NOW,
    );
    expect(r).toMatchObject({ ok: true, filter: { counterpartyName: 'Kowalski Transport' } });
  });

  it.each([
    [
      'a name the question does not hold',
      { counterparty: { nip: null, name: 'PESKOVOI' } },
      'counterparty_name_dropped',
    ],
    [
      'a name with a legal form the question lacks',
      { counterparty: { nip: null, name: 'Kowalski Sp. z o.o.' } },
      'counterparty_name_dropped',
    ],
    [
      'a name over 60 characters',
      { counterparty: { nip: null, name: 'k'.repeat(61) } },
      'counterparty_name_dropped',
    ],
    ['a blank name', { counterparty: { nip: null, name: '   ' } }, 'counterparty_name_dropped'],
    [
      'an invoice number the question does not hold',
      { invoice_number: 'FV/1/2026' },
      'invoice_number_dropped',
    ],
  ] as const)('drops %s, with a note', (_label, over, note) => {
    const r = toSearchFilter(interp(over), `faktury od ${'k'.repeat(61)} z marca`, NOW);
    expect(r).toEqual({ ok: true, filter: {}, notes: [note] });
  });

  it('keeps an invoice number copied from a result card, whichever form the model gives back', () => {
    const question = `faktura ${defangLinks('FV/1/2026.KOR')}`;
    for (const answer of ['FV/1/2026.KOR', defangLinks('FV/1/2026.KOR')]) {
      expect(toSearchFilter(interp({ invoice_number: answer }), question, NOW)).toEqual({
        ok: true,
        filter: { invoiceNumber: 'FV/1/2026.KOR' },
        notes: [],
      });
    }
    expect(normalizeSearchQuestion(question)).toBe('faktura FV/1/2026.KOR');
  });

  it('is not a filter when the shared contract refuses the result', () => {
    // The last check: here a category smuggled past the types.
    const r = toSearchFilter(interp({ categories: ['wszystko' as never] }), 'wszystko', NOW);
    expect(r).toEqual({ ok: false, reason: 'filter' });
  });
});

// ---------------------------------------------------------------------------

const target: SharePointTarget = {
  siteHostname: 'contoso.sharepoint.com',
  sitePath: '/sites/ClientA',
  driveName: 'Dokumenty',
  rootFolder: 'Dokumenty księgowe',
  expectedDriveId: 'b!drive-a',
};

describe('guardedWebUrl', () => {
  const good =
    'https://contoso.sharepoint.com/sites/ClientA/Shared%20Documents/Dokumenty%20ksi%C4%99gowe/01_Faktury/f.pdf';

  it("keeps an https link on the row's own site", () => {
    expect(guardedWebUrl(good, target)).toBe(good);
    expect(
      guardedWebUrl(good.replace('/sites/ClientA/', '/SITES/clienta/'), target),
    ).not.toBeNull();
    expect(guardedWebUrl(good.replace('contoso.', 'CONTOSO.'), target)).not.toBeNull();
  });

  it.each([
    ['no link', null],
    ['plain http', good.replace('https:', 'http:')],
    ['another host', good.replace('contoso.sharepoint.com', 'evil.example')],
    [
      'a look-alike host',
      good.replace('contoso.sharepoint.com', 'contoso.sharepoint.com.evil.example'),
    ],
    ['another client site', good.replace('/sites/ClientA/', '/sites/ClientB/')],
    ['a site whose name starts the same', good.replace('/sites/ClientA/', '/sites/ClientA2/')],
    ['the site root alone', 'https://contoso.sharepoint.com/sites/ClientA'],
    ['BCR GROUP', good.replace('/sites/ClientA/', '/sites/BCRGROUP/')],
    [
      'a traversal out of the site',
      'https://contoso.sharepoint.com/sites/ClientA/../ClientB/f.pdf',
    ],
    ['an encoded traversal', 'https://contoso.sharepoint.com/sites/ClientA/%2e%2e/ClientB/f.pdf'],
    ['an encoded slash', 'https://contoso.sharepoint.com/sites/ClientA%2F..%2FClientB/f.pdf'],
    ['user info', good.replace('https://', 'https://user:pw@')],
    ['a port', good.replace('.com/', '.com:8443/')],
    ['javascript', 'javascript:alert(1)'],
    ['not a URL', 'Kowalski'],
    ['a link over the length cap', `${good}?${'a'.repeat(MAX_WEB_URL_CHARS)}`],
  ])('drops %s', (_label, url) => {
    expect(guardedWebUrl(url, target)).toBeNull();
  });

  it('drops every link when the row has no canonical site path or no host', () => {
    expect(guardedWebUrl(good, { ...target, sitePath: '/sites/ClientA/sub' })).toBeNull();
    expect(guardedWebUrl(good, { ...target, siteHostname: ' ' })).toBeNull();
  });
});

const row = (over: Partial<ClientViewRow> = {}): ClientViewRow => ({
  documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  status: 'FILED',
  category: 'faktury_zakupu',
  documentMonth: '2026-09',
  invoiceNumber: 'FV 1/2026',
  issueDate: '2026-09-12',
  currency: 'PLN',
  grossAmount: '123.00',
  sellerNip: OTHER_NIP,
  sellerName: 'Dostawca S.A.',
  buyerNip: OWN_NIP,
  buyerName: 'Klient Testowy',
  webUrl: 'https://contoso.sharepoint.com/sites/ClientA/Shared%20Documents/f.pdf',
  createdAt: '2026-09-28T10:00:00.000000Z',
  ...over,
});

describe('counterpartyOf', () => {
  it.each([
    ["a purchase's seller", row(), { name: 'Dostawca S.A.', nip: OTHER_NIP }],
    [
      "a sale's buyer",
      row({
        category: 'faktury_sprzedazy',
        sellerNip: OWN_NIP,
        buyerNip: OTHER_NIP,
        buyerName: 'Nabywca',
      }),
      { name: 'Nabywca', nip: OTHER_NIP },
    ],
    [
      'a correction the client issued: the buyer',
      row({
        category: 'faktury_korekty',
        sellerNip: OWN_NIP,
        buyerNip: OTHER_NIP,
        buyerName: 'Nabywca',
      }),
      { name: 'Nabywca', nip: OTHER_NIP },
    ],
    [
      'a correction the client received: the seller',
      row({ category: 'faktury_korekty' }),
      { name: 'Dostawca S.A.', nip: OTHER_NIP },
    ],
    [
      'a receipt without a buyer: the seller',
      row({ category: 'faktury_noty', buyerNip: null, buyerName: null }),
      { name: 'Dostawca S.A.', nip: OTHER_NIP },
    ],
    [
      'a document in review sold by the client: the buyer',
      row({
        category: 'nieposortowane',
        sellerNip: OWN_NIP,
        buyerNip: OTHER_NIP,
        buyerName: 'Nabywca',
      }),
      { name: 'Nabywca', nip: OTHER_NIP },
    ],
    [
      'a "sale" whose buyer is the client: never the client, the other side',
      row({ category: 'faktury_sprzedazy' }),
      { name: 'Dostawca S.A.', nip: OTHER_NIP },
    ],
    [
      'a "purchase" whose seller is the client: the other side',
      row({
        category: 'faktury_zakupu',
        sellerNip: OWN_NIP,
        buyerNip: OTHER_NIP,
        buyerName: 'Nabywca',
      }),
      { name: 'Nabywca', nip: OTHER_NIP },
    ],
    [
      'the client on both sides: nobody',
      row({ category: 'faktury_noty', sellerNip: OWN_NIP, buyerNip: OWN_NIP }),
      { name: null, nip: null },
    ],
    [
      'a bank statement: no parties',
      row({
        category: 'wyciagi_bankowe',
        sellerNip: null,
        sellerName: null,
        buyerNip: null,
        buyerName: null,
      }),
      { name: null, nip: null },
    ],
  ])('%s', (_label, r, want) => {
    expect(counterpartyOf(r, OWN_NIP)).toEqual(want);
  });

  it('falls back to the category, and the seller, when the client has no NIP', () => {
    expect(counterpartyOf(row({ category: 'faktury_sprzedazy' }), '')).toEqual({
      name: 'Klient Testowy',
      nip: OWN_NIP,
    });
    expect(counterpartyOf(row({ category: 'inne' }), '')).toEqual({
      name: 'Dostawca S.A.',
      nip: OTHER_NIP,
    });
  });
});

describe('toResultItem', () => {
  const owner = { nip: OWN_NIP, target };

  it('maps the client-view fields, the status in the contract words and a guarded link', () => {
    expect(toResultItem(row(), owner)).toEqual({
      documentId: '0b7f3c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
      status: 'filed',
      category: 'faktury_zakupu',
      documentMonth: '2026-09',
      invoiceNumber: 'FV 1/2026',
      issueDate: '2026-09-12',
      grossAmount: '123.00',
      currency: 'PLN',
      counterpartyName: 'Dostawca S.A.',
      counterpartyNip: OTHER_NIP,
      webUrl: 'https://contoso.sharepoint.com/sites/ClientA/Shared%20Documents/f.pdf',
    });
  });

  it('labels a document in review in_review, and drops a link to another site', () => {
    const item = toResultItem(
      row({ status: 'NEEDS_REVIEW', category: 'nieposortowane', webUrl: 'https://evil.example/x' }),
      owner,
    );
    expect(item).toMatchObject({ status: 'in_review', category: 'nieposortowane', webUrl: null });
  });

  it('drops a row whose category the taxonomy does not know', () => {
    expect(toResultItem(row({ category: 'secret' }), owner)).toBeNull();
  });

  // Sentinel: whatever a row carries beyond the client view, nothing of it
  // reaches the answer.
  it('never carries anything but the client-view fields into the answer', () => {
    const leaky = {
      ...row(),
      uploadedByOid: 'ae3987d3-9a3a-4ff8-bcf7-713d24e79c48',
      contentSha256: 'f'.repeat(64),
      driveId: 'b!drive-a',
      driveItemId: '01ABCDEF',
      confidence: 0.934,
      model: 'claude-opus-5',
      classifier: 'claude',
      suggestedCategory: 'faktury_sprzedazy',
      reviewReasons: ['LOW_CONFIDENCE'],
      folderPath: '01_Faktury/02_Faktury_zakupu/2026/09',
      clientId: 'c0ffee00-1234-4abc-9def-00112233aabb',
      ksefNumber: '1234567819-20260912-ABCDEF123456-7F',
    } as unknown as ClientViewRow;
    const json = JSON.stringify(toResultItem(leaky, owner));
    const offenders = [
      'uploadedByOid',
      'ae3987d3',
      'contentSha256',
      'ffffffff',
      'driveId',
      'b!drive',
      'driveItemId',
      '01ABCDEF',
      'confidence',
      '0.934',
      'claude',
      'suggestedCategory',
      'faktury_sprzedazy',
      'reviewReasons',
      'LOW_CONFIDENCE',
      'folderPath',
      'clientId',
      'c0ffee00',
      'ksef',
      'createdAt',
      'Klient Testowy',
    ].filter((needle) => json.includes(needle));
    expect(offenders).toEqual([]);
  });
});

describe('the pure search modules', () => {
  // Nothing that turns a question into a filter or a row into a result may
  // reach the Directory, the resolver or the index.
  it('never read the Directory, resolve a client or open a transaction', () => {
    const offenders: string[] = [];
    for (const file of ['searchResult.ts', 'searchPeriod.ts', 'searchInterpreter.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      for (const needle of [
        'getSnapshot',
        'byUserAadObjectId',
        'clientDirectory',
        'resolve(',
        'withClientTx',
        'clientIdForDirectoryRow',
      ]) {
        if (source.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
