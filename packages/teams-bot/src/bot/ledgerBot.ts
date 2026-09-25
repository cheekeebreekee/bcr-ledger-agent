import {
  ActivityHandler,
  type Attachment,
  type TurnContext,
  CardFactory,
  MessageFactory,
} from 'botbuilder';
import {
  createLogger,
  type IngestionBatchItemResult,
  type IngestionDocument,
} from '@bcr/shared';
import type { IngestionClient } from '../services/ingestionClient';
import type { AttachmentDownloader } from '../services/attachmentDownloader';
import { buildBatchResultCard, buildHelpCard } from './responseBuilder';

export interface LedgerBotDeps {
  readonly ingestionClient: IngestionClient;
  readonly attachmentDownloader: AttachmentDownloader;
}

/**
 * The bot's brain. Three responsibilities:
 *
 *   1. Greet new conversation members with a help card.
 *   2. For each incoming message, detect file attachments, download them,
 *      and forward the whole set to the ingestion API in a single batch.
 *   3. Translate the batch response into one consolidated table card that
 *      shows, per document, where it was filed and why.
 *
 * We deliberately keep this class free of HTTP/SDK plumbing — that lives
 * in `functions/messages.ts` — so it stays trivially unit-testable with
 * a `TestAdapter`.
 */
export class LedgerBot extends ActivityHandler {
  private readonly log = createLogger('bot/ledgerBot');

  constructor(private readonly deps: LedgerBotDeps) {
    super();

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id !== context.activity.recipient?.id) {
          await context.sendActivity(
            MessageFactory.attachment(CardFactory.adaptiveCard(buildHelpCard())),
          );
        }
      }
      await next();
    });

    this.onMessage(async (context, next) => {
      await this.handleMessage(context);
      await next();
    });
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const attachments = filterFileAttachments(activity.attachments ?? []);

    if (attachments.length === 0) {
      // Debug: log the raw attachment shapes so we can diagnose why nothing
      // passed the filter (Teams channel @mention flows have different
      // payloads than 1:1 chats). Kept as `info` so we can query it via
      // App Insights without turning on debug for the whole app.
      const rawShapes = (activity.attachments ?? []).map((a) => ({
        contentType: a.contentType,
        name: a.name,
        hasContentUrl: Boolean(a.contentUrl),
        contentKeys:
          a.content && typeof a.content === 'object'
            ? Object.keys(a.content as object).slice(0, 20)
            : typeof a.content,
      }));
      this.log.info(
        {
          conversationId: activity.conversation?.id,
          teamsChannelId: activity.channelData?.channel?.id,
          rawAttachmentCount: (activity.attachments ?? []).length,
          rawAttachmentShapes: rawShapes,
        },
        'no file attachments passed filter — sending help card',
      );
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(buildHelpCard())),
      );
      return;
    }

    const turnLog = this.log.child({
      activityId: activity.id,
      conversationId: activity.conversation?.id,
      teamsChannelId: activity.channelData?.channel?.id,
      attachmentCount: attachments.length,
    });

    await context.sendActivity({ type: 'typing' });

    // Download every attachment first. A download failure for one file is
    // captured as a rejected row so it still shows up in the summary table
    // rather than aborting the whole batch.
    const documents: IngestionDocument[] = [];
    const downloadFailures: IngestionBatchItemResult[] = [];

    await Promise.all(
      attachments.map(async (attachment) => {
        const fileName = attachment.name ?? 'attachment.bin';
        const childLog = turnLog.child({ filename: fileName });
        try {
          childLog.info('downloading attachment');
          const { content, contentType } =
            await this.deps.attachmentDownloader.download(attachment);
          documents.push({
            filename: fileName,
            contentType,
            contentBase64: content.toString('base64'),
          });
        } catch (err) {
          childLog.error({ err }, 'failed to download attachment');
          downloadFailures.push({
            filename: fileName,
            status: 'rejected',
            error: {
              code: 'DownloadFailed',
              message: err instanceof Error ? err.message : 'Nieznany błąd',
            },
          });
        }
      }),
    );

    let batchResults: IngestionBatchItemResult[] = [];
    if (documents.length > 0) {
      try {
        turnLog.info({ documentCount: documents.length }, 'forwarding batch to ingestion API');
        const response = await this.deps.ingestionClient.ingestBatch({
          documents,
          source: {
            tenantId: activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? '',
            channelId: activity.channelId ?? 'msteams',
            conversationId: activity.conversation?.id ?? '',
            activityId: activity.id ?? '',
            conversationType: activity.conversation?.conversationType,
            // Present for team-channel messages, undefined for 1:1 personal chats.
            teamsChannelId: activity.channelData?.channel?.id,
            userAadObjectId: activity.from?.aadObjectId,
            userDisplayName: activity.from?.name,
          },
        });
        batchResults = [...response.results];
      } catch (err) {
        turnLog.error({ err }, 'batch ingestion failed');
        const message = err instanceof Error ? err.message : 'Archiwizacja nie powiodła się';
        batchResults = documents.map((doc) => ({
          filename: doc.filename,
          status: 'rejected',
          error: { code: 'IngestionFailed', message },
        }));
      }
    }

    const allResults = [...downloadFailures, ...batchResults];
    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(buildBatchResultCard(allResults))),
    );
  }
}

/**
 * Teams may include link previews, channel mentions, or other non-file
 * attachments in the same activity. We only forward things that look like
 * files. Two cases:
 *
 *  - `contentType` starts with `application/vnd.microsoft.teams.file.download.info`
 *    → a real Teams file picker upload. The actual download URL lives in
 *    `content.downloadUrl` (Microsoft Graph SAS link).
 *
 *  - `contentUrl` is set and `contentType` is something other than
 *    `application/vnd.microsoft.card.*` → a Bot Framework attachment
 *    (e.g. emulator drag-and-drop). We use the attachment service to fetch it.
 */
export function filterFileAttachments(attachments: readonly Attachment[]): Attachment[] {
  return attachments.filter((a) => {
    if (!a.contentType) return false;
    if (a.contentType.startsWith('application/vnd.microsoft.card.')) return false;
    if (a.contentType.startsWith('application/vnd.microsoft.teams.file.download.info')) return true;
    return Boolean(a.contentUrl);
  });
}
