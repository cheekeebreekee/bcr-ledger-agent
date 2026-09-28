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
  SEARCH_MAX_QUESTION_CHARS,
  type SearchRequestPayload,
  type SearchResponsePayload,
} from '@bcr/shared';
import type { IngestionClient } from '../services/ingestionClient';
import type { AttachmentDownloader } from '../services/attachmentDownloader';
import type { SearchClient } from '../services/searchClient';
import type { UserLimiter } from '../services/userLimiter';
import { buildBatchResultCard, buildHelpCard } from './responseBuilder';
import {
  DOWNLOAD_FAILED,
  INGESTION_FAILED,
  SEARCH_FILTER_INVALID_TEXT,
  SEARCH_TOO_LONG_TEXT,
  searchFloodText,
} from './cardText';
import { activityTenantId, evaluateGate } from './gate';
import { isHelpKeyword, normalizeQuestion, parseSearchAction } from './searchText';
import { retryClock, type SearchReply, searchReply } from './searchCard';

export interface LedgerBotDeps {
  readonly ingestionClient: Pick<IngestionClient, 'ingestBatch'>;
  readonly attachmentDownloader: Pick<AttachmentDownloader, 'download'>;
  /** Present only with `SEARCH_MODE=on`; without it, text gets today's help card. */
  readonly search?: LedgerBotSearchDeps;
}

export interface LedgerBotSearchDeps {
  readonly client: Pick<SearchClient, 'search'>;
  /** The per-worker flood guard (`SEARCH_FLOOD_LIMIT`), keyed by the sender's AAD object id. */
  readonly limiter: Pick<UserLimiter, 'take'>;
  /** The BCR tenant: search runs only for an activity the gate admits, in any gate mode. */
  readonly tenantId: string;
  /** Clock for tests. */
  readonly now?: () => Date;
}

type DownloadOutcome =
  | { readonly ok: true; readonly document: IngestionDocument }
  | { readonly ok: false; readonly failure: IngestionBatchItemResult };

/**
 * The bot's brain. Four responsibilities:
 *
 *   1. Greet new conversation members with a help card.
 *   2. For each incoming message, detect file attachments, download them,
 *      and forward the whole set to the ingestion API in a single batch.
 *   3. Translate the batch response into one consolidated table card that
 *      shows, per document, where it was filed.
 *   4. With search on, answer a message without files — a question, or a
 *      button of our own search card — from ingestion's `POST /api/search`.
 *      The asker is `from.aadObjectId`; the request names no client, and
 *      ingestion decides whose documents are searched exactly as it routes
 *      uploads. With search off, such a message gets today's help card.
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
          await this.sendHelp(context, this.deps.search !== undefined);
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
      // from App Insights. Content types only — names are user data. With
      // search on, only when something besides the text itself (every Teams
      // text message carries a `text/html` attachment) was dropped.
      const raw = activity.attachments ?? [];
      if (!this.deps.search || raw.some((a) => a.contentType !== 'text/html')) {
        this.log.info(
          {
            activityId: activity.id,
            conversationId: activity.conversation?.id,
            rawAttachmentCount: raw.length,
            rawAttachmentContentTypes: raw.map((a) => a.contentType),
          },
          this.deps.search
            ? 'no file attachments passed filter — treating the text as a search'
            : 'no file attachments passed filter — sending help card',
        );
      }
      if (this.deps.search) {
        await this.handleSearch(context, this.deps.search);
        return;
      }
      await this.sendHelp(context, false);
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

  /**
   * A message without files, with search on. In order: our own card button
   * (a typed request: no model call), else the text — normalised, 1–300
   * characters, a help keyword answered with the help card — then the
   * per-worker flood guard, the typing indicator and one call to ingestion.
   * Every answer is a fixed Polish text, the help card or the result card.
   *
   * Logs carry ids and codes only: never the question, a filter value or a
   * result.
   */
  private async handleSearch(context: TurnContext, search: LedgerBotSearchDeps): Promise<void> {
    const activity = context.activity;
    const now = search.now ?? (() => new Date());
    const turnLog = this.log.child({
      activityId: activity.id,
      conversationId: activity.conversation?.id,
    });

    // Reachable only with the gate in `log` mode: an activity the gate would
    // refuse is never searched for and gets today's help card instead.
    const gate = evaluateGate(activity, search.tenantId);
    const tenantId = activityTenantId(activity);
    const userAadObjectId = activity.from?.aadObjectId;
    const conversationId = activity.conversation?.id;
    if (!gate.ok || !tenantId || !userAadObjectId || !conversationId || !activity.id) {
      turnLog.warn({ reason: gate.ok ? 'missing_id' : gate.reason }, 'search.skipped');
      await this.sendHelp(context, false);
      return;
    }
    // The asker is the channel-authenticated sender; nothing names a client.
    const source: SearchRequestPayload['source'] = {
      tenantId,
      conversationId,
      activityId: activity.id,
      conversationType: 'personal',
      userAadObjectId,
    };

    let query: SearchRequestPayload['query'];
    let start = 1;
    const action = parseSearchAction(activity.value);
    if (action.kind === 'invalid') {
      turnLog.info('search.invalid_action');
      await context.sendActivity(SEARCH_FILTER_INVALID_TEXT);
      return;
    }
    if (action.kind === 'typed') {
      query = {
        kind: 'typed',
        filter: action.filter,
        ...(action.after !== undefined ? { after: action.after } : {}),
      };
      start = action.start;
    } else {
      const question = normalizeQuestion(activity.text);
      if (question.length > SEARCH_MAX_QUESTION_CHARS) {
        turnLog.info({ length: question.length }, 'search.too_long');
        await context.sendActivity(SEARCH_TOO_LONG_TEXT);
        return;
      }
      if (question === '' || isHelpKeyword(question)) {
        await this.sendHelp(context, true);
        return;
      }
      query = { kind: 'question', text: question };
    }

    const verdict = search.limiter.take(source.userAadObjectId);
    if (!verdict.ok) {
      turnLog.warn({ kind: query.kind }, 'search.flood_limited');
      await context.sendActivity(
        searchFloodText(retryClock(now(), Math.ceil(verdict.retryAfterMs / 1000))),
      );
      return;
    }

    await context.sendActivity({ type: 'typing' });

    let answer: SearchResponsePayload;
    try {
      answer = await search.client.search({ source, query });
    } catch (err) {
      // `SearchClient` never throws; this keeps a broken fake or a future
      // change from turning into the generic turn-error line.
      turnLog.error({ err }, 'search.client_threw');
      answer = { status: 'unavailable' };
    }
    turnLog.info({ kind: query.kind, status: answer.status }, 'search.answered');
    await this.sendSearchReply(
      context,
      searchReply(answer, { now: now(), start, question: query.kind === 'question' }),
    );
  }

  private async sendSearchReply(context: TurnContext, reply: SearchReply): Promise<void> {
    if (reply.kind === 'card') {
      await context.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(reply.card)));
    } else if (reply.kind === 'text') {
      await context.sendActivity(reply.text);
    } else {
      await this.sendHelp(context, reply.search);
    }
  }

  /** The help card; without search it is today's card, byte for byte. */
  private async sendHelp(context: TurnContext, search: boolean): Promise<void> {
    const card = search ? buildHelpCard({ search: true }) : buildHelpCard();
    await context.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(card)));
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
