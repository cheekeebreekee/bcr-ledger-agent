import {
  clientIdForDirectoryRow,
  documentsRepo,
  type LedgerDb,
  type PendingReviewNotice,
} from '@bcr/ledger-db';
import {
  createLogger,
  getCategory,
  isDocumentCategory,
  type ClientDirectoryEntry,
  type Logger,
} from '@bcr/shared';
import { boundClientRows, type ClientDirectorySnapshot } from './clientDirectoryReader';

/**
 * Review notices: staff are told, in a Teams chat, which documents wait in a
 * client's `98_Nieposortowane` for review. Every few minutes the notifier reads,
 * per bound client and in that client's own scope, the index rows in review
 * that no notice has named yet, posts one card per client (bounded in size),
 * and marks only the rows that card named (`review_notified_at`). A post the
 * webhook refuses is retried by the next run. A 2xx means the flow accepted
 * the request, not that Teams showed it: a flow run that fails afterwards
 * loses that card, which is why each card stays well under Teams' message
 * limit and the runbook checks the flow's run history.
 *
 * The notice goes to a Teams **Workflows** webhook ("Send webhook alerts to a
 * chat"), whose URL is the credential and lives in Key Vault
 * (`review-webhook-url`): Graph cannot post to a chat as an application
 * without Protected API approval. The chat is staff only (Roman, later the
 * accountants); who is in it is managed in Teams.
 *
 * What a notice carries: the Directory row's title (the client's name, which
 * staff know anyway), and per document the suggested category's Polish label,
 * the review reasons in Polish, the document's month and a link "Otwórz plik".
 * The link's target is the file's SharePoint `webUrl` as Graph returns it: the
 * site, the channel folder and the file name, so whatever the file name says
 * is visible on hover to the chat's members and to the flow's owners in its
 * run history. That is why the chat is staff only. The text itself carries no
 * file name, amount, NIP or anything the model wrote, and the link opens only
 * for someone with access to the client's Team.
 */

/** Documents one notice names per client; the rest wait for the next run. */
export const REVIEW_NOTICE_PER_CLIENT = 20;

/** How long one post may take before it counts as failed. */
export const REVIEW_NOTICE_TIMEOUT_MS = 10_000;

/**
 * Largest card posted, as serialized JSON: well under Teams' ~28 KB message
 * limit, which the flow meets only after the webhook has answered 202. A
 * client's documents past it wait for the next run, unmarked.
 */
export const REVIEW_NOTICE_MAX_BYTES = 20_000;

/** A link longer than this is left out of its line, so one row cannot fill a card. */
export const REVIEW_NOTICE_MAX_LINK = 1_000;

/** Where the notifier reads pending documents and marks them, per client. */
export interface ReviewNoticeSource {
  pending(row: ClientDirectoryEntry, limit: number): Promise<PendingReviewNotice[]>;
  markNotified(row: ClientDirectoryEntry, documentIds: readonly string[]): Promise<number>;
}

/** The index, one client transaction per call (the client from the bound row, never a document). */
export class LedgerReviewNotices implements ReviewNoticeSource {
  constructor(
    private readonly opts: {
      readonly db: Pick<LedgerDb, 'withClientTx'>;
      /** `CLIENT_DIRECTORY_LIST_ID`: part of every client's derived id. */
      readonly directoryListId: string;
    },
  ) {}

  pending(row: ClientDirectoryEntry, limit: number): Promise<PendingReviewNotice[]> {
    return this.opts.db.withClientTx(this.clientIdOf(row), (tx) =>
      documentsRepo.pendingReviewNotices(tx, limit),
    );
  }

  markNotified(row: ClientDirectoryEntry, documentIds: readonly string[]): Promise<number> {
    return this.opts.db.withClientTx(this.clientIdOf(row), (tx) =>
      documentsRepo.markReviewNotified(tx, documentIds),
    );
  }

  private clientIdOf(row: ClientDirectoryEntry): string {
    return clientIdForDirectoryRow(this.opts.directoryListId, row.listItemId);
  }
}

/** Posts a card; throws when it was not accepted. */
export interface NoticePoster {
  post(payload: unknown): Promise<void>;
}

