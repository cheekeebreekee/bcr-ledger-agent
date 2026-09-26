import { PDFDocument } from 'pdf-lib';
import { PDF_PAGE_LIMIT, PDF_PREVIEW_PAGES, pdfForModel } from './pdfPreview';

/** A synthetic PDF of `pages` pages, each saying its own number. */
async function syntheticPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([200, 200]).drawText(`Strona ${i}`, { x: 20, y: 100, size: 12 });
  }
  return Buffer.from(await doc.save());
}

describe('pdfForModel', () => {
  it('sends a PDF within the limit whole', async () => {
    expect(await pdfForModel(await syntheticPdf(PDF_PAGE_LIMIT))).toEqual({ kind: 'whole' });
  });

  it('sends the first 20 pages of a longer PDF, and leaves the original untouched', async () => {
    const original = await syntheticPdf(PDF_PAGE_LIMIT + 1);
    const before = Buffer.from(original);

    const prepared = await pdfForModel(original);

    expect(prepared).toMatchObject({
      kind: 'first_pages',
      pages: PDF_PREVIEW_PAGES,
      pageCount: 101,
    });
    if (prepared.kind !== 'first_pages') throw new Error('expected a preview');
    const preview = await PDFDocument.load(prepared.content);
    expect(preview.getPageCount()).toBe(PDF_PREVIEW_PAGES);
    expect(original.equals(before)).toBe(true);
  });

  it('honours other limits', async () => {
    const prepared = await pdfForModel(await syntheticPdf(5), { pageLimit: 3, previewPages: 2 });
    expect(prepared).toMatchObject({ kind: 'first_pages', pages: 2, pageCount: 5 });
  });

  it('sends a file whose pages cannot be counted as it is', async () => {
    expect(await pdfForModel(Buffer.from('%PDF-1.7 not really a pdf'))).toEqual({ kind: 'whole' });
  });

  it('reports an encrypted long PDF as not trimmable', async () => {
    const encrypted = await PDFDocument.create();
    for (let i = 0; i < 4; i += 1) encrypted.addPage();
    Object.defineProperty(encrypted, 'isEncrypted', { value: true });
    const load = jest.spyOn(PDFDocument, 'load').mockResolvedValueOnce(encrypted);
    expect(await pdfForModel(Buffer.from('%PDF-1.7'), { pageLimit: 3 })).toEqual({
      kind: 'trim_failed',
      pageCount: 4,
    });
    load.mockRestore();
  });

  it('reports a copy that fails as not trimmable', async () => {
    const pdf = await syntheticPdf(4);
    const create = jest.spyOn(PDFDocument, 'create').mockRejectedValueOnce(new Error('broken'));
    expect(await pdfForModel(pdf, { pageLimit: 3 })).toEqual({ kind: 'trim_failed', pageCount: 4 });
    create.mockRestore();
  });
});
