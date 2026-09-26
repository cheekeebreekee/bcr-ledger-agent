import {
  arbiterToTruth,
  INVOICE_FAMILY,
  normalizeName,
  parseTruth,
  type ArbiterRow,
} from './truth';

// Synthetic rows in the arbiter report's shape. No real names or NIPs.
const CLIENT_NAME = 'Biuro Testowe Sp. z o.o.';
const CLIENT_NIP = '1234567890';

function row(over: ArbiterRow): ArbiterRow {
  return {
    local: '/tmp/docs/01-dokument.pdf',
    reviewerCategory: 'umowy',
    pipelineCategory: 'umowy',
    month: '',
    seller: '',
    buyer: '',
    verdict: 'agree',
    ...over,
  };
}

describe('parseTruth', () => {
  it('reads entries, and gives a directed entry its invoice category', () => {
    expect(
      parseTruth([
        { file: 'a.pdf', category: 'umowy', month: '' },
        { file: 'b.pdf', category: 'faktura', month: '2026-09', direction: 'sprzedaz' },
        { file: 'c.pdf', category: 'faktura', month: '2026-08' },
        { file: 'd.pdf', category: 'faktury_zakupu', month: '2026-07', direction: 'zakup' },
      ]),
    ).toEqual([
      { file: 'a.pdf', category: 'umowy', month: '' },
      { file: 'b.pdf', category: 'faktury_sprzedazy', month: '2026-09', direction: 'sprzedaz' },
      { file: 'c.pdf', category: INVOICE_FAMILY, month: '2026-08' },
      { file: 'd.pdf', category: 'faktury_zakupu', month: '2026-07', direction: 'zakup' },
    ]);
  });

  it('reads invoice fields in their compared form', () => {
    const [entry] = parseTruth([
      {
        file: 'fv.pdf',
        category: 'faktury_zakupu',
        month: '2026-09',
        fields: {
          invoiceNumber: 'fv 12 / 2026',
          issueDate: '2026-09-12',
          currency: 'pln',
          grossAmount: '1 230,00',
          sellerNip: '526-025-02-74',
          sellerName: 'Dostawca S.A.',
        },
      },
    ]);
    expect(entry?.fields).toEqual({
      invoiceNumber: 'FV12/2026',
      issueDate: '2026-09-12',
      currency: 'PLN',
      grossAmount: '1230.00',
      sellerNip: '5260250274',
      sellerName: 'dostawca s a',
    });
  });

  it('leaves out an empty fields object', () => {
    expect(parseTruth([{ file: 'x.pdf', category: 'umowy', month: '', fields: {} }])).toEqual([
      { file: 'x.pdf', category: 'umowy', month: '' },
    ]);
  });

  it.each([
    [
      'a truth NIP with a wrong checksum',
      [{ file: 'x.pdf', category: 'faktury_noty', month: '', fields: { sellerNip: '5260250275' } }],
      /fields\.sellerNip.*not a valid value/,
    ],
    [
      'an unknown invoice field',
      [{ file: 'x.pdf', category: 'faktury_noty', month: '', fields: { total: '1.00' } }],
      /total/,
    ],
  ])('refuses %s', (_label, json, message) => {
    expect(() => parseTruth(json)).toThrow(message);
  });

  it.each([
    ['a path, not a file name', [{ file: '../x.pdf', category: 'umowy', month: '' }], /file name/],
    ['an unknown category', [{ file: 'x.pdf', category: 'invoice', month: '' }], /category id/],
    ['a bad month', [{ file: 'x.pdf', category: 'umowy', month: '2026-13' }], /YYYY-MM/],
    [
      'a direction against its category',
      [{ file: 'x.pdf', category: 'faktury_zakupu', month: '', direction: 'sprzedaz' }],
      /does not match/,
    ],
    ['an unknown field', [{ file: 'x.pdf', category: 'umowy', month: '', note: 1 }], /note/],
    ['not an array', { file: 'x.pdf' }, /Invalid truth file/],
    [
      'the same file twice',
      [
        { file: 'x.pdf', category: 'umowy', month: '' },
        { file: 'x.pdf', category: 'inne', month: '' },
      ],
      /listed twice/,
    ],
  ])('refuses %s', (_label, json, message) => {
    expect(() => parseTruth(json)).toThrow(message);
  });
});

