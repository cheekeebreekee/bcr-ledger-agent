/**
 * Folder taxonomy — the single source of truth for where a document lands in
 * a client's SharePoint space.
 *
 * The structure was agreed with the business owner. Each client has their own
 * SharePoint space mirroring this layout. Numbered prefixes (`01_`, `02_`, …)
 * are part of the literal folder name. Categories marked `dated` get a nested
 * `YYYY/MM` leaf (e.g. `02_Wyciągi_bankowe/2026/06`).
 *
 * Both the AI classifier and the deterministic fallback build paths through
 * {@link buildFolderPath}, so they can never drift apart. The same
 * {@link categoryCatalog} also drives the Claude prompt (the descriptions are
 * the model's classification rules) and the output schema's category enum.
 */

/** Stable identifiers for every routable category. */
export type DocumentCategory =
  | 'faktury_sprzedazy'
  | 'faktury_zakupu'
  | 'faktury_korekty'
  | 'faktury_noty'
  | 'wyciagi_bankowe'
  | 'raporty_marketplace'
  | 'umowy'
  | 'dokumenty_firmowe'
  | 'kadry_place'
  | 'deklaracje_jpk'
  | 'korespondencja'
  | 'raporty'
  | 'srodki_trwale'
  | 'ewidencja_vat'
  | 'onboarding_reguly'
  | 'inne'
  | 'nieposortowane';

/**
 * Invoice direction relative to the client. Only meaningful for invoice
 * categories; everything else uses `'nie_dotyczy'` (n/a).
 */
export type InvoiceDirection = 'sprzedaz' | 'zakup' | 'nie_dotyczy';

export interface CategoryDefinition {
  readonly id: DocumentCategory;
  /** Literal folder segments, top-down, excluding the optional date leaf. */
  readonly segments: readonly string[];
  /** When true, a nested `YYYY/MM` leaf is appended to the path. */
  readonly dated: boolean;
  /** Human-readable Polish label, surfaced to users and to the model. */
  readonly polishLabel: string;
  /** Guidance the AI uses to recognise this category. */
  readonly description: string;
  /** Representative example documents. */
  readonly examples: readonly string[];
  /**
   * An invoice, receipt or note: the classifier also reads its number, dates,
   * currency, amounts, parties and KSeF number for the document index.
   */
  readonly invoiceFields?: true;
}

/**
 * The authoritative catalog. Order is the order presented to the model.
 * `nieposortowane` is intentionally last — it is the manual-review fallback.
 */
