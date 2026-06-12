import {
  ActivityHandler,
  type Attachment,
  type TurnContext,
  CardFactory,
  MessageFactory,
} from 'botbuilder';
import { createLogger, type IngestionResponsePayload } from '@bcr/shared';
import type { IngestionClient } from '../services/ingestionClient';
import type { AttachmentDownloader } from '../services/attachmentDownloader';
import { buildSuccessCard, buildFailureCard, buildHelpCard } from './responseBuilder';

export interface LedgerBotDeps {
  readonly ingestionClient: IngestionClient;
  readonly attachmentDownloader: AttachmentDownloader;
}

/**
 * The bot's brain. Three responsibilities:
 *
 *   1. Greet new conversation members with a help card.
 *   2. For each incoming message, detect file attachments, download them,
 *      and forward to the ingestion API.
 *   3. Translate the API response into a friendly adaptive card.
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
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(buildHelpCard())),
      );
      return;
    }

    const turnLog = this.log.child({
      activityId: activity.id,
      conversationId: activity.conversation?.id,
      attachmentCount: attachments.length,
    });

    await context.sendActivity({ type: 'typing' });

    for (const attachment of attachments) {
      const fileName = attachment.name ?? 'attachment.bin';
      const childLog = turnLog.child({ filename: fileName });

      try {
        childLog.info('downloading attachment');
        const { content, contentType } = await this.deps.attachmentDownloader.download(attachment);

        childLog.info({ sizeBytes: content.length }, 'forwarding to ingestion API');
        const response = await this.deps.ingestionClient.ingest({
          filename: fileName,
          contentType,
          contentBase64: content.toString('base64'),
          source: {
            tenantId: activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? '',
            channelId: activity.channelId ?? 'msteams',
            conversationId: activity.conversation?.id ?? '',
            activityId: activity.id ?? '',
            userAadObjectId: activity.from?.aadObjectId,
            userDisplayName: activity.from?.name,
          },
        });

        await this.respondToIngestion(context, fileName, response);
      } catch (err) {
        childLog.error({ err }, 'failed to ingest attachment');
        await context.sendActivity(
          MessageFactory.attachment(
            CardFactory.adaptiveCard(
              buildFailureCard(fileName, err instanceof Error ? err.message : 'Unknown error'),
            ),
          ),
        );
      }
    }
  }

  private async respondToIngestion(
    context: TurnContext,
    fileName: string,
    response: IngestionResponsePayload,
  ): Promise<void> {
    if (response.status === 'uploaded' && response.result) {
      await context.sendActivity(
        MessageFactory.attachment(CardFactory.adaptiveCard(buildSuccessCard(response.result))),
      );
      return;
    }
    await context.sendActivity(
      MessageFactory.attachment(
        CardFactory.adaptiveCard(
          buildFailureCard(fileName, response.error?.message ?? 'Ingestion failed'),
        ),
      ),
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
