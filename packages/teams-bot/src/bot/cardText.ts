/**
 * Every piece of text the bot shows a user, and the one function that makes
 * a value safe to put inside it.
 *
 * Values that reach a card (filenames, category labels, folder paths) are
 * partly user-controlled: a filename such as `[Zobacz](https://evil.example)`
 * would otherwise render as a clickable link inside a card the bot signed.
 * So every inserted value goes through `escapeMarkdown()`, and every message
 * is a fixed Polish string chosen by code — never an exception's text, never
 * model output.
 */

/** Markdown metacharacters Teams' Adaptive Card renderer interprets inline. */
const INLINE_MARKDOWN = /[\\`*_~[\]()<>#]/g;

/**
 * Control characters (including CR/LF), Unicode line/paragraph separators and
 * bidi overrides. A newline would let a value start its own markdown block
 * (list, heading, quote); a bidi override would let `faktura<U+202E>fdp.exe` pose as
 * a PDF. They carry no meaning in a filename, so they collapse to a space.
 */
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/**
 * A list marker at the start of the value: `-`/`+` or an ordered number with
 * `.`, followed by whitespace or the end (CommonMark's rule, so `2026.pdf`
 * and `-v2` stay untouched). `*`, `#`, `>` and `1)` are already escaped by
 * the inline set wherever they appear.
 */
const LEADING_BULLET_MARKER = /^(\s*)([-+])(?=\s|$)/;
const LEADING_ORDERED_MARKER = /^(\s*\d+)(\.)(?=\s|$)/;

/**
 * Escapes a value for insertion into an Adaptive Card `TextBlock` so it
 * renders literally: collapses control/bidi characters to a space, escapes
 * `[ ] ( ) * _ ~ ` \ < > #` anywhere, and escapes a leading list marker.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(CONTROL_AND_BIDI, ' ')
    .replace(INLINE_MARKDOWN, (ch) => `\\${ch}`)
    .replace(LEADING_BULLET_MARKER, '$1\\$2')
    .replace(LEADING_ORDERED_MARKER, '$1\\$2');
}

// ---------------------------------------------------------------------------
// Fixed Polish strings
// ---------------------------------------------------------------------------

export const QUARANTINED_TEXT = 'Dokument przekazano do weryfikacji przez zespół BCR.';

/** Sent once, only in a 1:1 chat, when the gate refuses a message in enforce mode. */
export const GATE_REFUSAL_TEXT = 'Nie mogę przyjąć tej wiadomości.';

/** Sent by the adapter's `onTurnError`, only in a 1:1 chat. Never carries error text. */
export const TURN_ERROR_TEXT =
  '⚠️ Coś poszło nie tak po mojej stronie. Spróbuj ponownie za chwilę. ' +
  'Jeśli problem się powtórzy, skontaktuj się z zespołem BCR.';

/**
 * Codes the bot itself assigns to a rejected row. Ingestion's own codes
 * (`ValidationError`, `SharePointError`, …) arrive in `error.code` as well.
 */
export const DOWNLOAD_FAILED = 'DownloadFailed';
export const INGESTION_FAILED = 'IngestionFailed';

const REJECTION_TEXT: ReadonlyMap<string, string> = new Map([
  [DOWNLOAD_FAILED, 'Nie udało się pobrać pliku z czatu. Wyślij go ponownie.'],
  [INGESTION_FAILED, 'Usługa archiwizacji jest chwilowo niedostępna. Spróbuj ponownie za chwilę.'],
  [
    'ValidationError',
    'Tego pliku nie można przyjąć (nieobsługiwany typ, zbyt duży rozmiar lub nieprawidłowa nazwa).',
  ],
  ['SharePointError', 'Nie udało się zapisać pliku. Spróbuj ponownie za chwilę.'],
  // Ingestion ran out of time for this batch and did not start the file.
  ['RetryLater', 'Nie zdążyłem przetworzyć tego pliku. Wyślij go ponownie za chwilę.'],
]);

const DEFAULT_REJECTION_TEXT =
  'Nie udało się zarchiwizować pliku. Spróbuj ponownie lub skontaktuj się z zespołem BCR.';

/**
 * The Polish message for a rejected document, chosen by error code alone.
 * The error's `message` is deliberately never an input: it may carry
 * internal detail (hosts, paths, other clients' names) or echo the upload.
 */
export function rejectionText(code: string | undefined): string {
  return (code === undefined ? undefined : REJECTION_TEXT.get(code)) ?? DEFAULT_REJECTION_TEXT;
}