export const categoryCatalog: readonly CategoryDefinition[] = [
  {
    id: 'faktury_sprzedazy',
    segments: ['01_Faktury', '01_Faktury_sprzedaży'],
    dated: true,
    invoiceFields: true,
    polishLabel: 'Faktura sprzedaży',
    description:
      'Faktura, na której KLIENT jest sprzedawcą/wystawcą (sprzedaje towar lub usługę): ' +
      'dane sprzedawcy zgadzają się z nazwą lub NIP klienta. Dowolna postać faktury: ' +
      'VAT, KSeF, zaliczkowa, rozliczeniowa, uproszczona (także paragon fiskalny z NIP-em ' +
      'nabywcy, do 450 zł) i zagraniczna (invoice, factuur, Rechnung), jeśli wskazuje nabywcę.',
    examples: [
      'Faktura VAT wystawiona przez klienta dla kontrahenta',
      'Faktura eksportowa usług z odwrotnym obciążeniem',
    ],
  },
  {
    id: 'faktury_zakupu',
    segments: ['01_Faktury', '02_Faktury_zakupu'],
    dated: true,
    invoiceFields: true,
    polishLabel: 'Faktura zakupu',
    description:
      'Faktura, na której KLIENT jest nabywcą/kupującym: dane nabywcy zgadzają się z nazwą ' +
      'lub NIP klienta, a sprzedawcą jest inny podmiot. Dowolna postać faktury: VAT, KSeF, ' +
      'zaliczkowa, rozliczeniowa, uproszczona (także paragon fiskalny z NIP-em nabywcy, do ' +
      '450 zł) i zagraniczna (invoice, factuur, Rechnung, bilet, rachunek hotelowy), jeśli ' +
      'wskazuje nabywcę.',
    examples: [
      'Faktura kosztowa od dostawcy',
      'Paragon fiskalny z NIP-em nabywcy',
      'Zagraniczna faktura za hotel lub bilet wystawiona na klienta',
    ],
  },
  {
    id: 'faktury_korekty',
    segments: ['01_Faktury', '03_Korekty_i_anulowania'],
    dated: true,
    invoiceFields: true,
    polishLabel: 'Korekta / anulowanie',
    description:
      'Faktura korygująca, nota korygująca lub dokument anulowania faktury — ' +
      'niezależnie od kierunku (sprzedaż czy zakup).',
    examples: ['Faktura korygująca', 'Anulowanie faktury'],
  },
  {
    id: 'faktury_noty',
    segments: ['01_Faktury', '04_Noty_i_dowody_księgowe'],
    dated: true,
    invoiceFields: true,
    polishLabel: 'Nota / dowód księgowy',
    description:
      'Nota księgowa, nota obciążeniowa/uznaniowa, polecenie księgowania lub inny ' +
      'dowód księgowy niebędący fakturą VAT. Także paragon, potwierdzenie płatności kartą ' +
      'i zagraniczny paragon (klantenbon, receipt, Kassenbon) BEZ danych nabywcy.',
    examples: [
      'Nota księgowa',
      'Nota obciążeniowa',
      'Dowód wewnętrzny PK',
      'Paragon ze stacji paliw bez danych nabywcy',
    ],
  },
  {
    id: 'wyciagi_bankowe',
    segments: ['02_Wyciągi_bankowe'],
    dated: true,
    polishLabel: 'Wyciąg bankowy',
    description: 'Wyciąg bankowy lub potwierdzenie operacji/przelewu z banku.',
    examples: ['Wyciąg bankowy mBank', 'Historia rachunku', 'Potwierdzenie przelewu'],
  },
  {
    id: 'raporty_marketplace',
    segments: ['03_Raporty_marketplace'],
    dated: true,
    polishLabel: 'Raport marketplace',
    description:
      'Raport rozliczeniowy lub sprzedażowy z platformy marketplace ' +
      '(Allegro, Amazon, eBay, Erli itp.).',
    examples: ['Raport rozliczeniowy Allegro', 'Settlement report Amazon'],
  },
  {
    id: 'umowy',
    segments: ['04_Umowy'],
    dated: false,
    polishLabel: 'Umowa',
    description:
      'Umowa handlowa, umowa z kontrahentem, aneks do umowy, polisa ubezpieczeniowa ' +
      'oraz ogólne warunki ubezpieczenia (OWU) i warunki polisy (z wyłączeniem umów ' +
      'o pracę, które trafiają do kadr).',
    examples: ['Umowa najmu', 'Umowa o współpracy', 'Aneks do umowy', 'Polisa OC', 'OWU'],
  },
  {
    id: 'dokumenty_firmowe',
    segments: ['05_Dokumenty_firmowe_ustawowe'],
    dated: false,
    polishLabel: 'Dokument firmowy / ustawowy',
    description:
      'Dokumenty rejestrowe i ustawowe firmy: odpis KRS, umowa spółki, ' +
      'zaświadczenia NIP/REGON, uchwały.',
    examples: ['Odpis KRS', 'Umowa spółki', 'Zaświadczenie REGON'],
  },
  {
    id: 'kadry_place',
    segments: ['06_Kadry_i_płace'],
    dated: false,
    polishLabel: 'Kadry i płace',
    description:
      'Dokumenty kadrowo-płacowe: umowy o pracę/zlecenie, listy płac, ' +
      'dokumenty ZUS dotyczące pracowników, świadectwa pracy.',
    examples: ['Umowa o pracę', 'Lista płac', 'ZUS RCA'],
  },
  {
    id: 'deklaracje_jpk',
    segments: ['07_Deklaracje_i_JPK'],
    dated: false,
    polishLabel: 'Deklaracja / JPK',
    description:
      'Deklaracje podatkowe i pliki JPK: VAT-7, JPK_V7, PIT, CIT, ' +
      'deklaracje ZUS DRA, potwierdzenia UPO.',
    examples: ['JPK_V7M', 'Deklaracja VAT-7', 'CIT-8', 'ZUS DRA'],
  },
  {
    id: 'korespondencja',
    segments: ['08_Korespondencja'],
    dated: false,
    polishLabel: 'Korespondencja',
    description:
      'Pisma i korespondencja: pisma z urzędu skarbowego lub ZUS, wezwania, ' +
      'pisma od kontrahentów, e-maile zapisane jako dokument.',
    examples: ['Pismo z US', 'Wezwanie do zapłaty', 'Korespondencja z ZUS'],
  },
  {
    id: 'raporty',
    segments: ['09_Raporty'],
    dated: false,
    polishLabel: 'Raport',
    description:
      'Raporty wewnętrzne i sprawozdania niebędące raportami marketplace ' +
      '(np. raporty zarządcze, sprawozdania finansowe).',
    examples: ['Sprawozdanie finansowe', 'Raport zarządczy', 'Bilans'],
  },
  {
    id: 'srodki_trwale',
    segments: ['10_Środki_trwałe'],
    dated: false,
    polishLabel: 'Środki trwałe',
    description:
      'Dokumenty środków trwałych: ewidencja, tabele amortyzacji, ' +
      'dokumenty OT/LT przyjęcia i likwidacji.',
    examples: ['Ewidencja środków trwałych', 'Tabela amortyzacji', 'Dokument OT'],
  },
  {
    id: 'ewidencja_vat',
    segments: ['11_Ewidencja_VAT'],
    dated: false,
    polishLabel: 'Ewidencja VAT',
    description: 'Rejestry i ewidencje VAT (rejestr sprzedaży/zakupu VAT).',
    examples: ['Rejestr VAT sprzedaży', 'Rejestr VAT zakupu'],
  },
  {
    id: 'onboarding_reguly',
    segments: ['12_Onboarding_i_reguły'],
    dated: false,
    polishLabel: 'Onboarding i reguły',
    description:
      'Dokumenty onboardingowe klienta oraz ustalone reguły księgowania ' +
      'i instrukcje współpracy.',
    examples: ['Karta klienta', 'Reguły księgowania', 'Instrukcja obiegu dokumentów'],
  },
  {
    id: 'inne',
    segments: ['13_Inne'],
    dated: false,
    polishLabel: 'Inne',
    description:
      'Dokument rozpoznany jako księgowy/firmowy, ale niepasujący do żadnej ' +
      'z powyższych kategorii. Także faktura pro forma, która nie jest dowodem księgowym.',
    examples: ['Faktura pro forma', 'Dokument niepasujący do pozostałych kategorii'],
  },
  {
    id: 'nieposortowane',
    segments: ['98_Nieposortowane'],
    dated: true,
    polishLabel: 'Nieposortowane',
    description:
      'Dokument, którego nie udało się pewnie zaklasyfikować — wymaga ręcznej ' +
      'weryfikacji przez księgowego.',
    examples: ['Skan o niskiej jakości', 'Dokument nierozpoznany'],
  },
];

