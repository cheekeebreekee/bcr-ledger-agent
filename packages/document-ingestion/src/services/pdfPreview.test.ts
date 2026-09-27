import { PDFDocument } from 'pdf-lib';
import {
  excerptPages,
  PDF_EXCERPT_ABOVE_PAGES,
  PDF_EXCERPT_LEADING_PAGES,
  PDF_PAGE_LIMIT,
  pdfForModel,
} from './pdfPreview';

/** A synthetic PDF of `pages` pages, each saying its own number. */
async function syntheticPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([200 + i, 200]).drawText(`Strona ${i}`, { x: 20, y: 100, size: 12 });
  }
  return Buffer.from(await doc.save());
}

/** Each page is 200 + its number wide, so a copy's pages say where they came from. */
async function pageNumbersOf(pdf: Buffer): Promise<number[]> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => p.getWidth() - 200);
}

describe('pdfForModel', () => {
  it('sends a PDF of up to 5 pages whole', async () => {
    expect(await pdfForModel(await syntheticPdf(PDF_EXCERPT_ABOVE_PAGES))).toEqual({
      kind: 'whole',
    });
  });

  it('sends a longer PDF as its first 4 pages and its last, and leaves the original untouched', async () => {
    const original = await syntheticPdf(33);
    const before = Buffer.from(original);

    const prepared = await pdfForModel(original);

    expect(prepared).toMatchObject({ kind: 'excerpt', pages: 5, pageCount: 33 });
    if (prepared.kind !== 'excerpt') throw new Error('expected an excerpt');
    expect(await pageNumbersOf(prepared.content)).toEqual([1, 2, 3, 4, 33]);
    expect(original.equals(before)).toBe(true);
  });

  // The 167-page insurance terms of the 2026-09-26 evaluation: 5 pages, not 20.
  it('sends a PDF over the API’s 100-page limit as an excerpt too', async () => {
    const prepared = await pdfForModel(await syntheticPdf(PDF_PAGE_LIMIT + 1));
    expect(prepared).toMatchObject({ kind: 'excerpt', pages: 5, pageCount: 101 });
  });

  it('honours other limits', async () => {
    const prepared = await pdfForModel(await syntheticPdf(6), {
      excerptAbovePages: 3,
      leadingPages: 2,
    });
    expect(prepared).toMatchObject({ kind: 'excerpt', pages: 3, pageCount: 6 });
    if (prepared.kind !== 'excerpt') throw new Error('expected an excerpt');
    expect(await pageNumbersOf(prepared.content)).toEqual([1, 2, 6]);
  });

  it('sends a file whose pages cannot be counted as it is', async () => {
    expect(await pdfForModel(Buffer.from('%PDF-1.7 not really a pdf'))).toEqual({ kind: 'whole' });
  });

  describe('when no excerpt can be made', () => {
    async function encrypted(pages: number): Promise<jest.SpyInstance> {
      const doc = await PDFDocument.create();
      for (let i = 0; i < pages; i += 1) doc.addPage();
      Object.defineProperty(doc, 'isEncrypted', { value: true });
      return jest.spyOn(PDFDocument, 'load').mockResolvedValueOnce(doc);
    }

    // An owner-password PDF (a bank statement) must not lose its
    // classification just because it cannot be shortened.
    it('sends an encrypted PDF within the API limit whole', async () => {
      const load = await encrypted(40);
      expect(await pdfForModel(Buffer.from('%PDF-1.7'))).toEqual({ kind: 'whole' });
      load.mockRestore();
    });

    it('reports an encrypted PDF over the API limit as not trimmable', async () => {
      const load = await encrypted(PDF_PAGE_LIMIT + 1);
      expect(await pdfForModel(Buffer.from('%PDF-1.7'))).toEqual({
        kind: 'trim_failed',
        pageCount: PDF_PAGE_LIMIT + 1,
      });
      load.mockRestore();
    });

    it('sends the whole PDF when the copy fails within the API limit', async () => {
      const pdf = await syntheticPdf(8);
      const create = jest.spyOn(PDFDocument, 'create').mockRejectedValueOnce(new Error('broken'));
      expect(await pdfForModel(pdf)).toEqual({ kind: 'whole' });
      create.mockRestore();
    });

    it('reports a copy that fails over the API limit as not trimmable', async () => {
      const pdf = await syntheticPdf(8);
      const create = jest.spyOn(PDFDocument, 'create').mockRejectedValueOnce(new Error('broken'));
      expect(await pdfForModel(pdf, { pageLimit: 7 })).toEqual({
        kind: 'trim_failed',
        pageCount: 8,
      });
      create.mockRestore();
    });
  });
});

describe('excerptPages', () => {
  it('takes the leading pages and the last one', () => {
    expect(excerptPages(33, PDF_EXCERPT_LEADING_PAGES)).toEqual([0, 1, 2, 3, 32]);
  });

  it('never repeats the last page, and never goes past the end', () => {
    expect(excerptPages(4, 4)).toEqual([0, 1, 2, 3]);
    expect(excerptPages(2, 4)).toEqual([0, 1]);
    expect(excerptPages(5, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps at least the first page', () => {
    expect(excerptPages(9, 0)).toEqual([0, 8]);
  });
});
