import { joinFolderPath, sanitizeFilename, sanitizeFolderPath } from './pathBuilder';

describe('sanitizeFolderPath', () => {
  it('keeps a safe path unchanged', () => {
    expect(sanitizeFolderPath('Invoices/2026/03')).toBe('Invoices/2026/03');
  });

  it('strips leading and trailing slashes', () => {
    expect(sanitizeFolderPath('/Invoices/2026/03/')).toBe('Invoices/2026/03');
  });

  it('collapses duplicate slashes', () => {
    expect(sanitizeFolderPath('Invoices//2026///03')).toBe('Invoices/2026/03');
  });

  it('replaces forbidden characters with underscores', () => {
    expect(sanitizeFolderPath('Invoices/2026?/03*')).toBe('Invoices/2026_/03_');
  });

  it('handles backslashes from Windows-style inputs', () => {
    expect(sanitizeFolderPath('Invoices\\2026\\03')).toBe('Invoices/2026/03');
  });

  it('rejects traversal attempts', () => {
    expect(() => sanitizeFolderPath('Invoices/../etc')).toThrow(/traversal/);
  });

  it('rejects empty input', () => {
    expect(() => sanitizeFolderPath('')).toThrow(/required/);
    expect(() => sanitizeFolderPath('///')).toThrow(/empty/);
  });

  it('rejects reserved Windows names', () => {
    expect(() => sanitizeFolderPath('Invoices/CON/03')).toThrow(/reserved/);
  });
});

describe('sanitizeFilename', () => {
  it('preserves a clean filename', () => {
    expect(sanitizeFilename('Invoice_03_2026.pdf')).toBe('Invoice_03_2026.pdf');
  });

  it('keeps the extension intact when sanitising the base', () => {
    expect(sanitizeFilename('My/Invoice*.pdf')).toBe('My_Invoice_.pdf');
  });

  it('trims surrounding dots and whitespace', () => {
    expect(sanitizeFilename('  .Invoice.pdf  ')).toBe('Invoice.pdf');
  });

  it('replaces a name of only forbidden chars with underscores', () => {
    expect(sanitizeFilename('***.pdf')).toBe('___.pdf');
  });
});

describe('joinFolderPath', () => {
  it('returns the relative path when root is undefined', () => {
    expect(joinFolderPath(undefined, 'Invoices/2026/03')).toBe('Invoices/2026/03');
  });

  it('joins with a single slash regardless of trailing/leading slashes', () => {
    expect(joinFolderPath('Ledger/', '/Invoices/2026/03')).toBe('Ledger/Invoices/2026/03');
    expect(joinFolderPath('Ledger', 'Invoices/2026/03')).toBe('Ledger/Invoices/2026/03');
  });
});