describe('arbiterToTruth', () => {
  it('takes the agreed category, the winner of a disagreement, and the base file name', () => {
    const truth = arbiterToTruth([
      row({ local: '/x/01-a.pdf', reviewerCategory: 'umowy', verdict: 'agree' }),
      row({
        local: 'C:\\x\\02-b.pdf',
        reviewerCategory: 'faktury_noty',
        pipelineCategory: 'faktury_zakupu',
        verdict: 'disagree',
        month: '2026-08',
        adjudication: { winner: 'reviewer', correctCategory: 'faktury_noty (month 2026-08)' },
      }),
      row({
        local: '03-c.pdf',
        reviewerCategory: 'inne',
        pipelineCategory: 'korespondencja',
        verdict: 'disagree',
        adjudication: { winner: 'pipeline', correctCategory: '' },
      }),
      row({
        local: '04-d.pdf',
        reviewerCategory: 'umowy',
        pipelineCategory: 'nieposortowane',
        verdict: 'disagree',
        adjudication: { winner: 'reviewer', correctCategory: 'no id here' },
      }),
    ]);
    expect(truth).toEqual([
      { file: '01-a.pdf', category: 'umowy', month: '' },
      { file: '02-b.pdf', category: 'faktury_noty', month: '2026-08' },
      { file: '03-c.pdf', category: 'korespondencja', month: '' },
      { file: '04-d.pdf', category: 'umowy', month: '' },
    ]);
  });

  it('turns direction_unknown into the invoice family, and a both-acceptable verdict into the reviewer’s', () => {
    const truth = arbiterToTruth([
      row({
        reviewerCategory: 'direction_unknown',
        pipelineCategory: 'faktury_zakupu',
        verdict: 'disagree',
        month: '2026-09',
        adjudication: { winner: 'both_acceptable', correctCategory: 'direction_unknown (...)' },
      }),
    ]);
    expect(truth).toEqual([
      { file: '01-dokument.pdf', category: INVOICE_FAMILY, month: '2026-09' },
    ]);
  });

  it('with a client identity, sets the direction from the side that names the client', () => {
    const invoiceRow = (local: string, seller: string, buyer: string) =>
      row({
        local,
        reviewerCategory: 'direction_unknown',
        pipelineCategory: 'faktury_zakupu',
        verdict: 'disagree',
        month: '2026-09',
        seller,
        buyer,
        adjudication: { winner: 'both_acceptable', correctCategory: 'direction_unknown' },
      });
    const rows = [
      invoiceRow('sale.pdf', 'BIURO TESTOWE sp. z o.o.', 'Kontrahent GmbH'),
      invoiceRow('purchase.pdf', 'Dostawca Sp. z o.o.', 'Biuro Testowe Sp. z o.o. (PL)'),
      invoiceRow('by-nip.pdf', 'Sklep Sp. z o.o.', `identified only by NIP ${CLIENT_NIP}`),
      invoiceRow('neither.pdf', 'Sklep Sp. z o.o.', 'Jan Kowalski'),
      invoiceRow('both.pdf', CLIENT_NAME, CLIENT_NAME),
    ];

    expect(arbiterToTruth(rows, { name: CLIENT_NAME, nip: CLIENT_NIP })).toEqual([
      { file: 'sale.pdf', category: 'faktury_sprzedazy', month: '2026-09', direction: 'sprzedaz' },
      { file: 'purchase.pdf', category: 'faktury_zakupu', month: '2026-09', direction: 'zakup' },
      { file: 'by-nip.pdf', category: 'faktury_zakupu', month: '2026-09', direction: 'zakup' },
      { file: 'neither.pdf', category: INVOICE_FAMILY, month: '2026-09' },
      { file: 'both.pdf', category: INVOICE_FAMILY, month: '2026-09' },
    ]);
    // Without an identity no direction is invented.
    expect(arbiterToTruth(rows).every((e) => e.direction === undefined)).toBe(true);
  });

  it('keeps an explicit invoice direction from the arbiter when no side names the client', () => {
    expect(
      arbiterToTruth([row({ reviewerCategory: 'faktury_zakupu', month: '2026-06' })], {
        name: CLIENT_NAME,
      }),
    ).toEqual([
      { file: '01-dokument.pdf', category: 'faktury_zakupu', month: '2026-06', direction: 'zakup' },
    ]);
    expect(arbiterToTruth([row({ reviewerCategory: 'faktury_sprzedazy' })])[0]?.direction).toBe(
      'sprzedaz',
    );
  });

  it('ignores a name too short to match, and a month that is not YYYY-MM', () => {
    const truth = arbiterToTruth(
      [row({ reviewerCategory: 'direction_unknown', seller: 'AB Sp. z o.o.', month: 'Sept' })],
      { name: 'AB' },
    );
    expect(truth).toEqual([{ file: '01-dokument.pdf', category: INVOICE_FAMILY, month: '' }]);
  });

  it.each([
    ['no file', row({ local: '' }), /row 0: no file/],
    ['no category id', row({ reviewerCategory: 'something else' }), /row 0: no category id/],
  ])('refuses a row with %s, naming its index only', (_label, bad, message) => {
    expect(() => arbiterToTruth([bad])).toThrow(message);
  });
});

describe('normalizeName', () => {
  it('drops case, diacritics and punctuation', () => {
    expect(normalizeName('Łódzka Spółka Sp. z o.o.')).toBe('lodzka spolka sp z o o');
  });
});
