import type { IngestionBatchItemResult, IngestionResponsePayload } from '@bcr/shared';

/**
 * Adaptive Card payloads. We hand-author the JSON (rather than using a
 * heavyweight template library) so the cards stay legible and easy to diff.
 *
 * All user-facing strings are in Polish — this bot is deployed to a Polish
 * client base. Filename conventions accept Polish keywords primarily, with
 * English equivalents as a fallback for tools that emit English names.
 *
 * Schema reference: https://adaptivecards.io/explorer/
 */

const ADAPTIVE_CARD_VERSION = '1.5';

export function buildHelpCard(): unknown {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
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
          'Wyślij mi dokument w załączniku (PDF, JPG, PNG lub tekst) — ' +
          'przeanalizuję jego treść i umieszczę w odpowiednim folderze w SharePoint.',
        wrap: true,
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
          'Wskazówka: dokumenty, których nie da się jednoznacznie sklasyfikować, ' +
          'trafiają do folderu „Nieposortowane” do ręcznego sprawdzenia. ' +
          'W odpowiedzi otrzymasz kartę z kategorią, folderem docelowym oraz ' +
          'krótkim uzasadnieniem wyboru.',
        wrap: true,
        isSubtle: true,
        spacing: 'Medium',
      },
    ],
  };
}

export function buildSuccessCard(
  result: NonNullable<IngestionResponsePayload['result']>,
): unknown {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: ADAPTIVE_CARD_VERSION,
    body: [
      {
        type: 'TextBlock',
        text: `✅ Zarchiwizowano **${result.finalFilename}**`,
        size: 'Medium',
        weight: 'Bolder',
        wrap: true,
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Typ', value: result.classification.documentType },
          {
            title: 'Pewność',
            value: `${Math.round(result.classification.confidence * 100)}%`,
          },
          { title: 'Folder', value: result.folderPath },
          { title: 'Sklasyfikowano przez', value: result.classification.classifier },
        ],
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Otwórz w SharePoint',
        url: result.webUrl,
      },
    ],
  };
}

/**
 * One consolidated summary table for a batch of documents. Each row shows
 * where the document was filed and the reasoning behind that classification,
 * so the user gets a single response instead of a card per file.
 */
export function buildBatchResultCard(results: readonly IngestionBatchItemResult[]): unknown {
  const uploaded = results.filter((r) => r.status === 'uploaded').length;
  const rejected = results.length - uploaded;

  const headerCell = (text: string) => ({
    type: 'TableCell',
    items: [{ type: 'TextBlock', text, weight: 'Bolder', wrap: true }],
  });

  const cell = (items: unknown[]) => ({ type: 'TableCell', items });

  const rows = results.map((item) => {
    if (item.status === 'uploaded' && item.result) {
      const { result } = item;
      return {
        type: 'TableRow',
        cells: [
          cell([{ type: 'TextBlock', text: `✅ ${result.finalFilename}`, wrap: true }]),
          cell([{ type: 'TextBlock', text: result.folderPath, wrap: true }]),
          cell([
            {
              type: 'TextBlock',
              text: `${Math.round(result.classification.confidence * 100)}%`,
              wrap: true,
            },
          ]),
          cell([
            {
              type: 'TextBlock',
              text: result.classification.documentType,
              wrap: true,
              isSubtle: true,
            },
          ]),
        ],
      };
    }
    return {
      type: 'TableRow',
      cells: [
        cell([{ type: 'TextBlock', text: `⚠️ ${item.filename}`, wrap: true, color: 'Attention' }]),
        cell([{ type: 'TextBlock', text: '—', wrap: true }]),
        cell([{ type: 'TextBlock', text: '—', wrap: true }]),
        cell([
          {
            type: 'TextBlock',
            text: item.error?.message ?? 'Archiwizacja nie powiodła się',
            wrap: true,
            color: 'Attention',
            isSubtle: true,
          },
        ]),
      ],
    };
  });

  const links = results
    .filter((r): r is IngestionBatchItemResult & { result: NonNullable<IngestionBatchItemResult['result']> } =>
      r.status === 'uploaded' && Boolean(r.result?.webUrl),
    )
    .map((r) => ({
      type: 'Action.OpenUrl',
      title: r.result.finalFilename,
      url: r.result.webUrl,
    }));

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
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
        text: `Zarchiwizowano: ${uploaded}  •  Błędy: ${rejected}`,
        isSubtle: true,
        spacing: 'None',
        wrap: true,
      },
      {
        type: 'Table',
        firstRowAsHeaders: true,
        gridStyle: 'default',
        columns: [{ width: 2 }, { width: 2 }, { width: 1 }, { width: 3 }],
        rows: [
          {
            type: 'TableRow',
            cells: [
              headerCell('Dokument'),
              headerCell('Folder'),
              headerCell('Pewność'),
              headerCell('Uzasadnienie'),
            ],
          },
          ...rows,
        ],
      },
    ],
    ...(links.length > 0 ? { actions: links } : {}),
  };
}

export function buildFailureCard(filename: string, errorMessage: string): unknown {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: ADAPTIVE_CARD_VERSION,
    body: [
      {
        type: 'TextBlock',
        text: `⚠️ Nie udało się zarchiwizować pliku **${filename}**`,
        size: 'Medium',
        weight: 'Bolder',
        color: 'Attention',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: errorMessage,
        wrap: true,
        isSubtle: true,
      },
      {
        type: 'TextBlock',
        text: 'Spróbuj ponownie wysłać plik. Jeśli problem się powtórzy, skontaktuj się z zespołem wsparcia.',
        wrap: true,
        spacing: 'Medium',
      },
    ],
  };
}
