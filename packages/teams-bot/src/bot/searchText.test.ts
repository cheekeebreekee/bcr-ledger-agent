import { defangLinks } from '@bcr/shared';
import {
  filterFromForm,
  isHelpKeyword,
  normalizeQuestion,
  parseSearchAction,
  SEARCH_FORM_INPUTS,
} from './searchText';

const cp = (code: number) => String.fromCodePoint(code);
// A valid NIP (checksum) — synthetic, not a real company.
const NIP = '1234563218';

describe('normalizeQuestion', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeQuestion('  faktury \t zakupu\n\nz marca  ')).toBe('faktury zakupu z marca');
  });

  it('drops the bot mention and HTML tags', () => {
    expect(normalizeQuestion('<at>Asystent BCR</at> faktury <b>zakupu</b><br/>2026')).toBe(
      'faktury zakupu 2026',
    );
    expect(normalizeQuestion('<p>faktury</p><div class="x">marzec</div>')).toBe('faktury marzec');
  });

  it('decodes common entities once', () => {
    expect(normalizeQuestion('Kowalski &amp; Syn &lt;sp. j.&gt;')).toBe('Kowalski & Syn <sp. j.>');
    expect(normalizeQuestion('&amp;lt;')).toBe('&lt;');
    expect(normalizeQuestion('a&nbsp;b &#65;&#x42;')).toBe('a b AB');
  });

  it('turns an entity for a control character or an invalid code point into a space', () => {
    expect(normalizeQuestion('a&#0;b')).toBe('a b');
    expect(normalizeQuestion('a&#xD800;b')).toBe('a b');
  });

  it('removes bidi overrides, isolates and zero-width characters', () => {
    const text = `fak${cp(0x200b)}tura ${cp(0x202e)}fdp${cp(0x202c)} ${cp(0x2066)}x${cp(0x2069)}${cp(0xfeff)}`;
    expect(normalizeQuestion(text)).toBe('faktura fdp x');
    expect(normalizeQuestion(`a&#8238;b`)).toBe('ab');
  });

  it('turns control characters and line separators into spaces', () => {
    expect(normalizeQuestion(`a${cp(0x07)}b${cp(0x2028)}c${cp(0x85)}d`)).toBe('a b c d');
  });

  it('normalises to NFC', () => {
    expect(normalizeQuestion(`z${cp(0x307)}a`)).toBe('ża');
  });

  it('answers an empty string for a non-string or blank message', () => {
    expect(normalizeQuestion(undefined)).toBe('');
    expect(normalizeQuestion(null)).toBe('');
    expect(normalizeQuestion(' <at>Asystent</at> ')).toBe('');
  });
});

describe('isHelpKeyword', () => {
  it.each(['pomoc', 'Pomoc!', 'HELP', 'menu.', '?'])('%p asks for help', (q) => {
    expect(isHelpKeyword(q)).toBe(true);
  });

  it.each(['pomoc z fakturami', 'faktury?', 'hej', ''])('%p is not a help keyword', (q) => {
    expect(isHelpKeyword(q)).toBe(false);
  });
});

describe('parseSearchAction', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['a string', 'bcr.search.page'],
    ['an array', [1]],
    ['another version', { v: 2, action: 'bcr.search.page', filter: {}, after: 'c' }],
    ['another action', { v: 1, action: 'bcr.other' }],
    ['another card’s value', { choice: 'x' }],
  ])('reads %s as no action of ours', (_label, value) => {
    expect(parseSearchAction(value)).toEqual({ kind: 'none' });
  });

  it('reads a page request as its filter, cursor and display position only', () => {
    const value = {
      v: 1,
      action: 'bcr.search.page',
      filter: { categories: ['faktury_zakupu'], monthFrom: '2026-01' },
      after: 'cursor-1',
      start: 11,
      clientId: 'someone-else',
      listItemId: 2,
      scope: 'x',
      limit: 1000,
    };
    expect(parseSearchAction(value)).toEqual({
      kind: 'typed',
      filter: { categories: ['faktury_zakupu'], monthFrom: '2026-01' },
      after: 'cursor-1',
      start: 11,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a filter with an unknown key', { filter: { clientId: 'x' }, after: 'c' }],
    [
      'a filter with months in the wrong order',
      { filter: { monthFrom: '2026-05', monthTo: '2026-01' }, after: 'c' },
    ],
    ['no cursor', { filter: {} }],
    ['an empty cursor', { filter: {}, after: '' }],
    ['a cursor too long', { filter: {}, after: 'x'.repeat(257) }],
    ['a numeric cursor', { filter: {}, after: 5 }],
  ])('refuses a page request with %s', (_label, rest) => {
    expect(parseSearchAction({ v: 1, action: 'bcr.search.page', ...rest })).toEqual({
      kind: 'invalid',
    });
  });

  it.each([0, -3, 1.5, '11', 100_001])('shows a page from 1 when its start is %p', (start) => {
    const action = parseSearchAction({
      v: 1,
      action: 'bcr.search.page',
      filter: {},
      after: 'c',
      start,
    });
    expect(action).toMatchObject({ kind: 'typed', start: 1 });
  });

  it('reads the form into a typed filter from the first result, with no cursor', () => {
    const action = parseSearchAction({
      v: 1,
      action: 'bcr.search.filter',
      [SEARCH_FORM_INPUTS.categories]: 'faktury_zakupu,faktury_sprzedazy',
      [SEARCH_FORM_INPUTS.monthFrom]: '2026-01',
      after: 'smuggled-cursor',
      clientId: 'someone-else',
    });
    expect(action).toEqual({
      kind: 'typed',
      filter: { categories: ['faktury_zakupu', 'faktury_sprzedazy'], monthFrom: '2026-01' },
      start: 1,
    });
  });

  it('refuses a form whose values cannot become a filter', () => {
    expect(
      parseSearchAction({
        v: 1,
        action: 'bcr.search.filter',
        [SEARCH_FORM_INPUTS.monthFrom]: '03/2026',
      }),
    ).toEqual({ kind: 'invalid' });
  });
});

