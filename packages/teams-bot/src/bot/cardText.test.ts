import { CLIENT_ACCOUNT_REQUIRED } from '@bcr/shared';
import {
  DOWNLOAD_FAILED,
  escapeMarkdown,
  GATE_REFUSAL_TEXT,
  INGESTION_FAILED,
  QUARANTINED_TEXT,
  rejectionText,
  SEARCH_NO_ACCESS_TEXT,
} from './cardText';

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
    const codes = [
      DOWNLOAD_FAILED,
      INGESTION_FAILED,
      'ValidationError',
      'SharePointError',
      'RetryLater',
      CLIENT_ACCOUNT_REQUIRED,
    ];
    const texts = codes.map(rejectionText);
    expect(new Set(texts).size).toBe(codes.length);
    expect(texts).not.toContain(rejectionText('SomethingElse'));
  });

  it('tells a refused account (ClientAccountRequired) to sign in with the NIP@ account', () => {
    expect(CLIENT_ACCOUNT_REQUIRED).toBe('ClientAccountRequired');
    expect(rejectionText(CLIENT_ACCOUNT_REQUIRED)).toBe(
      'Tego pliku nie mogę przyjąć z tego konta. Asystent działa tylko na koncie, które BCR ' +
        'założyło dla Twojej firmy (login: NIP@bcr-group.pl) — zaloguj się na nie i wyślij plik ' +
        'ponownie.',
    );
  });

  it('keeps RetryLater’s text, which also answers an account ingestion could not read', () => {
    expect(rejectionText('RetryLater')).toBe(
      'Nie zdążyłem przetworzyć tego pliku. Wyślij go ponownie za chwilę.',
    );
  });

  it('falls back to a generic message for unknown or missing codes', () => {
    expect(rejectionText(undefined)).toBe(rejectionText('InternalError'));
    expect(rejectionText('toString')).toBe(rejectionText(undefined));
    expect(rejectionText(undefined)).toMatch(/Spróbuj ponownie/);
  });
});

describe('fixed texts after the account decision (28 Sep 2026)', () => {
  it('gives search one no-access answer that names the NIP@ account and no reason', () => {
    expect(SEARCH_NO_ACCESS_TEXT).toBe(
      'Wyszukiwanie dokumentów działa tylko na koncie, które BCR założyło dla Twojej firmy ' +
        '(login: NIP@bcr-group.pl). Jeśli korzystasz z tego konta, skontaktuj się z zespołem BCR.',
    );
  });

  it('keeps the quarantine and gate texts as they were', () => {
    expect(QUARANTINED_TEXT).toBe('Dokument przekazano do weryfikacji przez zespół BCR.');
    expect(GATE_REFUSAL_TEXT).toBe('Nie mogę przyjąć tej wiadomości.');
  });
});