const categoryById: ReadonlyMap<DocumentCategory, CategoryDefinition> = new Map(
  categoryCatalog.map((c) => [c.id, c]),
);

/** The category used whenever classification fails or is too uncertain. */
export const FALLBACK_CATEGORY: DocumentCategory = 'nieposortowane';

/** Look up a category definition by id. */
export function getCategory(id: DocumentCategory): CategoryDefinition {
  const def = categoryById.get(id);
  if (!def) {
    throw new Error(`Unknown document category: ${id}`);
  }
  return def;
}

/**
 * Whether a category's documents carry invoice fields (an invoice, a
 * correction, a note or receipt): the `01_Faktury` family.
 */
export function hasInvoiceFields(category: unknown): boolean {
  return isDocumentCategory(category) && getCategory(category).invoiceFields === true;
}

/** Type guard for values coming from the model or other untrusted sources. */
export function isDocumentCategory(value: unknown): value is DocumentCategory {
  return typeof value === 'string' && categoryById.has(value as DocumentCategory);
}

export interface DateParts {
  /** Four-digit year, e.g. `2026`. Accepts number or string. */
  readonly year: number | string;
  /** Month 1–12. Accepts number or string. */
  readonly month: number | string;
}

/**
 * Build the SharePoint folder path (relative to the drive root) for a
 * category. For `dated` categories a `YYYY/MM` leaf is appended; the date is
 * required in that case.
 *
 * @throws if a dated category is requested without a valid `year`/`month`.
 */
export function buildFolderPath(
  category: DocumentCategory,
  date?: DateParts,
): string {
  const def = getCategory(category);
  const base = def.segments.join('/');
  if (!def.dated) return base;

  if (!date) {
    throw new Error(`Category "${category}" requires a date (year/month)`);
  }
  return `${base}/${formatYear(date.year)}/${formatMonth(date.month)}`;
}

/**
 * Resolve the concrete invoice category from a coarse "this is an invoice"
 * signal plus a direction. Corrections and notes are passed through directly
 * by the caller; this only disambiguates sprzedaż vs zakup.
 */
export function invoiceCategoryForDirection(
  direction: InvoiceDirection,
): DocumentCategory {
  return direction === 'sprzedaz' ? 'faktury_sprzedazy' : 'faktury_zakupu';
}

// ---------------------------------------------------------------------------

function formatYear(year: number | string): string {
  const n = typeof year === 'number' ? year : Number.parseInt(year, 10);
  if (!Number.isInteger(n) || n < 1000 || n > 9999) {
    throw new Error(`Invalid year: ${year}`);
  }
  return String(n).padStart(4, '0');
}

function formatMonth(month: number | string): string {
  const n = typeof month === 'number' ? month : Number.parseInt(month, 10);
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  return String(n).padStart(2, '0');
}