describe('filterFromForm', () => {
  const ids = SEARCH_FORM_INPUTS;

  it('leaves empty and missing inputs out: an empty form is the newest documents', () => {
    expect(
      filterFromForm({
        [ids.categories]: '',
        [ids.monthFrom]: '  ',
        [ids.grossMin]: null,
        [ids.status]: 'all',
      }),
    ).toEqual({});
  });

  it('normalises every field', () => {
    expect(
      filterFromForm({
        [ids.categories]: 'faktury_zakupu, faktury_zakupu ,umowy',
        [ids.monthFrom]: '2026-01',
        [ids.monthTo]: '2026-09',
        [ids.grossMin]: '1 500,5',
        [ids.grossMax]: '20000',
        [ids.currency]: ' pln ',
        [ids.counterpartyNip]: `PL ${NIP.slice(0, 3)}-${NIP.slice(3, 6)}-${NIP.slice(6, 8)}-${NIP.slice(8)}`,
        [ids.counterpartyName]: '  Kowalski   Sp. z o.o. ',
        [ids.invoiceNumber]: 'FV/12/2026',
        [ids.status]: 'in_review',
      }),
    ).toEqual({
      categories: ['faktury_zakupu', 'umowy'],
      monthFrom: '2026-01',
      monthTo: '2026-09',
      grossMin: '1500.50',
      grossMax: '20000.00',
      currency: 'PLN',
      counterpartyNip: NIP,
      counterpartyName: 'Kowalski Sp. z o.o.',
      invoiceNumber: 'FV/12/2026',
      status: 'in_review',
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown category', { [ids.categories]: 'faktury_zakupu,tajne' }],
    ['a month not RRRR-MM', { [ids.monthTo]: '2026-13' }],
    ['a negative amount', { [ids.grossMin]: '-5' }],
    ['an amount with a thousands separator', { [ids.grossMin]: '1.500,00' }],
    ['a minimum above the maximum', { [ids.grossMin]: '500', [ids.grossMax]: '100' }],
    ['From after To', { [ids.monthFrom]: '2026-09', [ids.monthTo]: '2026-01' }],
    ['a currency that is not ISO 4217', { [ids.currency]: 'zł' }],
    ['a NIP with a bad checksum', { [ids.counterpartyNip]: '1234567890' }],
    ['a name longer than 60 characters', { [ids.counterpartyName]: 'x'.repeat(61) }],
    ['an unknown status', { [ids.status]: 'deleted' }],
    ['a non-string input', { [ids.counterpartyName]: ['a'] }],
  ])('refuses %s', (_label, value) => {
    expect(filterFromForm(value)).toBeNull();
  });

  it('strips invisible characters from a typed name', () => {
    expect(
      filterFromForm({ [ids.counterpartyName]: `Kow${cp(0x200b)}alski${cp(0x202e)}` }),
    ).toEqual({ counterpartyName: 'Kowalski' });
  });

  it('takes a name and number copied from a result card back to their own characters', () => {
    // The card shows document values with link look-alikes (defangLinks); pasted back, they must match.
    const card = (value: string) => defangLinks(value);
    expect(
      filterFromForm({
        [ids.counterpartyName]: card('Dostawca Testowy Sp. z o.o.'),
        [ids.invoiceNumber]: card('FV/1/2026.KOR'),
      }),
    ).toEqual({ counterpartyName: 'Dostawca Testowy Sp. z o.o.', invoiceNumber: 'FV/1/2026.KOR' });
    expect(normalizeQuestion(`faktura ${card('FV/1/2026.KOR')}`)).toBe('faktura FV/1/2026.KOR');
  });
});
