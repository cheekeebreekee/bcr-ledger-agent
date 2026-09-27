import { PDFDocument } from 'pdf-lib';

/**
 * Pages above which a PDF is sent as an excerpt, to save tokens: every page
 * is about as many input tokens as the whole prompt. What decides a category,
 * a month and a party is on the first pages (the invoice header, the
 * statement's period, the contract's title), and an invoice's totals are on
 * the last. On the 2026-09-26 test set this sends 86 pages instead of 129.
 */
export const PDF_EXCERPT_ABOVE_PAGES = 5;

/** How many leading pages an excerpt keeps; the last page is added to them. */
export const PDF_EXCERPT_LEADING_PAGES = 4;

/**
 * Pages above which a PDF can never be sent whole. The API refused the
 * 167-page insurance terms of the 2026-09-26 evaluation ("A maximum of 100
 * PDF pages may be provided") on the 200k-context model. Up to this limit, a
 * PDF whose excerpt cannot be made (encrypted) is sent whole; above it, it
 * cannot be classified.
 */
export const PDF_PAGE_LIMIT = 100;

/** What to send the model for one PDF. The original bytes are never changed. */
export type PdfForModel =
  /** Send the original: short enough, or its pages could not be counted, or no excerpt could be made. */
  | { readonly kind: 'whole' }
  /**
   * Send `content`: a new PDF of the first {@link PDF_EXCERPT_LEADING_PAGES}
   * pages and the last one, `pages` in all, of `pageCount`.
   */
  | {
      readonly kind: 'excerpt';
      readonly content: Buffer;
      readonly pages: number;
      readonly pageCount: number;
    }
  /** Over {@link PDF_PAGE_LIMIT}, and no excerpt could be made (encrypted, or the copy failed). */
  | { readonly kind: 'trim_failed'; readonly pageCount: number };

export interface PdfPreviewOptions {
  readonly excerptAbovePages?: number;
  readonly leadingPages?: number;
  readonly pageLimit?: number;
}

/**
 * Decides what of a PDF the classifier sends. A PDF over
 * {@link PDF_EXCERPT_ABOVE_PAGES} pages is replaced, for the model only, by
 * an in-memory copy of its first pages and its last; the document that gets
 * filed is always the original. A PDF whose pages cannot be counted is sent
 * as it is (the API is the judge). Never throws.
 */
export async function pdfForModel(
  content: Buffer,
  opts: PdfPreviewOptions = {},
): Promise<PdfForModel> {
  const excerptAbove = opts.excerptAbovePages ?? PDF_EXCERPT_ABOVE_PAGES;
  const leading = opts.leadingPages ?? PDF_EXCERPT_LEADING_PAGES;
  const pageLimit = opts.pageLimit ?? PDF_PAGE_LIMIT;

  let source: PDFDocument;
  let pageCount: number;
  try {
    source = await PDFDocument.load(content, { ignoreEncryption: true, updateMetadata: false });
    // pdf-lib parses leniently: a broken file can load and fail only here.
    pageCount = source.getPageCount();
  } catch {
    return { kind: 'whole' };
  }
  if (pageCount <= excerptAbove) return { kind: 'whole' };
  // Could not be shortened: whole while the API takes it, else unclassifiable.
  const cannotShorten = (): PdfForModel =>
    pageCount <= pageLimit ? { kind: 'whole' } : { kind: 'trim_failed', pageCount };
  // An encrypted file's page contents stay encrypted in a copy: unreadable.
  if (source.isEncrypted) return cannotShorten();

  try {
    const copy = await PDFDocument.create({ updateMetadata: false });
    const indices = excerptPages(pageCount, leading);
    for (const page of await copy.copyPages(source, indices)) copy.addPage(page);
    const bytes = await copy.save();
    return { kind: 'excerpt', content: Buffer.from(bytes), pages: indices.length, pageCount };
  } catch {
    return cannotShorten();
  }
}

/** Zero-based: the first `leading` pages, then the last page if it is not among them. */
export function excerptPages(pageCount: number, leading: number): number[] {
  const first = Array.from({ length: Math.min(Math.max(leading, 1), pageCount) }, (_, i) => i);
  const last = pageCount - 1;
  return first.includes(last) ? first : [...first, last];
}
