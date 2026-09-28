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

import {
  SEARCH_MAX_QUESTION_CHARS,
  SEARCH_PAGE_SIZE,
  SEARCH_TOTAL_CAP,
  type SearchNote,
} from '@bcr/shared';

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

// ---------------------------------------------------------------------------
// Client search: fixed Polish strings
// ---------------------------------------------------------------------------

/** The help card's search section; shown only when search is on. */
export const SEARCH_HELP_HEADING = 'Wyszukiwanie';
export const SEARCH_HELP_TEXT =
  'Napisz tutaj, jakich dokumentów szukasz, np. „faktury zakupu z marca 2026”, ' +
  '„faktury sprzedaży powyżej 5000 zł” albo „dokumenty w weryfikacji”. ' +
  'Pokażę dokumenty Twojej firmy z linkami do plików.';

/** Where the index's coverage starts; shown under every result list. */
export const SEARCH_COVERAGE_TEXT =
  'Wyszukiwarka obejmuje dokumenty zarchiwizowane przez asystenta od 28.09.2026; ' +
  'pliki z kanału pojawiają się po kilku minutach.';

/** One answer for every reason a user may not search: it names none of them. */
export const SEARCH_NO_ACCESS_TEXT =
  'Wyszukiwanie dokumentów jest dostępne tylko dla klientów BCR z przypisaną firmą. ' +
  'Jeśli to błąd, skontaktuj się z zespołem BCR.';

export const SEARCH_UNAVAILABLE_TEXT =
  'Wyszukiwarka jest chwilowo niedostępna. Spróbuj ponownie za chwilę albo użyj ' +
  '„Zmień filtr” w jednej z poprzednich wiadomości.';

/** The same, answering a question: the card it comes on carries the „Zmień filtr” form. */
export const SEARCH_UNAVAILABLE_QUESTION_TEXT =
  'Wyszukiwarka jest chwilowo niedostępna. Spróbuj ponownie za chwilę albo wybierz filtr ' +
  'w „Zmień filtr” poniżej.';

export const SEARCH_TOO_LONG_TEXT =
  `Pytanie jest za długie (najwyżej ${SEARCH_MAX_QUESTION_CHARS} znaków). ` +
  'Skróć je i wyślij ponownie.';

/** A „Zmień filtr” form (or a paging button) whose values cannot become a filter. */
export const SEARCH_FILTER_INVALID_TEXT =
  'Nie mogę użyć tego filtra. Miesiące wpisz jako RRRR-MM (np. 2026-03), kwoty jako liczby ' +
  '(np. 1500,00), NIP jako 10 cyfr, a walutę jako trzy litery (np. PLN). ' +
  '„Od” nie może być później niż „Do”, a kwota „od” nie może być większa niż „do”.';

const SEARCH_EXAMPLES =
  'Zapytaj np.: „faktury zakupu z marca 2026”, „faktury sprzedaży powyżej 5000 zł”, ' +
  '„wyciągi bankowe z ostatnich 3 miesięcy” albo „dokumenty w weryfikacji”.';

/** The question could not become a filter. */
export const SEARCH_NOT_UNDERSTOOD_TEXT =
  'Nie zrozumiałem pytania. Szukam dokumentów Twojej firmy po rodzaju, miesiącu, kwocie ' +
  `brutto, kontrahencie (nazwa lub NIP) albo numerze faktury. ${SEARCH_EXAMPLES}`;

/** The question asks what search does not do (sums, comparisons, advice). */
export const SEARCH_UNSUPPORTED_TEXT =
  'Wyszukuję dokumenty Twojej firmy, ale nie liczę sum, nie porównuję i nie doradzam. ' +
  SEARCH_EXAMPLES;

/** Ingestion's durable limits said, then when to try again (`HH:mm`, Warsaw time). */
export function searchRateLimitedText(clock: string): string {
  return (
    'Osiągnięto limit wyszukiwań: do 10 pytań w ciągu 5 minut i 60 na dobę ' +
    '(przeglądanie wyników i „Zmień filtr”: do 30 w ciągu 5 minut). ' +
    `Spróbuj ponownie o ${clock}.`
  );
}

/** The bot's own flood guard (per worker), with when to try again (`HH:mm`). */
export function searchFloodText(clock: string): string {
  return `Za dużo wyszukiwań w krótkim czasie. Spróbuj ponownie o ${clock}.`;
}

