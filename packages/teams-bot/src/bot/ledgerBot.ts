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
  type Logger,
} from '@bcr/shared';
import type { IngestionClient } from '../services/ingestionClient';
import type { AttachmentDownloader } from '../services/attachmentDownloader';
import { buildBatchResultCard, buildHelpCard } from './responseBuilder';
import { DOWNLOAD_FAILED, INGESTION_FAILED } from './cardText';
import { activityTenantId } from './gate';

export interface LedgerBotDeps {
  readonly ingestionClient: Pick<IngestionClient, 'ingestBatch'>;
  readonly attachmentDownloader: Pick<AttachmentDownloader, 'download'>;
}

type DownloadOutcome =
  | { readonly ok: true; readonly document: IngestionDocument }
  | { readonly ok: false; readonly failure: IngestionBatchItemResult };

/**
 * The bot's brain. Three responsibilities:
 *
 *   1. Greet new conversation members with a help card.
 *   2. For each incoming message, detect file attachments, download them,
 *      and forward the whole set to the ingestion API in a single batch.
 *   3. Translate the batch response into one consolidated table card that
 *      shows, per document, where it was filed.
 *
 * Which activities reach this class at all is decided earlier, by the gate
 * middleware registered on the adapter (`gateMiddleware.ts`).
 *
 * We deliberately keep this class free of HTTP/SDK plumbing — that lives
 * in `functions/messages.ts` — so it stays trivially unit-testable with
 * a `TestAdapter`.
 *
 * Logs carry ids and counts only, never filenames or user names.
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
      // Kept as `info` so a "why did nothing upload" report can be answered
      // from App Insights. Content types only — names are user data.
      this.log.info(
        {
          activityId: activity.id,
          conversationId: activity.conversation?.id,
          rawAttachmentCount: (activity.attachments ?? []).length,
          rawAttachmentContentTypes: (activity.attachments ?? []).map((a) => a.contentType),
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
    // rather than aborting the whole batch. `Promise.all` keeps the order.
    const outcomes = await Promise.all(
      attachments.map((attachment, attachmentIndex) =>
        this.downloadOne(attachment, turnLog.child({ attachmentIndex })),
      ),
    );
    const documents = outcomes.flatMap((o) => (o.ok ? [o.document] : []));
    const downloadFailures = outcomes.flatMap((o) => (o.ok ? [] : [o.failure]));

    let batchResults: IngestionBatchItemResult[] = [];
    if (documents.length > 0) {
      try {
        turnLog.info({ documentCount: documents.length }, 'forwarding batch to ingestion API');
        const response = await this.deps.ingestionClient.ingestBatch({
          documents,
          source: {
            tenantId: activityTenantId(activity) ?? '',
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
        batchResults = documents.map((doc) => ({
          filename: doc.filename,
          status: 'rejected',
          error: { code: INGESTION_FAILED, message: 'Ingestion request failed' },
        }));
      }
    }

    const allResults = [...downloadFailures, ...batchResults];
    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(buildBatchResultCard(allResults))),
    );
  }

  private async downloadOne(attachment: Attachment, childLog: Logger): Promise<DownloadOutcome> {
    const filename = attachment.name ?? 'attachment.bin';
    try {
      childLog.info('downloading attachment');
      const { content, contentType } = await this.deps.attachmentDownloader.download(attachment);
      return {
        ok: true,
        document: { filename, contentType, contentBase64: content.toString('base64') },
      };
    } catch (err) {
      childLog.error({ err }, 'failed to download attachment');
      return {
        ok: false,
        failure: {
          filename,
          status: 'rejected',
          error: { code: DOWNLOAD_FAILED, message: 'Attachment download failed' },
        },
      };
    }
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
