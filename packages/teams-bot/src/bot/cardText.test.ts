import { DOWNLOAD_FAILED, INGESTION_FAILED, escapeMarkdown, rejectionText } from './cardText';

describe('escapeMarkdown', () => {
  it('renders a markdown link in a filename literally', () => {
    expect(escapeMarkdown('[x](https://evil)')).toBe('\\[x\\]\\(https://evil\\)');
  });

  it.each(['[', ']', '(', ')', '*', '_', '~', '`', '\\', '<', '>', '#'])(
    'escapes %s wherever it appears',
    (ch) => {
      expect(escapeMarkdown(`a${ch}b`)).toBe(`a\\${ch}b`);
    },
  );

  it.each([
    ['- item', '\\- item'],
    ['+ item', '\\+ item'],
    ['-', '\\-'],
    ['  - indented', '  \\- indented'],
    ['1. first', '1\\. first'],
    ['12.', '12\\.'],
    ['1) first', '1\\) first'],
    ['# heading', '\\# heading'],
    ['> quote', '\\> quote'],
    ['* bullet', '\\* bullet'],
  ])('escapes the leading marker in %p', (input, output) => {
    expect(escapeMarkdown(input)).toBe(output);
  });

  it.each(['2026.pdf', '-v2.pdf', 'a-b+c.pdf', 'Faktura 03/2026'])(
    'leaves %p alone (not a markdown construct)',
    (input) => {
      expect(escapeMarkdown(input)).toBe(input);
    },
  );

  it('keeps Polish characters and emoji intact', () => {
    expect(escapeMarkdown('Zażółć gęślą jaźń 📄.pdf')).toBe('Zażółć gęślą jaźń 📄.pdf');
  });

  it('collapses newlines so a value cannot start its own markdown block', () => {
    // The `-` is no longer at the start of a line, so it is no list marker.
    expect(escapeMarkdown('a.pdf\n\n- [klik](https://evil)')).toBe(
      'a.pdf - \\[klik\\]\\(https://evil\\)',
    );
    expect(escapeMarkdown('\r\n- x')).toBe(' \\- x');
  });

  it('removes bidi overrides and line separators', () => {
    const rlo = String.fromCodePoint(0x202e);
    const lineSep = String.fromCodePoint(0x2028);
    expect(escapeMarkdown(`faktura${rlo}fdp.exe`)).toBe('faktura fdp.exe');
    expect(escapeMarkdown(`a${lineSep}b`)).toBe('a b');
  });

  it('escapes each backslash once, so an escape cannot be cancelled', () => {
    expect(escapeMarkdown('\\[x]')).toBe('\\\\\\[x\\]');
  });
});

describe('rejectionText', () => {
  it('has a distinct Polish message for each known code', () => {
    const codes = [DOWNLOAD_FAILED, INGESTION_FAILED, 'ValidationError', 'SharePointError'];
    const texts = codes.map(rejectionText);
    expect(new Set(texts).size).toBe(codes.length);
    expect(texts).not.toContain(rejectionText('SomethingElse'));
  });

  it('falls back to a generic message for unknown or missing codes', () => {
    expect(rejectionText(undefined)).toBe(rejectionText('InternalError'));
    expect(rejectionText('toString')).toBe(rejectionText(undefined));
    expect(rejectionText(undefined)).toMatch(/Spróbuj ponownie/);
  });
});
