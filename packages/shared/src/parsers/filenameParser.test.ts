import {
  PatternRegistry,
  defaultFilenameParser,
  normaliseGroups,
  stripExtension,
} from './filenameParser';
import type { FilenamePattern } from './patternRegistry';

describe('stripExtension', () => {
  it.each([
    ['Invoice_03_2026.pdf', 'Invoice_03_2026'],
    ['Receipt_2026-03-15.png', 'Receipt_2026-03-15'],
    ['Contract_Acme_2026.signed.pdf', 'Contract_Acme_2026.signed'],
    ['no-extension', 'no-extension'],
    ['.dotfile', '.dotfile'],
  ])('strips the extension of %s', (input, expected) => {
    expect(stripExtension(input)).toBe(expected);
  });
});

describe('normaliseGroups', () => {
  it('zero-pads month, day and year', () => {
    expect(normaliseGroups({ year: '26', month: '3', day: '5' })).toEqual({
      year: '0026',
      month: '03',
      day: '05',
    });
  });

  it('leaves other fields untouched and trims whitespace', () => {
    expect(normaliseGroups({ counterparty: '  Acme  ' })).toEqual({ counterparty: 'Acme' });
  });

  it('drops undefined groups', () => {
    expect(normaliseGroups({ year: '2026', counterparty: undefined })).toEqual({ year: '2026' });
  });
});

describe('defaultFilenameParser', () => {
  it.each([
    ['Invoice_03_2026.pdf', 'Invoice', 'Invoices/2026/03'],
    ['Invoice-3-2026.pdf', 'Invoice', 'Invoices/2026/03'],
    ['Receipt_2026-03-15.png', 'Receipt', 'Receipts/2026/03'],
    ['Contract_Acme_2026_addendum.pdf', 'Contract', 'Contracts/2026/Acme'],
    ['Statement_Chase_2026_06.pdf', 'Statement', 'Statements/Chase/2026/06'],
    ['Report_Q2_2026.xlsx', 'Report', 'Reports/2026/Q2'],
  ])('matches %s as %s → %s', (filename, expectedType, expectedFolder) => {
    const result = defaultFilenameParser.parse(filename);
    expect(result.matched).toBe(true);
    expect(result.documentType).toBe(expectedType);
    expect(result.folderPath).toBe(expectedFolder);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('returns no match for an unrecognised filename', () => {
    const result = defaultFilenameParser.parse('random-photo.jpg');
    expect(result.matched).toBe(false);
    expect(result.folderPath).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it('returns no match for invalid month', () => {
    const result = defaultFilenameParser.parse('Invoice_13_2026.pdf');
    expect(result.matched).toBe(false);
  });
});

describe('PatternRegistry.register', () => {
  it('lets callers add tenant-specific patterns', () => {
    const registry = new PatternRegistry();
    const taxPattern: FilenamePattern = {
      id: 'tax-year',
      documentType: 'Tax',
      regex: /^Tax[_-](?<year>\d{4})/i,
      buildPath: ({ year }) => `Tax/${year}`,
      confidence: 0.99,
    };
    registry.register(taxPattern);

    const result = registry.parse('Tax_2026_filing.pdf');
    expect(result.matched).toBe(true);
    expect(result.pattern?.id).toBe('tax-year');
    expect(result.folderPath).toBe('Tax/2026');
    expect(result.confidence).toBe(0.99);
  });

  it('keeps default patterns when a custom set is passed in', () => {
    const registry = new PatternRegistry([
      {
        id: 'only-invoice',
        documentType: 'Invoice',
        regex: /^Invoice[_-](?<month>\d{1,2})[_-](?<year>\d{4})/,
        buildPath: ({ year, month }) => `I/${year}/${month}`,
      },
    ]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.parse('Receipt_2026-03-15.png').matched).toBe(false);
  });
});
