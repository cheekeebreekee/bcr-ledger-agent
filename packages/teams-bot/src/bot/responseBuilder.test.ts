import { createHash } from 'node:crypto';
import type { IngestionBatchItemResult, IngestionUploadResult } from '@bcr/shared';
import {
  QUARANTINED_TEXT,
  rejectionText,
  SEARCH_COVERAGE_TEXT,
  SEARCH_HELP_HEADING,
  SEARCH_HELP_TEXT,
} from './cardText';
import { buildBatchResultCard, buildHelpCard } from './responseBuilder';

const result: IngestionUploadResult = {
  driveItemId: 'item-1',
  webUrl: 'https://example.sharepoint.test/item-1',
  folderPath: '01_Faktury/02_Faktury_zakupu/2026/03',
  finalFilename: 'Invoice_03_2026.pdf',
  classification: {
    documentType: 'Faktura zakupu',
    confidence: 0.95,
    categoryId: 'faktury_zakupu',
    classifier: 'claude',
  },
};

const uploaded: IngestionBatchItemResult = {
  filename: 'Invoice_03_2026.pdf',
  status: 'uploaded',
  result,
};

const quarantined: IngestionBatchItemResult = {
  filename: 'skan.pdf',
  status: 'quarantined',
};

const rejected = (
  code: string,
  message = 'internal detail /sites/OtherClient',
): IngestionBatchItemResult => ({
  filename: 'broken.pdf',
  status: 'rejected',
  error: { code, message },
});

interface TextItem {
  readonly type: string;
  readonly text?: string;
  readonly actions?: { type: string; title: string; url: string }[];
}

interface TableRow {
  readonly type: 'TableRow';
  readonly cells: { items: TextItem[] }[];
}

interface Card {
  readonly body: { type: string; text?: string; rows?: TableRow[] }[];
  readonly actions?: unknown[];
}

function card(results: readonly IngestionBatchItemResult[]): Card {
  return buildBatchResultCard(results) as Card;
}

function tableRows(c: Card): TableRow[] {
  const table = c.body.find((b) => b.type === 'Table');
  if (!table?.rows) throw new Error('no table in card');
  return table.rows;
}

/** The text of each cell's first TextBlock, row by row. */
function cellTexts(c: Card): (string | undefined)[][] {
  return tableRows(c).map((row) => row.cells.map((cell) => cell.items[0]?.text));
}

function openUrlActions(c: Card): { title: string; url: string }[] {
  return tableRows(c).flatMap((row) =>
    row.cells.flatMap((cell) =>
      cell.items.flatMap((item) =>
        item.type === 'ActionSet'
          ? (item.actions ?? []).filter((a) => a.type === 'Action.OpenUrl')
          : [],
      ),
    ),
  );
}

