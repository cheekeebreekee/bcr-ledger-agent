import {
  buildFolderPath,
  categoryCatalog,
  FALLBACK_CATEGORY,
  getCategory,
  invoiceCategoryForDirection,
  isDocumentCategory,
} from './folderTaxonomy';

describe('folderTaxonomy', () => {
  describe('buildFolderPath — dated categories', () => {
    it('builds a nested YYYY/MM leaf for sales invoices', () => {
      expect(buildFolderPath('faktury_sprzedazy', { year: 2026, month: 3 })).toBe(
        '01_Faktury/01_Faktury_sprzedaży/2026/03',
      );
    });

    it('builds purchase invoice paths', () => {
      expect(buildFolderPath('faktury_zakupu', { year: 2026, month: 11 })).toBe(
        '01_Faktury/02_Faktury_zakupu/2026/11',
      );
    });

    it('builds bank statement paths', () => {
      expect(buildFolderPath('wyciagi_bankowe', { year: 2026, month: 6 })).toBe(
        '02_Wyciągi_bankowe/2026/06',
      );
    });

    it('builds marketplace report paths', () => {
      expect(buildFolderPath('raporty_marketplace', { year: 2026, month: 1 })).toBe(
        '03_Raporty_marketplace/2026/01',
      );
    });

    it('zero-pads single-digit months', () => {
      expect(buildFolderPath('faktury_korekty', { year: 2026, month: 7 })).toBe(
        '01_Faktury/03_Korekty_i_anulowania/2026/07',
      );
    });

    it('accepts string year/month', () => {
      expect(buildFolderPath('faktury_noty', { year: '2026', month: '9' })).toBe(
        '01_Faktury/04_Noty_i_dowody_księgowe/2026/09',
      );
    });

    it('routes the fallback category to a dated 98_Nieposortowane', () => {
      expect(buildFolderPath('nieposortowane', { year: 2026, month: 6 })).toBe(
        '98_Nieposortowane/2026/06',
      );
    });
  });

  describe('buildFolderPath — flat categories', () => {
    it.each([
      ['umowy', '04_Umowy'],
      ['dokumenty_firmowe', '05_Dokumenty_firmowe_ustawowe'],
      ['kadry_place', '06_Kadry_i_płace'],
      ['deklaracje_jpk', '07_Deklaracje_i_JPK'],
      ['korespondencja', '08_Korespondencja'],
      ['raporty', '09_Raporty'],
      ['srodki_trwale', '10_Środki_trwałe'],
      ['ewidencja_vat', '11_Ewidencja_VAT'],
      ['onboarding_reguly', '12_Onboarding_i_reguły'],
      ['inne', '13_Inne'],
    ] as const)('builds %s → %s without a date leaf', (category, expected) => {
      expect(buildFolderPath(category, { year: 2026, month: 6 })).toBe(expected);
    });

    it('does not require a date for flat categories', () => {
      expect(buildFolderPath('umowy')).toBe('04_Umowy');
    });
  });

  describe('buildFolderPath — validation', () => {
    it('throws when a dated category is missing a date', () => {
      expect(() => buildFolderPath('wyciagi_bankowe')).toThrow(/requires a date/);
    });

    it('throws on an invalid month', () => {
      expect(() => buildFolderPath('wyciagi_bankowe', { year: 2026, month: 13 })).toThrow(
        /Invalid month/,
      );
    });

    it('throws on an invalid year', () => {
      expect(() => buildFolderPath('wyciagi_bankowe', { year: 26, month: 6 })).toThrow(
        /Invalid year/,
      );
    });

    it('throws for an unknown category', () => {
      expect(() => getCategory('does_not_exist' as never)).toThrow(/Unknown document category/);
    });
  });

  describe('invoiceCategoryForDirection', () => {
    it('maps sprzedaz → sales', () => {
      expect(invoiceCategoryForDirection('sprzedaz')).toBe('faktury_sprzedazy');
    });
    it('maps zakup → purchase', () => {
      expect(invoiceCategoryForDirection('zakup')).toBe('faktury_zakupu');
    });
    it('defaults non-invoice direction to purchase', () => {
      expect(invoiceCategoryForDirection('nie_dotyczy')).toBe('faktury_zakupu');
    });
  });

  describe('isDocumentCategory', () => {
    it('accepts known categories', () => {
      expect(isDocumentCategory('umowy')).toBe(true);
    });
    it('rejects unknown values', () => {
      expect(isDocumentCategory('nope')).toBe(false);
      expect(isDocumentCategory(123)).toBe(false);
      expect(isDocumentCategory(undefined)).toBe(false);
    });
  });

  describe('catalog integrity', () => {
    it('has unique ids', () => {
      const ids = categoryCatalog.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('exposes the fallback category in the catalog', () => {
      expect(categoryCatalog.some((c) => c.id === FALLBACK_CATEGORY)).toBe(true);
    });

    it('every dated category produces a YYYY/MM suffix', () => {
      for (const c of categoryCatalog.filter((x) => x.dated)) {
        expect(buildFolderPath(c.id, { year: 2026, month: 5 })).toMatch(/\/2026\/05$/);
      }
    });

    // Ids are folder keys, log values and eval truth labels: descriptions may
    // change, ids may not.
    it('keeps the category ids and their order', () => {
      expect(categoryCatalog.map((c) => c.id)).toEqual([
        'faktury_sprzedazy',
        'faktury_zakupu',
        'faktury_korekty',
        'faktury_noty',
        'wyciagi_bankowe',
        'raporty_marketplace',
        'umowy',
        'dokumenty_firmowe',
        'kadry_place',
        'deklaracje_jpk',
        'korespondencja',
        'raporty',
        'srodki_trwale',
        'ewidencja_vat',
        'onboarding_reguly',
        'inne',
        'nieposortowane',
      ]);
    });
  });

  // The rules the 2026-09-26 evaluation found missing. The descriptions are
  // the model's rules, so each must stay in the catalog.
  describe('classification rules in the descriptions', () => {
    const description = (id: Parameters<typeof getCategory>[0]) => getCategory(id).description;

    it.each([
      ['faktury_noty', /paragon.*BEZ danych nabywcy/s],
      ['faktury_noty', /klantenbon/],
      ['faktury_zakupu', /paragon fiskalny z NIP-em nabywcy/],
      ['faktury_sprzedazy', /paragon fiskalny z NIP-em nabywcy/],
      ['faktury_zakupu', /zagraniczna.*rachunek hotelowy/s],
      ['inne', /pro forma/],
      ['umowy', /OWU/],
    ] as const)('%s says %s', (id, rule) => {
      expect(description(id)).toMatch(rule);
    });
  });
});
