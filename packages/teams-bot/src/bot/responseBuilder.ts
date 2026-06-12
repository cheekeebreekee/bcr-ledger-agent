import type { IngestionResponsePayload } from '@bcr/shared';

/**
 * Adaptive Card payloads. We hand-author the JSON (rather than using a
 * heavyweight template library) so the cards stay legible and easy to diff.
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
        text: '📂 Ledger Filing Agent',
        weight: 'Bolder',
        size: 'Large',
      },
      {
        type: 'TextBlock',
        text: 'Attach a document to this chat and I will file it in SharePoint for you.',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: 'Filename conventions I recognise:',
        weight: 'Bolder',
        spacing: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Invoice', value: 'Invoice_<MM>_<YYYY>.pdf' },
          { title: 'Receipt', value: 'Receipt_<YYYY>-<MM>-<DD>.png' },
          { title: 'Contract', value: 'Contract_<Counterparty>_<YYYY>.pdf' },
          { title: 'Statement', value: 'Statement_<Account>_<YYYY>_<MM>.pdf' },
          { title: 'Report', value: 'Report_Q<1-4>_<YYYY>.xlsx' },
        ],
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
        text: `✅ Filed **${result.finalFilename}**`,
        size: 'Medium',
        weight: 'Bolder',
        wrap: true,
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Type', value: result.classification.documentType },
          {
            title: 'Confidence',
            value: `${Math.round(result.classification.confidence * 100)}%`,
          },
          { title: 'Folder', value: result.folderPath },
          { title: 'Classified by', value: result.classification.classifier },
        ],
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open in SharePoint',
        url: result.webUrl,
      },
    ],
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
        text: `⚠️ Could not file **${filename}**`,
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
        text: 'You can retry by re-uploading the file, or contact #help-ledger if it keeps failing.',
        wrap: true,
        spacing: 'Medium',
      },
    ],
  };
}