/** Every object key anywhere in a JSON value. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)]);
  }
  return [];
}

describe('buildBatchResultCard', () => {
  it('has the header Dokument | Kategoria | Folder and one row per document, in order', () => {
    const c = card([uploaded, quarantined, rejected('SharePointError')]);
    const texts = cellTexts(c);
    expect(texts[0]).toEqual(['Dokument', 'Kategoria', 'Folder']);
    expect(texts).toHaveLength(4);
    expect(texts[1]?.[0]).toBe('✅ Invoice\\_03\\_2026.pdf');
    expect(texts[2]?.[0]).toBe('📨 skan.pdf');
    expect(texts[3]?.[0]).toBe('⚠️ broken.pdf');
  });

  it('never has a confidence or reasoning column', () => {
    const json = JSON.stringify(card([uploaded]));
    expect(json).not.toMatch(/Pewność|Uzasadnienie|95%/);
  });

  it('shows the category label and folder for an uploaded document, with one open button', () => {
    const c = card([uploaded]);
    const [, row] = cellTexts(c);
    expect(row).toEqual([
      '✅ Invoice\\_03\\_2026.pdf',
      'Faktura zakupu',
      '01\\_Faktury/02\\_Faktury\\_zakupu/2026/03',
    ]);
    expect(openUrlActions(c)).toEqual([
      { type: 'Action.OpenUrl', title: 'Otwórz', url: 'https://example.sharepoint.test/item-1' },
    ]);
  });

  it('adds no card-level actions (buttons live in their rows)', () => {
    expect(card([uploaded]).actions).toBeUndefined();
  });

  it('gives a quarantined document the fixed line and no link, folder or category', () => {
    const c = card([quarantined]);
    const [, row] = cellTexts(c);
    expect(row).toEqual(['📨 skan.pdf', QUARANTINED_TEXT, '—']);
    expect(openUrlActions(c)).toHaveLength(0);
  });

  it('ignores a result smuggled onto a quarantined item', () => {
    const leaky = { ...quarantined, result } as IngestionBatchItemResult;
    const json = JSON.stringify(card([leaky]));
    expect(json).not.toContain('example.sharepoint.test');
    expect(json).not.toContain('Faktury');
    expect(json).not.toContain('Faktura zakupu');
  });

  it.each(['DownloadFailed', 'IngestionFailed', 'ValidationError', 'SharePointError', 'Weird'])(
    'renders a rejected %s row with the generic Polish text, never the raw message',
    (code) => {
      const c = card([rejected(code)]);
      const [, row] = cellTexts(c);
      expect(row).toEqual(['⚠️ broken.pdf', rejectionText(code), '—']);
      expect(JSON.stringify(c)).not.toContain('OtherClient');
    },
  );

  it('treats a rejected row without an error as a generic failure', () => {
    const c = card([{ filename: 'x.pdf', status: 'rejected' }]);
    expect(cellTexts(c)[1]?.[1]).toBe(rejectionText(undefined));
  });

  it('treats an "uploaded" item without a result as a failure, not a success', () => {
    const c = card([{ filename: 'x.pdf', status: 'uploaded' }]);
    expect(cellTexts(c)[1]?.[0]).toBe('⚠️ x.pdf');
    expect(c.body[1]?.text).toContain('Zarchiwizowano: 0');
    expect(c.body[1]?.text).toContain('Odrzucono: 1');
  });

  it('counts uploaded, quarantined and rejected documents in the summary line', () => {
    const c = card([uploaded, uploaded, quarantined, rejected('X')]);
    expect(c.body[0]?.text).toBe('📊 Podsumowanie archiwizacji (4 dok.)');
    expect(c.body[1]?.text).toBe(
      'Zarchiwizowano: 2  •  Przekazano do weryfikacji: 1  •  Odrzucono: 1',
    );
  });

  it('renders a markdown link in a filename literally', () => {
    const evil = '[x](https://evil)';
    const c = card([
      { ...uploaded, filename: evil, result: { ...result, finalFilename: evil } },
      { filename: evil, status: 'quarantined' },
      { filename: evil, status: 'rejected', error: { code: 'X', message: evil } },
    ]);
    const texts = cellTexts(c)
      .slice(1)
      .map((r) => r[0]);
    expect(texts).toEqual([
      '✅ \\[x\\]\\(https://evil\\)',
      '📨 \\[x\\]\\(https://evil\\)',
      '⚠️ \\[x\\]\\(https://evil\\)',
    ]);
    expect(JSON.stringify(c)).not.toContain('[x](https://evil)');
  });

  it('escapes the category label and folder too', () => {
    const c = card([
      {
        ...uploaded,
        result: {
          ...result,
          folderPath: '[a](https://evil)',
          classification: { ...result.classification, documentType: '**x**' },
        },
      },
    ]);
    const [, row] = cellTexts(c);
    expect(row?.[1]).toBe('\\*\\*x\\*\\*');
    expect(row?.[2]).toBe('\\[a\\]\\(https://evil\\)');
  });

  it('carries no reasoning anywhere, even if ingestion sends one', () => {
    const withReasoning = {
      ...uploaded,
      result: {
        ...result,
        classification: {
          ...result.classification,
          reasoning: 'Kontrahent to ACME, NIP 0000000000',
        },
      },
    } as IngestionBatchItemResult;
    const c = card([withReasoning]);
    expect(allKeys(c)).not.toContain('reasoning');
    expect(JSON.stringify(c)).not.toContain('ACME');
  });

  it.each(['javascript:alert(1)', 'http://example.sharepoint.test/x', 'not a url'])(
    'drops the open button for a non-https link (%s)',
    (webUrl) => {
      const c = card([{ ...uploaded, result: { ...result, webUrl } }]);
      expect(openUrlActions(c)).toHaveLength(0);
      expect(cellTexts(c)[1]?.[0]).toBe('✅ Invoice\\_03\\_2026.pdf');
    },
  );

  it('renders an empty batch as a header-only table', () => {
    const c = card([]);
    expect(tableRows(c)).toHaveLength(1);
    expect(c.body[0]?.text).toContain('(0 dok.)');
  });
});

describe('buildHelpCard', () => {
  const text = JSON.stringify(buildHelpCard());

  it('no longer promises a reasoning for the choice', () => {
    expect(text).not.toMatch(/uzasadnieni/i);
  });

  it('says unclassifiable documents go to Nieposortowane in the own team, checked by an accountant', () => {
    expect(text).toContain('„Nieposortowane” w Twoim zespole');
    expect(text).toContain('księgowego');
  });

  it('says where the files are: team → Dokumenty księgowe → Udostępnione', () => {
    expect(text).toContain('kanał „Dokumenty księgowe” → karta „Udostępnione”');
  });

  // Teams lets a guest attach files to channel posts only, so clients are
  // sent to their channel first; the chat is for whoever can attach.
  it('sends clients to their Team’s Dokumenty księgowe channel: a post with an attachment, or Udostępnione', () => {
    const blocks = (buildHelpCard() as Card).body.map((b) => b.text ?? '');
    const first = blocks[1] ?? '';
    expect(first).toContain('w kanale „Dokumenty księgowe”');
    expect(first).toContain('załącznik do wpisu w kanale');
    expect(first).toContain('na karcie „Udostępnione”');
    expect(first).toContain('w tym samym kanale');
  });

  it('says guests cannot attach files in this chat, and keeps the chat for whoever can', () => {
    expect(text).toContain('Goście (konta spoza BCR) nie mogą dołączać plików w tym czacie');
    expect(text).toContain('Jeśli możesz dołączyć plik tutaj, wyślij go w tym prywatnym czacie');
  });

  it('inserts nothing: every block is fixed text with no markdown link', () => {
    const blocks = (buildHelpCard() as Card).body.map((b) => b.text ?? '');
    const offenders = blocks.filter((t) => /\]\(|<|\{/.test(t));
    expect(offenders).toEqual([]);
  });
});

describe('buildHelpCard with search', () => {
  /** SHA-256 of the help card's JSON before search existed (HEAD b9d0182). */
  const HELP_CARD_SHA256 = '85be6ea3de384bffdfd9ddc6d4bfe971b849c0ff8039f270f0647a8ad2ec154a';
  const sha256 = (card: unknown) =>
    createHash('sha256').update(JSON.stringify(card), 'utf8').digest('hex');

  it('is, with search off, byte for byte the card from before search', () => {
    expect(sha256(buildHelpCard())).toBe(HELP_CARD_SHA256);
    expect(sha256(buildHelpCard({}))).toBe(HELP_CARD_SHA256);
    expect(sha256(buildHelpCard({ search: false }))).toBe(HELP_CARD_SHA256);
  });

  it('adds only a fixed „Wyszukiwanie” section at the end with search on', () => {
    const before = (buildHelpCard() as Card).body;
    const after = (buildHelpCard({ search: true }) as Card).body;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((b) => b.text)).toEqual([
      SEARCH_HELP_HEADING,
      SEARCH_HELP_TEXT,
      SEARCH_COVERAGE_TEXT,
    ]);
    expect(SEARCH_HELP_TEXT).toContain('„faktury zakupu z marca 2026”');
    expect(JSON.stringify(after)).not.toMatch(/\]\(/);
  });
});
