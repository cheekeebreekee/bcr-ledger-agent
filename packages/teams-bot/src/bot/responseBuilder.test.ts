import type { IngestionBatchItemResult } from '@bcr/shared';
import { buildBatchResultCard } from './responseBuilder';

const uploaded: IngestionBatchItemResult = {
  filename: 'Invoice_03_2026.pdf',
  status: 'uploaded',
  result: {
    driveItemId: 'item-1',
    webUrl: 'https://sharepoint/item-1',
    folderPath: '01_Faktury/02_Faktury_zakupu/2026/03',
    finalFilename: 'Invoice_03_2026.pdf',
    classification: {
      documentType: 'Faktura zakupu',
      confidence: 0.95,
      classifier: 'claude',
      reasoning: 'Nabywcą jest klient, więc to faktura zakupu.',
    },
  },
};

const rejected: IngestionBatchItemResult = {
  filename: 'broken.pdf',
  status: 'rejected',
  error: { code: 'InternalError', message: 'Nie udało się przetworzyć pliku.' },
};

interface TableRow {
  readonly type: 'TableRow';
  readonly cells: { items: { text?: string }[] }[];
}

interface Card {
  readonly body: {
    type: string;
    text?: string;
    rows?: TableRow[];
  }[];
  readonly actions?: { type: string; title: string; url: string }[];
}

function findTable(card: Card): TableRow[] {
  const table = card.body.find((b) => b.type === 'Table');
  if (!table?.rows) throw new Error('no table in card');
  return table.rows;
}

describe('buildBatchResultCard', () => {
  it('renders one row per document plus a header row', () => {
    const card = buildBatchResultCard([uploaded, rejected]) as Card;
    const rows = findTable(card);
    // header + 2 documents
    expect(rows).toHaveLength(3);
  });

  it('shows the folder and reasoning for an uploaded document', () => {
    const card = buildBatchResultCard([uploaded]) as Card;
    const [, dataRow] = findTable(card);
    const cellText = dataRow.cells.map((c) => c.items[0]?.text);
    expect(cellText).toContain('01_Faktury/02_Faktury_zakupu/2026/03');
    expect(cellText).toContain('Nabywcą jest klient, więc to faktura zakupu.');
  });

  it('surfaces the error message for a rejected document', () => {
    const card = buildBatchResultCard([rejected]) as Card;
    const [, dataRow] = findTable(card);
    const cellText = dataRow.cells.map((c) => c.items[0]?.text);
    expect(cellText).toContain('Nie udało się przetworzyć pliku.');
  });

  it('adds an OpenUrl action only for successfully uploaded documents', () => {
    const card = buildBatchResultCard([uploaded, rejected]) as Card;
    expect(card.actions).toHaveLength(1);
    expect(card.actions?.[0]?.url).toBe('https://sharepoint/item-1');
  });

  it('omits actions when nothing was uploaded', () => {
    const card = buildBatchResultCard([rejected]) as Card;
    expect(card.actions).toBeUndefined();
  });
});