/** A Workflows webhook failed: the status, or `unreachable`. No URL, no body. */
export class NoticePostError extends Error {
  constructor(readonly status: number | 'unreachable') {
    super(
      `The review chat webhook ${status === 'unreachable' ? 'could not be reached' : `returned ${status}`}`,
    );
    this.name = 'NoticePostError';
  }
}

/**
 * A Teams Workflows webhook. A 2xx means the flow accepted the request, not
 * that the message was shown (it runs asynchronously): nothing here claims
 * more than "accepted".
 */
export class WorkflowsWebhook implements NoticePoster {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    opts: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? REVIEW_NOTICE_TIMEOUT_MS;
  }

  async post(payload: unknown): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new NoticePostError('unreachable');
    }
    if (!response.ok) throw new NoticePostError(response.status);
  }
}

export interface ReviewNotifierDeps {
  readonly directory: { getSnapshot(): Promise<ClientDirectorySnapshot> };
  readonly source: ReviewNoticeSource;
  readonly poster: NoticePoster;
  /** Defaults to {@link REVIEW_NOTICE_PER_CLIENT}. */
  readonly perClient?: number;
  readonly log?: Logger;
}

/** What one run did: counts only. */
export interface ReviewNoticeRun {
  readonly clients: number;
  readonly documents: number;
  readonly posted: boolean;
  readonly readFailures: number;
}

export class ReviewNotifier {
  private readonly log: Logger;
  private readonly perClient: number;
  private running = false;

  constructor(private readonly deps: ReviewNotifierDeps) {
    this.log = deps.log ?? createLogger('ingestion/reviewNotifier');
    this.perClient = deps.perClient ?? REVIEW_NOTICE_PER_CLIENT;
  }

  /** One run. Never throws: failures are logged, and nothing is marked unless posted. */
  async run(log: Logger = this.log): Promise<ReviewNoticeRun> {
    const result = { clients: 0, documents: 0, posted: false, readFailures: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      return await this.runOnce(log, result);
    } catch (err) {
      log.error(
        { event: 'review_notice.run_failed', err: { name: errorName(err) } },
        'review_notice.run_failed',
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  private async runOnce(
    log: Logger,
    result: { clients: number; documents: number; posted: boolean; readFailures: number },
  ): Promise<ReviewNoticeRun> {
    const snapshot = await this.deps.directory.getSnapshot();
    const groups: { row: ClientDirectoryEntry; docs: PendingReviewNotice[] }[] = [];
    for (const row of boundClientRows(snapshot)) {
      try {
        const docs = await this.deps.source.pending(row, this.perClient);
        if (docs.length > 0) groups.push({ row, docs });
      } catch (err) {
        result.readFailures += 1;
        log.warn(
          {
            event: 'review_notice.read_failed',
            clientId: row.clientId,
            listItemId: row.listItemId,
            err: { name: errorName(err) },
          },
          'review_notice.read_failed',
        );
      }
    }
    if (groups.length === 0) return result;

    const posted: string[] = [];
    for (const { row, docs } of groups) {
      const named = fitToCard(row, docs);
      try {
        await this.deps.poster.post(reviewNoticeCard([{ row, docs: named }]));
      } catch (err) {
        log.warn(
          {
            event: 'review_notice.post_failed',
            clientId: row.clientId,
            listItemId: row.listItemId,
            documents: named.length,
            status: err instanceof NoticePostError ? err.status : 'error',
          },
          'review_notice.post_failed',
        );
        continue;
      }
      result.clients += 1;
      result.documents += named.length;
      const ids = named.map((d) => d.documentId);
      posted.push(...ids);
      try {
        await this.deps.source.markNotified(row, ids);
      } catch (err) {
        // Posted but not marked: the next run names them again. A repeat
        // beats a document nobody hears about.
        log.warn(
          {
            event: 'review_notice.mark_failed',
            clientId: row.clientId,
            listItemId: row.listItemId,
            documentIds: ids,
            err: { name: errorName(err) },
          },
          'review_notice.mark_failed',
        );
      }
    }
    if (posted.length === 0) return result;
    result.posted = true;
    log.info(
      {
        event: 'review_notice.posted',
        clients: result.clients,
        documents: result.documents,
        documentIds: posted,
      },
      'review_notice.posted',
    );
    return result;
  }
}

/** Polish, for staff; a code without a label is shown as it is. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  NOT_CLASSIFIED: 'nie sklasyfikowano',
  PROCESSING_FAILED: 'błąd przetwarzania',
  RETRY_EXHAUSTED: 'klasyfikacja wielokrotnie niedostępna',
  UNKNOWN_CATEGORY: 'nieznana kategoria',
  MODEL_UNSORTED: 'model nie wybrał kategorii',
  DIRECTION_UNRESOLVED: 'nieustalony kierunek faktury',
  DATE_MISSING: 'brak daty dokumentu',
  LOW_CONFIDENCE: 'niska pewność',
};

/**
 * The Workflows payload: one Adaptive Card, a heading, then per client its
 * title and one line per document. Every inserted value is escaped; the link
 * is percent-encoded where Markdown would end it.
 */
export function reviewNoticeCard(
  groups: readonly { row: ClientDirectoryEntry; docs: readonly PendingReviewNotice[] }[],
): unknown {
  const total = groups.reduce((n, g) => n + g.docs.length, 0);
  const body: unknown[] = [
    {
      type: 'TextBlock',
      size: 'Medium',
      weight: 'Bolder',
      wrap: true,
      text: `Dokumenty do weryfikacji: ${total}`,
    },
    {
      type: 'TextBlock',
      wrap: true,
      isSubtle: true,
      text: 'Pliki są w folderze 98\\_Nieposortowane klienta. Przenieś każdy do właściwego folderu.',
    },
  ];
  for (const { row, docs } of groups) {
    body.push({
      type: 'TextBlock',
      weight: 'Bolder',
      wrap: true,
      spacing: 'Medium',
      text: `${escapeMarkdown(row.title)} (${docs.length})`,
    });
    for (const d of docs)
      body.push({ type: 'TextBlock', wrap: true, spacing: 'Small', text: line(d) });
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
        },
      },
    ],
  };
}

