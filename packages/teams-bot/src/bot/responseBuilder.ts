import type { IngestionBatchItemResult, IngestionUploadResult } from '@bcr/shared';
import {
  QUARANTINED_TEXT,
  SEARCH_COVERAGE_TEXT,
  SEARCH_HELP_HEADING,
  SEARCH_HELP_TEXT,
  escapeMarkdown,
  rejectionText,
} from './cardText';

/**
 * Adaptive Card payloads. We hand-author the JSON (rather than using a
 * heavyweight template library) so the cards stay legible and easy to diff.
 *
 * All user-facing strings are Polish and fixed (see `cardText.ts`). A card
 * lists allowed fields only — the filename, the category label, the folder
 * inside the uploader's own space and a link to it — and every one of them
 * goes through `escapeMarkdown()`. It never shows model free text, confidence,
 * error messages, or anything about a quarantined document beyond its name.
 *
 * Schema reference: https://adaptivecards.io/explorer/
 */

export const ADAPTIVE_CARD_VERSION = '1.5';
export const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';

export interface HelpCardOptions {
  /** Search is on (`SEARCH_MODE=on`): add the „Wyszukiwanie” section. */
  readonly search?: boolean;
}

/**
 * The help card. Clients are Teams guests, and Teams lets a guest attach a
 * file only to a channel post, never in a chat: so the card sends clients to
 * their Team's „Dokumenty księgowe” channel (the channel inbox), and keeps
 * the chat for whoever can attach here. Every string is fixed; nothing is
 * inserted.
 *
 * With search on, a „Wyszukiwanie” section follows; with it off the card is
 * byte for byte the one from before search existed (a test pins its hash).
 */
export function buildHelpCard(opts: HelpCardOptions = {}): unknown {
  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: ADAPTIVE_CARD_VERSION,
    body: [
      {
        type: 'TextBlock',
        text: '📂 Asystent Archiwizacji Dokumentów',
        weight: 'Bolder',
        size: 'Large',
      },
      {
        type: 'TextBlock',
        text:
          'Dokumenty (PDF, JPG, PNG lub tekst) dodawaj w swoim zespole w Teams, w kanale ' +
          '„Dokumenty księgowe”: jako załącznik do wpisu w kanale albo na karcie ' +
          '„Udostępnione”. Przeanalizuję treść każdego pliku i przeniosę go do odpowiedniego ' +
          'folderu w tym samym kanale.',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text:
          'Goście (konta spoza BCR) nie mogą dołączać plików w tym czacie — to ograniczenie ' +
          'Microsoft Teams. Jeśli możesz dołączyć plik tutaj, wyślij go w tym prywatnym czacie, ' +
          'a odpowiem kartą z kategorią i folderem docelowym każdego pliku.',
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text:
          'Klasyfikacja odbywa się na podstawie treści dokumentu — nazwa pliku ' +
          'nie ma znaczenia. Rozpoznaję m.in. faktury sprzedaży i zakupu, ' +
          'paragony, umowy, wyciągi bankowe, raporty, deklaracje podatkowe, ' +
          'korespondencję oraz dokumenty kadrowe.',
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text:
          'Dokumenty, których nie da się jednoznacznie sklasyfikować, trafiają do folderu ' +
          '„Nieposortowane” w Twoim zespole i są sprawdzane przez księgowego.',
        wrap: true,
        isSubtle: true,
        spacing: 'Medium',
      },
      {
        type: 'TextBlock',
        text:
          'Zarchiwizowane pliki znajdziesz w swoim zespole w Teams: ' +
          'kanał „Dokumenty księgowe” → karta „Udostępnione”.',
        wrap: true,
        isSubtle: true,
        spacing: 'Small',
      },
      ...(opts.search ? searchHelpSection() : []),
    ],
  };
}

