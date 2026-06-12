/**
 * Filename-pattern registry. Each entry says:
 *   - how to recognise a filename (regex)
 *   - how to turn the captured groups into a SharePoint folder path
 *   - what document type to report back to the user
 *
 * Patterns are evaluated in declaration order; the first match wins. Add new
 * patterns by appending to {@link defaultPatterns}.
 *
 * Capture groups are referenced by name. All months/days are normalised to
 * two digits and years to four digits, so the resulting folder names sort
 * lexicographically.
 */
export interface FilenamePattern {
  /** Human-readable identifier, e.g. `"invoice-month-year"`. */
  readonly id: string;
  /** Logical document type returned in {@link Classification}. */
  readonly documentType: string;
  /** Regex with **named** capture groups. Case-insensitive recommended. */
  readonly regex: RegExp;
  /**
   * Build the folder path from the named groups. Receives an already-normalised
   * record where dates have been zero-padded for you.
   */
  buildPath(groups: Readonly<Record<string, string>>): string;
  /**
   * Confidence to assign when this pattern matches. Defaults to 0.95.
   * Use lower values for permissive patterns where you want AI fallback to
   * still get a chance to override.
   */
  readonly confidence?: number;
}

/** Built-in patterns. Add tenant-specific ones via {@link PatternRegistry.register}. */
export const defaultPatterns: readonly FilenamePattern[] = [
  {
    id: 'invoice-month-year',
    documentType: 'Invoice',
    regex: /^Invoice[_-](?<month>0?[1-9]|1[0-2])[_-](?<year>\d{4})/i,
    buildPath: ({ year, month }) => `Invoices/${year}/${month}`,
  },
  {
    id: 'receipt-iso-date',
    documentType: 'Receipt',
    regex: /^Receipt[_-](?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])/i,
    buildPath: ({ year, month }) => `Receipts/${year}/${month}`,
  },
  {
    id: 'contract-counterparty-year',
    documentType: 'Contract',
    regex: /^Contract[_-](?<counterparty>[A-Za-z0-9]+)[_-](?<year>\d{4})/i,
    buildPath: ({ year, counterparty }) => `Contracts/${year}/${counterparty}`,
  },
  {
    id: 'statement-account-month-year',
    documentType: 'Statement',
    regex:
      /^Statement[_-](?<account>[A-Za-z0-9]+)[_-](?<year>\d{4})[_-](?<month>0?[1-9]|1[0-2])/i,
    buildPath: ({ account, year, month }) => `Statements/${account}/${year}/${month}`,
  },
  {
    id: 'report-quarter-year',
    documentType: 'Report',
    regex: /^Report[_-]Q(?<quarter>[1-4])[_-](?<year>\d{4})/i,
    buildPath: ({ year, quarter }) => `Reports/${year}/Q${quarter}`,
  },
];
