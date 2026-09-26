import { PDFDocument } from 'pdf-lib';

/**
 * Pages above which a PDF is not sent whole. The API refused the 167-page
 * insurance terms of the 2026-09-26 evaluation ("A maximum of 100 PDF pages
 * may be provided") on the 200k-context model; on larger-context models the
 * limit is higher, but a 100+ page PDF would still cost hundreds of thousands
 * of input tokens and run past the 45 s timeout, for a category the first
 * pages already show.
 */
export const PDF_PAGE_LIMIT = 100;

/** How many leading pages a longer PDF is classified from. */
export const PDF_PREVIEW_PAGES = 20;

/** What to send the model for one PDF. The original bytes are never changed. */
export type PdfForModel =
  /** Send the original: within the limit, or its pages could not be counted. */
  | { readonly kind: 'whole' }
  /** Send `content`: a new PDF of the first {@link PDF_PREVIEW_PAGES} pages of `pageCount`. */
  | {
      readonly kind: 'first_pages';
      readonly content: Buffer;
      readonly pages: number;
      readonly pageCount: number;
    }
  /** Over the limit, and no shorter copy could be made (encrypted, or the copy failed). */
  | { readonly kind: 'trim_failed'; readonly pageCount: number };

export interface PdfPreviewOptions {
  readonly pageLimit?: number;
  readonly previewPages?: number;
}

/**
 * Decides what of a PDF the classifier sends. A PDF over the page limit is
 * replaced, for the model only, by an in-memory copy of its first pages; the
 * document that gets filed is always the original. A PDF whose pages cannot
 * be counted is sent as it is (the API is the judge). Never throws.
 */
export async function pdfForModel(
  content: Buffer,
  opts: PdfPreviewOptions = {},
): Promise<PdfForModel> {
  const pageLimit = opts.pageLimit ?? PDF_PAGE_LIMIT;
  const previewPages = opts.previewPages ?? PDF_PREVIEW_PAGES;

  let source: PDFDocument;
  let pageCount: number;
  try {
    source = await PDFDocument.load(content, { ignoreEncryption: true, updateMetadata: false });
    // pdf-lib parses leniently: a broken file can load and fail only here.
    pageCount = source.getPageCount();
  } catch {
    return { kind: 'whole' };
  }
  if (pageCount <= pageLimit) return { kind: 'whole' };
  // An encrypted file's page contents stay encrypted in a copy: unreadable.
  if (source.isEncrypted) return { kind: 'trim_failed', pageCount };

  try {
    const copy = await PDFDocument.create({ updateMetadata: false });
    const indices = Array.from({ length: Math.min(previewPages, pageCount) }, (_, i) => i);
    for (const page of await copy.copyPages(source, indices)) copy.addPage(page);
    const bytes = await copy.save();
    return {
      kind: 'first_pages',
      content: Buffer.from(bytes),
      pages: indices.length,
      pageCount,
    };
  } catch {
    return { kind: 'trim_failed', pageCount };
  }
}
