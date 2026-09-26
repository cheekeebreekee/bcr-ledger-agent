import {
  ISO_4217_CURRENCIES,
  isValidNip,
  normalizeAmount,
  normalizeCurrency,
  normalizeIsoDate,
  normalizeKsefNumber,
  normalizeNip,
  normalizeText,
} from './invoiceFields';

/** Synthetic NIPs only (checksums computed, no real company). */
const NIP_CASES: readonly (readonly [string, boolean])[] = [
  ['1234567819', true],
  ['5260250274', true],
  ['9876543210', true],
  ['1000000006', true],
  ['1234567810', false],
  ['5260250275', false],
  ['0000000000', false],
  ['123456781', false],
  ['12345678190', false],
  ['123456781a', false],
  ['', false],
];

describe('isValidNip', () => {
  it.each(NIP_CASES)('%s → %s', (nip, valid) => {
    expect(isValidNip(nip)).toBe(valid);
  });

  it('never accepts a remainder of 10, whatever the tenth digit', () => {
    // 100000016 weighs to a remainder of 10: no tenth digit can match it.
    const tenths = '0123456789'.split('').filter((d) => isValidNip(`100000016${d}`));
    expect(tenths).toEqual([]);
  });
});

describe('normalizeNip', () => {
  it('accepts the ways a NIP is written on a document', () => {
    expect(normalizeNip('123-456-78-19')).toBe('1234567819');
    expect(normalizeNip('123 456 78 19')).toBe('1234567819');
    expect(normalizeNip('PL1234567819')).toBe('1234567819');
    expect(normalizeNip(' pl 123-45-67-819 ')).toBe('1234567819');
  });

  it('refuses an invalid checksum, a foreign VAT number and anything else', () => {
    expect(normalizeNip('1234567810')).toBeNull();
    expect(normalizeNip('DE1234567819')).toBeNull();
    expect(normalizeNip('NIP: 1234567819')).toBeNull();
    expect(normalizeNip('1234567819x')).toBeNull();
    expect(normalizeNip('')).toBeNull();
    expect(normalizeNip(null)).toBeNull();
    expect(normalizeNip(undefined)).toBeNull();
  });
});

describe('normalizeAmount', () => {
  it.each([
    ['1234.5', '1234.50'],
    ['1234,50', '1234.50'],
    ['1 234,50', '1234.50'],
    ['1 234.00', '1234.00'],
    ['-80', '-80.00'],
    ['0007.1', '7.10'],
    ['0', '0.00'],
    ['-0.00', '0.00'],
    ['999999999999.99', '999999999999.99'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAmount(input)).toBe(expected);
  });

  it('takes a finite number', () => {
    expect(normalizeAmount(12.5)).toBe('12.50');
    expect(normalizeAmount(Number.NaN)).toBeNull();
  });

  it.each([
    '1.234,50',
    '1,234.50',
    '12.345',
    '100 zł',
    'PLN 5',
    '1e3',
    '',
    '-',
    '.50',
    '1000000000000.00',
  ])('refuses %j rather than guessing', (input) => {
    expect(normalizeAmount(input)).toBeNull();
  });

  it('is null for null and undefined', () => {
    expect(normalizeAmount(null)).toBeNull();
    expect(normalizeAmount(undefined)).toBeNull();
  });
});

describe('normalizeIsoDate', () => {
  it('keeps a real calendar date', () => {
    expect(normalizeIsoDate('2026-09-26')).toBe('2026-09-26');
    expect(normalizeIsoDate(' 2024-02-29 ')).toBe('2024-02-29');
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '26-09-2026', '2026-9-26', '1899-12-31', ''])(
    'refuses %j',
    (input) => {
      expect(normalizeIsoDate(input)).toBeNull();
    },
  );

  it('is null for a non-string', () => {
    expect(normalizeIsoDate(null)).toBeNull();
  });
});

describe('normalizeCurrency', () => {
  it('upper-cases an ISO 4217 code', () => {
    expect(normalizeCurrency('pln')).toBe('PLN');
    expect(normalizeCurrency(' EUR ')).toBe('EUR');
    expect(normalizeCurrency('HRK')).toBe('HRK');
  });

  it('refuses symbols, metals and made-up codes', () => {
    for (const value of ['zł', '€', '$', 'XAU', 'XXX', 'ABC', 'PLNN', '', null]) {
      expect(normalizeCurrency(value)).toBeNull();
    }
  });

  it('holds three upper-case letters only', () => {
    const bad = [...ISO_4217_CURRENCIES].filter((c) => !/^[A-Z]{3}$/.test(c));
    expect(bad).toEqual([]);
  });
});

describe('normalizeText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeText('  FV  12/09/2026\n', 100)).toBe('FV 12/09/2026');
  });

  it('refuses empty, too long and control characters', () => {
    expect(normalizeText('   ', 100)).toBeNull();
    expect(normalizeText('x'.repeat(101), 100)).toBeNull();
    expect(normalizeText('FV\u0000 1', 100)).toBeNull();
    expect(normalizeText(undefined, 100)).toBeNull();
  });
});

describe('normalizeKsefNumber', () => {
  const ksef = '1234567819-20260926-0123456789AB-CD';

  it('accepts the shape with a valid NIP and date, upper-cased', () => {
    expect(normalizeKsefNumber(ksef)).toBe(ksef);
    expect(normalizeKsefNumber(ksef.toLowerCase())).toBe(ksef);
  });

  it('refuses an invalid NIP, date or shape', () => {
    expect(normalizeKsefNumber('1234567810-20260926-0123456789AB-CD')).toBeNull();
    expect(normalizeKsefNumber('1234567819-20260230-0123456789AB-CD')).toBeNull();
    expect(normalizeKsefNumber('1234567819-20260926-0123456789A-CD')).toBeNull();
    expect(normalizeKsefNumber('1234567819-20260926-0123456789AG-CD')).toBeNull();
    expect(normalizeKsefNumber(null)).toBeNull();
  });
});