/**
 * The client's documents, oldest first, as many as fit one card under
 * {@link REVIEW_NOTICE_MAX_BYTES}; always at least one.
 */
export function fitToCard(
  row: ClientDirectoryEntry,
  docs: readonly PendingReviewNotice[],
): PendingReviewNotice[] {
  const named = [...docs];
  while (
    named.length > 1 &&
    Buffer.byteLength(JSON.stringify(reviewNoticeCard([{ row, docs: named }]))) >
      REVIEW_NOTICE_MAX_BYTES
  ) {
    named.pop();
  }
  return named;
}

function line(d: PendingReviewNotice): string {
  const suggested =
    d.suggestedCategory && isDocumentCategory(d.suggestedCategory)
      ? `sugestia: ${getCategory(d.suggestedCategory).polishLabel}`
      : 'bez sugestii';
  const reasons = d.reviewReasons.map((r) => REASON_LABELS[r] ?? escapeMarkdown(r)).join(', ');
  const parts = [`- ${escapeMarkdown(suggested)}`, reasons || 'do sprawdzenia'];
  if (d.documentMonth) parts.push(d.documentMonth);
  if (d.webUrl?.startsWith('https://') && d.webUrl.length <= REVIEW_NOTICE_MAX_LINK) {
    parts.push(`[Otwórz plik](${linkTarget(d.webUrl)})`);
  }
  return parts.join(' · ');
}

/** A URL Markdown cannot cut short: `(`, `)`, spaces and `<>` percent-encoded. */
function linkTarget(url: string): string {
  return url.replace(
    /[()\s<>]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** As the bot's card text (`teams-bot/src/bot/cardText.ts`): renders literally in a TextBlock. */
const INLINE_MARKDOWN = /[\\`*_~[\]()<>#]/g;
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;
const LEADING_BULLET_MARKER = /^(\s*)([-+])(?=\s|$)/;
const LEADING_ORDERED_MARKER = /^(\s*\d+)(\.)(?=\s|$)/;

export function escapeMarkdown(value: string): string {
  return value
    .replace(CONTROL_AND_BIDI, ' ')
    .replace(INLINE_MARKDOWN, (ch) => `\\${ch}`)
    .replace(LEADING_BULLET_MARKER, '$1\\$2')
    .replace(LEADING_ORDERED_MARKER, '$1\\$2');
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