function searchHelpSection(): unknown[] {
  return [
    {
      type: 'TextBlock',
      text: SEARCH_HELP_HEADING,
      weight: 'Bolder',
      spacing: 'Large',
      wrap: true,
    },
    { type: 'TextBlock', text: SEARCH_HELP_TEXT, wrap: true, spacing: 'Small' },
    { type: 'TextBlock', text: SEARCH_COVERAGE_TEXT, wrap: true, isSubtle: true, spacing: 'Small' },
  ];
}

/**
 * One consolidated summary table for a batch of documents: one row per
 * document, in the order given.
 *
 *  - uploaded: ✅ name | category label | folder, plus an "Otwórz" button
 *    into the uploader's own space;
 *  - quarantined: 📨 name | fixed "przekazano do weryfikacji" line | —, and
 *    no link (the document is in a staff-only area);
 *  - rejected: ⚠️ name | generic Polish message chosen by error code | —.
 */
export function buildBatchResultCard(results: readonly IngestionBatchItemResult[]): unknown {
  const uploaded = results.filter((r) => r.status === 'uploaded' && r.result).length;
  const quarantined = results.filter((r) => r.status === 'quarantined').length;
  const rejected = results.length - uploaded - quarantined;

  const headerCell = (text: string) => ({
    type: 'TableCell',
    items: [{ type: 'TextBlock', text, weight: 'Bolder', wrap: true }],
  });

  return {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: ADAPTIVE_CARD_VERSION,
    body: [
      {
        type: 'TextBlock',
        text: `📊 Podsumowanie archiwizacji (${results.length} dok.)`,
        size: 'Large',
        weight: 'Bolder',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text:
          `Zarchiwizowano: ${uploaded}  •  ` +
          `Przekazano do weryfikacji: ${quarantined}  •  ` +
          `Odrzucono: ${rejected}`,
        isSubtle: true,
        spacing: 'None',
        wrap: true,
      },
      {
        type: 'Table',
        firstRowAsHeaders: true,
        gridStyle: 'default',
        columns: [{ width: 3 }, { width: 2 }, { width: 3 }],
        rows: [
          {
            type: 'TableRow',
            cells: [headerCell('Dokument'), headerCell('Kategoria'), headerCell('Folder')],
          },
          ...results.map(buildRow),
        ],
      },
    ],
  };
}

function buildRow(item: IngestionBatchItemResult) {
  if (item.status === 'uploaded' && item.result) {
    return uploadedRow(item.result);
  }
  if (item.status === 'quarantined') {
    return row(textCell(`📨 ${escapeMarkdown(item.filename)}`), textCell(QUARANTINED_TEXT), dash());
  }
  return row(
    textCell(`⚠️ ${escapeMarkdown(item.filename)}`, { color: 'Attention' }),
    textCell(rejectionText(item.error?.code), { color: 'Attention', isSubtle: true }),
    dash(),
  );
}

function uploadedRow(result: IngestionUploadResult) {
  const url = safeHttpsUrl(result.webUrl);
  const documentCell = {
    type: 'TableCell',
    items: [
      { type: 'TextBlock', text: `✅ ${escapeMarkdown(result.finalFilename)}`, wrap: true },
      // The button title is fixed text: Action titles are not markdown, and a
      // fixed label keeps the filename out of a second, unescaped place.
      ...(url
        ? [
            {
              type: 'ActionSet',
              actions: [{ type: 'Action.OpenUrl', title: 'Otwórz', url }],
            },
          ]
        : []),
    ],
  };
  return row(
    documentCell,
    textCell(escapeMarkdown(result.classification.documentType)),
    textCell(escapeMarkdown(result.folderPath), { isSubtle: true }),
  );
}

function row(...cells: unknown[]) {
  return { type: 'TableRow', cells };
}

function textCell(text: string, style: { color?: string; isSubtle?: boolean } = {}) {
  return { type: 'TableCell', items: [{ type: 'TextBlock', text, wrap: true, ...style }] };
}

function dash() {
  return textCell('—');
}

/** Only an absolute https URL becomes a button; anything else is dropped. */
export function safeHttpsUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