export const SEARCH_RESULTS_HEADING = '🔎 Wyniki wyszukiwania';
export const SEARCH_EMPTY_TEXT =
  'Nie znalazłem dokumentów pasujących do tego filtra. Użyj „Zmień filtr” albo zapytaj inaczej.';
/** What an empty filter means: „Zrozumiałem: najnowsze dokumenty”. */
export const SEARCH_EVERYTHING_TEXT = 'najnowsze dokumenty';
export const SEARCH_IN_REVIEW_LABEL = '(w weryfikacji)';
export const SEARCH_LINK_UNAVAILABLE_TEXT = 'Link niedostępny';

/** Fixed labels of the result card: prefixes, buttons and the „Zmień filtr” form. */
export const SEARCH_CARD_TEXT = {
  scopePrefix: 'Firma:',
  understoodPrefix: 'Zrozumiałem:',
  counterpartyPrefix: 'Kontrahent:',
  open: 'Otwórz',
  nextPage: `Pokaż kolejne ${SEARCH_PAGE_SIZE}`,
  changeFilter: 'Zmień filtr',
  submit: 'Szukaj',
  category: 'Kategoria',
  anyCategory: 'Wszystkie kategorie',
  monthFrom: 'Od (RRRR-MM)',
  monthTo: 'Do (RRRR-MM)',
  monthError: 'Wpisz miesiąc jako RRRR-MM, np. 2026-03.',
  grossMin: 'Kwota brutto od',
  grossMax: 'Kwota brutto do',
  currency: 'Waluta',
  nip: 'NIP kontrahenta',
  nipPlaceholder: '10 cyfr',
  counterpartyName: 'Nazwa kontrahenta',
  counterpartyNamePlaceholder: 'fragment nazwy',
  invoiceNumber: 'Numer faktury',
  status: 'Status',
  statusAny: 'Wszystkie',
  statusFiled: 'Zarchiwizowane',
  statusInReview: 'W weryfikacji',
} as const;

/** Why part of a question did not become a filter; fixed text per note code. */
export const SEARCH_NOTE_TEXT: Readonly<Record<SearchNote, string>> = {
  counterparty_name_dropped:
    'Pominąłem nazwę kontrahenta: nie znalazłem jej dosłownie w pytaniu. Wpisz ją w „Zmień filtr”.',
  invoice_number_dropped:
    'Pominąłem numer faktury: nie znalazłem go dosłownie w pytaniu. Wpisz go w „Zmień filtr”.',
  nip_dropped: 'Pominąłem NIP: to nie jest prawidłowy numer NIP.',
  period_clamped:
    'Okres ograniczyłem do obsługiwanego zakresu: od 2000 roku, najwyżej 10 lat naraz.',
  categories_in_review: 'Pominąłem kategorię: dokumenty w weryfikacji nie mają jeszcze kategorii.',
};

/** `nominative[m - 1]`: „wrzesień 2026”. */
export const MONTHS_NOMINATIVE = [
  'styczeń',
  'luty',
  'marzec',
  'kwiecień',
  'maj',
  'czerwiec',
  'lipiec',
  'sierpień',
  'wrzesień',
  'październik',
  'listopad',
  'grudzień',
] as const;

/** `genitive[m - 1]`: „od września 2026”. */
export const MONTHS_GENITIVE = [
  'stycznia',
  'lutego',
  'marca',
  'kwietnia',
  'maja',
  'czerwca',
  'lipca',
  'sierpnia',
  'września',
  'października',
  'listopada',
  'grudnia',
] as const;

/**
 * The Polish plural of a count: `one` for 1, `few` for 2–4 (but not 12–14)
 * in the last digit, `many` for everything else (0, 5–21, 25, …).
 */
export function polishPlural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

/**
 * The count line over the results, positions 1-based: „Znaleziono 3
 * dokumenty.” when they all fit on this page, „Znaleziono 23 dokumenty,
 * pokazuję 11–20.” otherwise, and „ponad 500 dokumentów” when the count
 * reached the cap.
 */
export function searchFoundText(
  total: number,
  capped: boolean,
  first: number,
  last: number,
): string {
  const count = capped
    ? `ponad ${SEARCH_TOTAL_CAP} dokumentów`
    : `${total} ${polishPlural(total, 'dokument', 'dokumenty', 'dokumentów')}`;
  if (!capped && first === 1 && last >= total) return `Znaleziono ${count}.`;
  const shown = first === last ? `dokument nr ${first}` : `${first}–${last}`;
  return `Znaleziono ${count}, pokazuję ${shown}.`;
}
