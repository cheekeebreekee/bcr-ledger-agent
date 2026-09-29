import { createHash, randomUUID } from 'node:crypto';
import {
  CLIENT_ACCOUNT_DOMAIN,
  clientAccountVerdict,
  createLogger,
  LedgerAgentError,
  type ClassifierContext,
  type ClientDirectoryEntry,
  type InboxSweepMode,
  type Logger,
  type SharePointTarget,
} from '@bcr/shared';
import {
  decisionLogFields,
  processingFailedDecision,
  retryExhaustedDecision,
  type AcceptanceDecision,
} from './acceptancePolicy';
import type { ClassificationOutcome } from './classificationService';
import { boundClientRows, type ClientDirectorySnapshot } from './clientDirectoryReader';
import { INDEX_OFF, recordFiling, type DocumentIndex, type IndexedClient } from './documentIndex';
import { doublingBackoff, RetryLaterBound } from './retryLaterBound';
import {
  statusOf,
  type PaidClassifications,
  type ShadowMemo,
  type ShadowMemoKey,
} from './shadowMemo';
import {
  ContentTooLargeError,
  graphStatus,
  InboxItemChangedError,
  SharePointTargetError,
  type InboxFolder,
  type InboxItem,
  type SharePointService,
} from './sharePointService';
import { TeamMembershipReadError, type TeamMembershipSource } from './teamMembership';
import { UserAccountReadError, type UserAccount, type UserAccountSource } from './userDirectory';

/**
 * How long one sweep may start new work (a row, or a file). The host's
 * `functionTimeout` is 5 minutes; what is not started by then waits for the
 * next tick.
 */
export const INBOX_TICK_DEADLINE_MS = 150_000;

/**
 * When a tick's work must be over, 30 s inside the host's 5-minute
 * `functionTimeout`. A timed-out invocation restarts the language worker, and
 * with it every upload the bot is sending through that worker, so a file
 * already started does not run on towards it: each stage below starts only
 * with its reserve left, and a file that would pass the limit waits.
 */
export const INBOX_TICK_HARD_LIMIT_MS = 270_000;

/**
 * Time left before {@link INBOX_TICK_HARD_LIMIT_MS} that reading and
 * classifying a file needs: Claude's two 45 s attempts and their backoff,
 * plus the download and a re-check.
 */
export const CLASSIFY_RESERVE_MS = 120_000;

/**
 * Time left that creating the folder chain and moving need: about two dozen
 * Graph calls, each with the SDK's retries off and our bounded retry.
 */
export const WRITE_RESERVE_MS = 60_000;

/** Largest file the sweep takes from an inbox; anything bigger stays where it is. */
export const MAX_INBOX_FILE_BYTES = 100 * 1024 * 1024;

/** How long a file's classification is reused while its eTag is unchanged (ms). */
export const CLASSIFICATION_CACHE_TTL_MS = 60 * 60 * 1000;

/** Processing failures after which a file is sorted to review unclassified. */
export const MAX_PROCESSING_ATTEMPTS = 3;

/**
 * "Retry later" answers a file's version may cause (a timeout, a 5xx, a lost
 * connection) after which it is sorted to review with `RETRY_EXHAUSTED`
 * (`retryLaterBound.ts`). 429, 529 and 401–404 never count.
 */
export const MAX_RETRY_LATER_ATTEMPTS = 5;

/**
 * Paid classifications one version of a file may cost in `enforce`, across
 * worker restarts (`PaidClassifications`). A version is classified again only
 * when it was not moved; at the bound it is sorted to review unclassified
 * (`PROCESSING_FAILED`) instead of being paid for once more.
 */
export const MAX_PAID_CLASSIFICATIONS = 3;

/**
 * The wait after a counted "retry later" before the file is read again:
 * doubling from 10 minutes, at most 2 hours. With five attempts the fifth is
 * about 2.5 hours after the first, long enough for an API incident to pass,
 * and the file costs a tick's two 45 s attempts five times, not every tick.
 */
export const RETRY_LATER_BACKOFF_MS = 10 * 60 * 1000;
export const RETRY_LATER_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;

/** Files whose classification, failure count or log line are remembered at once. */
const MAX_TRACKED_FILES = 1000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the sweep needs of a client target's SharePoint service. */
export type InboxSharePoint = Pick<
  SharePointService,
  | 'resolveInbox'
  | 'listInboxChildren'
  | 'checkInboxItem'
  | 'downloadInboxItem'
  | 'ensureInboxFolder'
  | 'moveWithinInbox'
>;

/** The CLIENT SharePoint factory, narrowed: its guard refuses BCR GROUP and the quarantine. */
export interface InboxSharePointFactory {
  forTarget(target: SharePointTarget): InboxSharePoint;
}

export interface ChannelInboxDeps {
  /** `INBOX_SWEEP_MODE`. `off` sweeps nothing; `shadow` writes nothing. */
  readonly mode: InboxSweepMode;
  readonly directory: { getSnapshot(): Promise<ClientDirectorySnapshot> };
  /**
   * The client factory (`clientSharePointFactory`), never the quarantine's:
   * a row whose site resolves to BCR GROUP or the quarantine is refused
   * before anything is listed there.
   */
  readonly sharePointFactory: InboxSharePointFactory;
  /**
   * An uploader's account (`userType`, `userPrincipalName`): the creator must
   * be the row's client account, an Entra Member whose UPN is
   * `{row NIP}@bcr-group.pl`.
   */
  readonly accounts: UserAccountSource;
  /** The client accounts' domain. Defaults to `CLIENT_ACCOUNT_DOMAIN`; injected in tests. */
  readonly clientAccountDomain?: string;
  /** Which Teams an uploader is in (the cached Entra read the resolver uses). */
  readonly membership: TeamMembershipSource;
  /**
   * Classification, the acceptance policy included: where to file, or retry
   * later. Given the tick's clock, for the review folder's month.
   */
  readonly classification: {
    classify(ctx: ClassifierContext, now?: Date): Promise<ClassificationOutcome>;
  };
  /** `INBOX_MIN_AGE_MS`: younger files may still be uploading. */
  readonly minAgeMs: number;
  /** `INBOX_MAX_FILES_PER_TICK`, across all rows. */
  readonly maxFilesPerTick: number;
  /** Most bytes read of one file for the classifier; more and it is not read. */
  readonly maxDownloadBytes: number;
  /**
   * `INBOX_SWEEP_ROWS`: when not empty, only these Directory rows (list item
   * ids) are swept, and only if the snapshot routes to them. Empty or absent:
   * every routed row.
   */
  readonly onlyRows?: readonly string[];
  /**
   * `INBOX_CREATED_AFTER` (epoch ms): a file created at or before it is left
   * where it is. Absent: no cutoff.
   */
  readonly createdAfterMs?: number;
  /**
   * The document index (`LEDGER_INDEX_MODE`): told about every file moved in
   * `enforce`, never in `shadow`. It never throws. Defaults to off.
   */
  readonly index?: DocumentIndex;
  /**
   * Shadow: which file versions were already reported, kept across worker
   * restarts so a restart does not pay to classify them again. A version the
   * memo cannot answer for is left for a later tick, never classified.
   * Absent: this worker's memory only.
   */
  readonly shadowMemo?: ShadowMemo;
  /**
   * Enforce: paid classifications per file version, kept across worker
   * restarts, at most {@link MAX_PAID_CLASSIFICATIONS}. A count that cannot be
   * read leaves the file for a later tick, never a paid classification.
   * Absent: bounded by this worker's memory only.
   */
  readonly paidClassifications?: PaidClassifications;
  /** Defaults to {@link INBOX_TICK_DEADLINE_MS}. */
  readonly tickDeadlineMs?: number;
  /** Defaults to {@link INBOX_TICK_HARD_LIMIT_MS}. */
  readonly tickHardLimitMs?: number;
  /** Defaults to {@link CLASSIFICATION_CACHE_TTL_MS}. */
  readonly classificationCacheTtlMs?: number;
  /** Defaults to {@link MAX_PROCESSING_ATTEMPTS}. */
  readonly maxAttempts?: number;
  /** Defaults to {@link MAX_RETRY_LATER_ATTEMPTS}. */
  readonly maxRetryLaterAttempts?: number;
  /** First backoff after a counted "retry later"; defaults to {@link RETRY_LATER_BACKOFF_MS}. */
  readonly retryLaterBackoffMs?: number;
  readonly now?: () => Date;
  /** Injected in tests; defaults to the `ingestion/channelInbox` logger. */
  readonly log?: Logger;
}

/** The `inbox.tick` line: counts only. */
export interface InboxTickSummary {
  readonly mode: InboxSweepMode;
  /** Bound client rows due to be swept (only those in `INBOX_SWEEP_ROWS`, when it is set). */
  readonly rows: number;
  /** Direct children that are files old enough, with a creator id. */
  readonly candidates: number;
  /** Moved into a taxonomy folder (enforce). */
  readonly filed: number;
  /** Moved into `98_Nieposortowane/YYYY/MM` (enforce). */
  readonly sortedToReview: number;
  /** Would have been moved (shadow): logged as `inbox.would_move` this tick. */
  readonly wouldMove: number;
  /**
   * Shadow: unchanged since its `inbox.would_move` was logged, by this worker
   * or, with the shadow memo, by any earlier one. Not processed again, and not
   * counted against the file budget.
   */
  readonly alreadyReported: number;
  /**
   * The classifier could not answer now (429, 529, 5xx, a timeout): left in
   * the inbox for a later tick, not a failure. Only a reason the file may
   * cause (a timeout, a 5xx, a lost connection) counts towards its bound.
   */
  readonly retryLater: number;
  /**
   * Waiting out the backoff after a counted "retry later": not read, and not
   * counted against the file budget.
   */
  readonly retryLaterWaiting: number;
  /**
   * Created by someone who is not this row's client account (a guest, staff,
   * another client's account, an account not in the row's Team alone), or
   * last changed by anyone but its creator; no creator id; or no such user:
   * left untouched.
   */
  readonly skippedNotClient: number;
  /** The uploader could not be read this tick: left untouched, read again next tick. */
  readonly skippedUnverified: number;
  /** Modified within `INBOX_MIN_AGE_MS`. */
  readonly skippedYoung: number;
  /** Empty, over 100 MiB, an Office lock / hidden file, or no `eTag`. */
  readonly skippedIneligible: number;
  /** Created at or before `INBOX_CREATED_AFTER`: left where it is. */
  readonly skippedBeforeCutoff: number;
  /**
   * Moved, renamed, replaced or deleted by someone since the listing: left
   * where it is now, and seen afresh by the next listing.
   */
  readonly skippedChanged: number;
  /**
   * Candidates left for the next tick by the budget, the deadline or the time
   * limit, or in shadow because the shadow memo could not be read.
   */
  readonly deferred: number;
  /** Files whose processing failed this tick. */
  readonly failed: number;
  /** Rows whose channel folder could not be resolved or listed. */
  readonly rowsFailed: number;
  readonly durationMs: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A direct child the sweep may process, once its uploader is checked. */
export interface InboxCandidate {
  readonly item: InboxItem;
  readonly name: string;
  readonly creatorId: string;
  /** `lastModifiedBy.user.id`, lower-cased; empty when the last change was not a user's. */
  readonly modifierId: string;
  /** The listed version. Every read and write of the item is checked against it. */
  readonly eTag: string;
}

type Stage = 'check' | 'download' | 'classify' | 'folder' | 'move';

/** Whose upload a file is. Only `client` is filed; `unverified` waits and is read again. */
type UploaderVerdict =
  | 'client'
  /** The creator is a Guest: any guest, this Team's included. */
  | 'guest'
  /** The creator's `userType` is neither Member nor Guest. */
  | 'not_member'
  /** Entra has no such user (404). */
  | 'unknown_user'
  /** A Member not routed to THIS row: staff, another client's account, an unbound `{NIP}@` account. */
  | 'not_bound'
  /** Bound on this row, but its UPN is not `{row NIP}@domain`, or the row's NIP is invalid. */
  | 'not_client_account'
  /** The row's client account, not in the row's Team. */
  | 'not_in_team'
  /** The row's client account, also in another Team. */
  | 'other_teams'
  /** The last modifier is not the creator (or is missing). */
  | 'modified_by_other'
  /** A read failed: the file waits, read again next tick. */
  | 'unverified';

type SkipReason = Exclude<UploaderVerdict, 'client'> | 'changed';

/**
 * Where a file goes (its `folderPath` is relative to the channel folder,
 * taxonomy only), as the acceptance policy decided for the listed version.
 */
interface CachedPlacement {
  readonly eTag: string;
  readonly decision: AcceptanceDecision;
  readonly at: number;
  /** Hex SHA-256 of the bytes the classifier read, when it read them. */
  readonly contentSha256?: string;
}

interface RowIds {
  readonly clientId: string;
  readonly listItemId: string;
  readonly teamId: string;
}

interface Tick {
  readonly startedAt: number;
  readonly log: Logger;
  readonly counts: Mutable<Omit<InboxTickSummary, 'mode' | 'durationMs'>>;
  processed: number;
  /** Memo operations (`event|operation`) whose failure this tick has logged already. */
  readonly memoFailures: Set<string>;
}

/**
 * The channel-inbox intake: each bound client's channel folder
 * ("Dokumenty księgowe") is that client's inbox.
 *
 * A client signs in to Teams with its `{NIP}@bcr-group.pl` account and posts
 * a file in its Team's channel (a post with an attachment, or the channel's
 * files tab), which stores it in the channel folder. Each tick this service
 * takes the files at the top of every bound row's channel folder and moves
 * each client upload, by id, into its taxonomy folder inside that same
 * channel folder.
 *
 * Who the client is follows from WHERE the file is: the one bound Directory
 * row whose drive and channel folder hold it. Never from who uploaded it and
 * never from what it says. A file is taken only when its creator is that
 * row's client account — the one id the snapshot routes to this row, an Entra
 * Member whose UPN is `{row NIP}@bcr-group.pl`, in this row's Team and no
 * other — and whoever changed it last is that same id. Anything else — a
 * guest (of this Team or any other), staff, another client's account, a
 * client's file that someone else replaced, a client account also in another
 * Team — is left untouched. A row with no valid NIP, or no bound client
 * account, files nothing.
 *
 * It acts only on the version it listed: right before it reads a file, and
 * again before it moves it, the item must still be a direct child of the
 * channel folder at the listed `eTag`, and the move itself is sent with
 * `If-Match`. A file someone moved, renamed or replaced meanwhile is left
 * where it now is. It never recurses (subfolders are the filed area), never
 * copies, never deletes, never moves across drives and never overwrites. In
 * `shadow` it does everything but write to SharePoint, and logs what it would
 * move once per version of a file and classifier release — across worker
 * restarts too, through the shadow memo. A classifier that cannot answer now
 * leaves the file for a later tick; when the reason may be the file's own (a
 * timeout, a 5xx), the file waits out a backoff, and after
 * {@link MAX_RETRY_LATER_ATTEMPTS} such answers it goes to review
 * (`RETRY_EXHAUSTED`) instead of being retried forever. Logs carry ids, codes,
 * counts and taxonomy paths only.
 *
 * In `enforce`, each file moved (filed, or sorted to review) is then recorded
 * in the document index under this row's client; an index failure is logged
 * and changes nothing here. `shadow` records nothing in the index.
 */
export class ChannelInbox {
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly deadlineMs: number;
  private readonly hardLimitMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxAttempts: number;
  private readonly onlyRows: ReadonlySet<string> | undefined;
  private readonly index: DocumentIndex;
  private readonly domain: string;
  private readonly placements = new Map<string, CachedPlacement>();
  private readonly failures = new Map<string, number>();
  private readonly reportedSkips = new Set<string>();
  /** Counted "retry later" answers, per (driveItemId, eTag). */
  private readonly retryLaters: RetryLaterBound;
  /** Shadow: the (driveItemId, eTag) pairs whose `inbox.would_move` this worker logged. */
  private readonly reportedMoves = new Set<string>();
  /** The row to start the next tick with (its list item id). */
  private cursor: string | undefined;
  private running = false;

  constructor(private readonly deps: ChannelInboxDeps) {
    this.log = deps.log ?? createLogger('ingestion/channelInbox');
    this.now = deps.now ?? (() => new Date());
    this.deadlineMs = deps.tickDeadlineMs ?? INBOX_TICK_DEADLINE_MS;
    this.hardLimitMs = deps.tickHardLimitMs ?? INBOX_TICK_HARD_LIMIT_MS;
    this.cacheTtlMs = deps.classificationCacheTtlMs ?? CLASSIFICATION_CACHE_TTL_MS;
    this.maxAttempts = deps.maxAttempts ?? MAX_PROCESSING_ATTEMPTS;
    this.onlyRows = deps.onlyRows?.length ? new Set(deps.onlyRows) : undefined;
    this.index = deps.index ?? INDEX_OFF;
    this.domain = deps.clientAccountDomain ?? CLIENT_ACCOUNT_DOMAIN;
    this.retryLaters = new RetryLaterBound({
      maxAttempts: deps.maxRetryLaterAttempts ?? MAX_RETRY_LATER_ATTEMPTS,
      backoffMs: doublingBackoff(
        deps.retryLaterBackoffMs ?? RETRY_LATER_BACKOFF_MS,
        RETRY_LATER_BACKOFF_MAX_MS,
      ),
    });
  }

  get mode(): InboxSweepMode {
    return this.deps.mode;
  }

  /**
   * One tick. Never throws: a failing row or file is logged and counted, and
   * the rest go on. Logs one `inbox.tick` summary (not in `off`).
   */
  async sweep(log: Logger = this.log): Promise<InboxTickSummary> {
    const tick: Tick = {
      startedAt: this.now().getTime(),
      log,
      counts: {
        rows: 0,
        candidates: 0,
        filed: 0,
        sortedToReview: 0,
        wouldMove: 0,
        alreadyReported: 0,
        retryLater: 0,
        retryLaterWaiting: 0,
        skippedNotClient: 0,
        skippedUnverified: 0,
        skippedYoung: 0,
        skippedIneligible: 0,
        skippedBeforeCutoff: 0,
        skippedChanged: 0,
        deferred: 0,
        failed: 0,
        rowsFailed: 0,
      },
      processed: 0,
      memoFailures: new Set(),
    };
    if (this.deps.mode === 'off') return this.summary(tick);
    // Timer ticks are singletons across instances; this also keeps a slow
    // tick and the next one on this worker from sweeping the same files.
    if (this.running) {
      log.warn({ event: 'inbox.tick_overlap' }, 'inbox.tick_overlap');
      return this.summary(tick);
    }
    this.running = true;
    try {
      await this.sweepRows(tick);
    } catch (err) {
      // Nothing below is expected to throw; if it does, the tick ends here.
      log.error({ event: 'inbox.tick_failed', err: describeError(err) }, 'inbox.tick_failed');
    } finally {
      this.running = false;
    }
    const summary = this.summary(tick);
    log.info({ event: 'inbox.tick', ...summary }, 'inbox.tick');
    return summary;
  }

  private async sweepRows(tick: Tick): Promise<void> {
    const snapshot = await this.deps.directory.getSnapshot();
    if (snapshot.health !== 'fresh') {
      tick.log.warn({ event: 'inbox.directory_unavailable' }, 'inbox.directory_unavailable');
    }
    const routed = boundClientRows(snapshot);
    const onlyRows = this.onlyRows;
    const rows = this.inTurn(onlyRows ? routed.filter((r) => onlyRows.has(r.listItemId)) : routed);
    tick.counts.rows = rows.length;
    let lastTurn = -1;
    for (const [index, row] of rows.entries()) {
      if (this.outOfBudget(tick)) break;
      lastTurn = index;
      await this.sweepRow(row, tick, clientAccountIdsOf(row, snapshot));
    }
    // Round robin: the next tick starts after the last row that had a turn,
    // so a row with a backlog cannot keep the others waiting.
    if (rows.length > 0) {
      const next = lastTurn === rows.length - 1 ? 1 : lastTurn + 1;
      this.cursor = rows[next % rows.length]?.listItemId;
    }
  }

  /** The rows in a stable order, starting at the cursor. */
  private inTurn(rows: ClientDirectoryEntry[]): ClientDirectoryEntry[] {
    const start = rows.findIndex((r) => r.listItemId === this.cursor);
    return start <= 0 ? rows : [...rows.slice(start), ...rows.slice(0, start)];
  }

  /** Whether a new row or file may start: the file budget and the 150 s deadline. */
  private outOfBudget(tick: Tick): boolean {
    return (
      tick.processed >= this.deps.maxFilesPerTick ||
      this.now().getTime() - tick.startedAt >= this.deadlineMs
    );
  }

  /** Whether a stage that needs `reserveMs` may still start before the hard limit. */
  private hasTimeFor(tick: Tick, reserveMs: number): boolean {
    return this.hardLimitMs - (this.now().getTime() - tick.startedAt) >= reserveMs;
  }

  private async sweepRow(
    row: ClientDirectoryEntry,
    tick: Tick,
    clientAccountIds: ReadonlySet<string>,
  ): Promise<void> {
    const ids: RowIds = {
      clientId: row.clientId,
      listItemId: row.listItemId,
      teamId: row.teamId ?? '',
    };
    const sharePoint = this.deps.sharePointFactory.forTarget(row.target);
    let inbox: InboxFolder;
    let children: InboxItem[];
    let stage: 'resolve' | 'list' = 'resolve';
    try {
      inbox = await sharePoint.resolveInbox();
      stage = 'list';
      children = await sharePoint.listInboxChildren(inbox);
    } catch (err) {
      tick.counts.rowsFailed += 1;
      tick.log.warn(
        { event: 'inbox.row_failed', ...ids, stage, err: describeError(err) },
        'inbox.row_failed',
      );
      return;
    }

    const selected = selectCandidates(children, {
      now: this.now(),
      minAgeMs: this.deps.minAgeMs,
      ...(this.deps.createdAfterMs !== undefined
        ? { createdAfterMs: this.deps.createdAfterMs }
        : {}),
    });
    tick.counts.candidates += selected.candidates.length;
    tick.counts.skippedYoung += selected.young;
    tick.counts.skippedIneligible += selected.ineligible;
    tick.counts.skippedBeforeCutoff += selected.beforeCutoff;
    tick.counts.skippedNotClient += selected.noCreator;

    for (const candidate of selected.candidates) {
      // The budget is for files that need work. In shadow, a version already
      // reported needs none: without this, the same cached files took the
      // whole budget every tick and the rest of a channel was never reached.
      if (this.deps.mode === 'shadow' && this.reportedMoves.has(versionKey(candidate))) {
        tick.counts.alreadyReported += 1;
        continue;
      }
      // Nor does a version waiting out its backoff after a "retry later".
      if (this.retryLaters.isWaiting(versionKey(candidate), this.now().getTime())) {
        tick.counts.retryLaterWaiting += 1;
        continue;
      }
      if (this.outOfBudget(tick)) {
        tick.counts.deferred += 1;
        continue;
      }
      const uploader = await this.uploaderVerdict(candidate, row, clientAccountIds);
      if (uploader.verdict !== 'client') {
        if (uploader.verdict === 'unverified') tick.counts.skippedUnverified += 1;
        else tick.counts.skippedNotClient += 1;
        this.reportSkipOnce(tick, ids, candidate, uploader.verdict, uploader.status);
        continue;
      }
      // Reported by an earlier worker? A memo that cannot answer is a wait,
      // never a paid classification.
      if (this.deps.mode === 'shadow') {
        const reported = await this.reportedEarlier(tick, ids, candidate);
        if (reported !== false) {
          if (reported === true) tick.counts.alreadyReported += 1;
          else tick.counts.deferred += 1;
          continue;
        }
      }
      tick.processed += 1;
      await this.processFile(row, ids, sharePoint, inbox, candidate, tick);
    }
  }

  /**
   * The inbox is for the row's client account's own uploads. The creator
   * must be a Member the snapshot routes to THIS row, whose UPN is
   * `{row NIP}@domain` (`clientAccountVerdict`), and whose Teams are exactly
   * the row's; and whoever changed the file last must be that same id: at
   * most one account per row passes the rule, so anyone else is someone else,
   * and the modifier is never read. Anything that cannot be read is
   * `unverified` (with Graph's status, when there was one), and the file
   * waits.
   */
  private async uploaderVerdict(
    candidate: InboxCandidate,
    row: ClientDirectoryEntry,
    clientAccountIds: ReadonlySet<string>,
  ): Promise<{ verdict: UploaderVerdict; status?: number }> {
    const creatorId = candidate.creatorId.trim().toLowerCase();
    let account: UserAccount | null;
    try {
      account = await this.deps.accounts.accountOf(creatorId);
    } catch (err) {
      return unverified(err);
    }
    if (account === null) return { verdict: 'unknown_user' };
    const type = (account.userType ?? '').trim().toLowerCase();
    if (type === 'guest') return { verdict: 'guest' };
    if (type !== 'member') return { verdict: 'not_member' };
    if (!clientAccountIds.has(creatorId)) return { verdict: 'not_bound' };
    if (clientAccountVerdict(account, row.nip, this.domain) !== 'client') {
      return { verdict: 'not_client_account' };
    }

    let teams: ReadonlySet<string>;
    try {
      teams = new Set(
        [...(await this.deps.membership.teamsOf(creatorId))].map((t) => t.trim().toLowerCase()),
      );
    } catch (err) {
      return unverified(err);
    }
    const team = (row.teamId ?? '').trim().toLowerCase();
    if (team === '' || !teams.has(team)) return { verdict: 'not_in_team' };
    if (teams.size > 1) return { verdict: 'other_teams' };

    const modifierId = candidate.modifierId.trim().toLowerCase();
    if (!modifierId || modifierId !== creatorId) return { verdict: 'modified_by_other' };
    return { verdict: 'client' };
  }

  /** One line per skipped file and reason while this worker runs: ids only. */
  private reportSkipOnce(
    tick: Tick,
    ids: RowIds,
    candidate: InboxCandidate,
    reason: SkipReason,
    status?: number,
  ): void {
    const key = `${candidate.item.id}|${reason}`;
    if (this.reportedSkips.has(key)) return;
    remember(this.reportedSkips, key);
    tick.log.info(
      {
        event: 'inbox.skipped',
        clientId: ids.clientId,
        listItemId: ids.listItemId,
        driveItemId: candidate.item.id,
        reason,
        ...(status !== undefined ? { status } : {}),
      },
      'inbox.skipped',
    );
  }

  private async processFile(
    row: ClientDirectoryEntry,
    ids: RowIds,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    tick: Tick,
  ): Promise<void> {
    const driveItemId = candidate.item.id;
    const attemptsBefore = this.failures.get(driveItemId) ?? 0;
    if (attemptsBefore >= this.maxAttempts) {
      await this.sortUnclassified(row, ids, sharePoint, inbox, candidate, tick, {
        counted: false,
      });
      return;
    }
    // Reached its bound on an earlier tick, and the move did not happen then.
    const exhausted = this.retryLaters.exhausted(versionKey(candidate), this.now().getTime());
    if (exhausted) {
      await this.sortRetryExhausted(row, ids, sharePoint, inbox, candidate, tick, exhausted);
      return;
    }

    let stage: Stage = 'check';
    try {
      const placement = await this.placementFor(row, sharePoint, inbox, candidate, tick);
      const decision = placement.decision;
      if (this.deps.mode === 'shadow') {
        await this.reportWouldMove(tick, ids, candidate, decision);
        return;
      }
      if (!this.hasTimeFor(tick, WRITE_RESERVE_MS)) throw new OutOfTime();
      stage = 'folder';
      const folderId = await sharePoint.ensureInboxFolder(inbox, decision.folderPath);
      stage = 'move';
      const moved = await sharePoint.moveWithinInbox(
        inbox,
        { id: driveItemId, eTag: candidate.eTag },
        candidate.name,
        folderId,
      );
      this.forget(candidate);
      const event = decision.review ? 'inbox.sorted_to_review' : 'inbox.filed';
      if (decision.review) tick.counts.sortedToReview += 1;
      else tick.counts.filed += 1;
      tick.log.info(
        {
          event,
          ...ids,
          driveItemId,
          ...decisionLogFields(decision),
          nameSuffix: moved.nameSuffix,
        },
        event,
      );
      await this.recordInIndex(row, inbox, candidate, moved, decision, tick, placement);
    } catch (err) {
      if (err instanceof ClassificationDeferred) {
        await this.deferClassification(err, row, ids, sharePoint, inbox, candidate, tick);
        return;
      }
      if (err instanceof PaidBudgetExhausted) {
        await this.sortUnclassified(row, ids, sharePoint, inbox, candidate, tick, {
          counted: false,
          extra: { paidClassifications: err.paid },
        });
        return;
      }
      if (this.leftForLater(err, tick, ids, candidate)) return;
      const attempt = attemptsBefore + 1;
      remember(this.failures, driveItemId, attempt);
      tick.counts.failed += 1;
      const failedStage = err instanceof StageFailure ? err.stage : stage;
      const cause = err instanceof StageFailure ? err.cause : err;
      tick.log.warn(
        {
          event: 'inbox.failed',
          clientId: ids.clientId,
          listItemId: ids.listItemId,
          driveItemId,
          stage: failedStage,
          attempt,
          err: describeError(cause),
        },
        'inbox.failed',
      );
      if (attempt >= this.maxAttempts) {
        await this.sortUnclassified(row, ids, sharePoint, inbox, candidate, tick, {
          counted: true,
        });
      }
    }
  }

  /**
   * The classifier could not answer now: `inbox.retry_later` with the API's
   * status, not a failure. A reason the file may cause counts towards its
   * bound and starts a backoff; at the bound, the file is sorted to review
   * with `RETRY_EXHAUSTED` (this tick if there is time, else the next).
   */
  private async deferClassification(
    err: ClassificationDeferred,
    row: ClientDirectoryEntry,
    ids: RowIds,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    tick: Tick,
  ): Promise<void> {
    tick.counts.retryLater += 1;
    const nowMs = this.now().getTime();
    const verdict = this.retryLaters.record(versionKey(candidate), err.reason, err.status, nowMs);
    tick.log.warn(
      {
        event: 'inbox.retry_later',
        clientId: ids.clientId,
        listItemId: ids.listItemId,
        driveItemId: candidate.item.id,
        classifier: err.classifier,
        reason: err.reason,
        ...(err.status !== undefined ? { status: err.status } : {}),
        counted: verdict.counted,
        retryLaterAttempt: verdict.attempts,
        maxRetryLaterAttempts: this.retryLaters.maxAttempts,
        ...(verdict.notBefore !== undefined ? { retryAfterMs: verdict.notBefore - nowMs } : {}),
      },
      'inbox.retry_later',
    );
    if (verdict.exhausted) {
      await this.sortRetryExhausted(row, ids, sharePoint, inbox, candidate, tick, {
        attempts: verdict.attempts,
        reason: err.reason,
        ...(err.status !== undefined ? { status: err.status } : {}),
      });
    }
  }

  /**
   * Not failures, and never counted towards the review fallback: a file that
   * changed since it was listed (`skippedChanged`, logged once as
   * `inbox.skipped` `changed`) and one the tick has no time left for
   * (`deferred`). Both are left where they are for the next tick.
   */
  private leftForLater(
    err: unknown,
    tick: Tick,
    ids: RowIds,
    candidate: InboxCandidate,
    opts: { readonly countDeferred: boolean } = { countDeferred: true },
  ): boolean {
    if (err instanceof OutOfTime) {
      if (opts.countDeferred) tick.counts.deferred += 1;
      return true;
    }
    if (err instanceof InboxItemChangedError) {
      tick.counts.skippedChanged += 1;
      this.reportSkipOnce(tick, ids, candidate, 'changed');
      return true;
    }
    return false;
  }

  /**
   * Shadow: one `inbox.would_move` per version of a file, recorded in the
   * shadow memo so no later worker classifies that version again. A failed
   * write is logged; the version may then be classified once more after a
   * restart.
   */
  private async reportWouldMove(
    tick: Tick,
    ids: RowIds,
    candidate: InboxCandidate,
    decision: AcceptanceDecision,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const key = versionKey(candidate);
    if (this.reportedMoves.has(key)) return;
    remember(this.reportedMoves, key);
    tick.counts.wouldMove += 1;
    tick.log.info(
      {
        event: 'inbox.would_move',
        ...ids,
        driveItemId: candidate.item.id,
        review: decision.review,
        ...decisionLogFields(decision),
        ...extra,
      },
      'inbox.would_move',
    );
    const memo = this.deps.shadowMemo;
    if (!memo) return;
    try {
      await memo.add(memoKey(ids, candidate));
    } catch (err) {
      this.reportMemoFailureOnce(tick, ids, 'write', err);
    }
  }

  /**
   * Shadow: whether an earlier worker reported this version (`true`), not
   * (`false`), or the memo could not say (`'unknown'`: the file waits).
   */
  private async reportedEarlier(
    tick: Tick,
    ids: RowIds,
    candidate: InboxCandidate,
  ): Promise<boolean | 'unknown'> {
    const memo = this.deps.shadowMemo;
    if (!memo) return false;
    try {
      if (!(await memo.has(memoKey(ids, candidate)))) return false;
    } catch (err) {
      this.reportMemoFailureOnce(tick, ids, 'read', err);
      return 'unknown';
    }
    remember(this.reportedMoves, versionKey(candidate));
    return true;
  }

  /**
   * One line per memo, operation and tick (`inbox.shadow_memo_failed`, or
   * `inbox.paid_memo_failed` for the enforce count): the error's name and status.
   */
  private reportMemoFailureOnce(
    tick: Tick,
    ids: RowIds,
    operation: 'read' | 'write',
    err: unknown,
    event: 'inbox.shadow_memo_failed' | 'inbox.paid_memo_failed' = 'inbox.shadow_memo_failed',
  ): void {
    const key = `${event}|${operation}`;
    if (tick.memoFailures.has(key)) return;
    tick.memoFailures.add(key);
    const status = statusOf(err);
    tick.log.warn(
      {
        event,
        listItemId: ids.listItemId,
        operation,
        err: { ...describeError(err), ...(status !== undefined ? { status } : {}) },
      },
      event,
    );
  }

  /**
   * Classify once per (driveItemId, eTag) an hour, so a file whose move keeps
   * failing is not sent to the model every tick. The classifier is primed
   * with THIS row's client identity only, as on the bot path; that identity
   * settles invoice direction and nothing else, and it never chooses the
   * client. The acceptance policy's decision is what is cached. A "retry
   * later" is not cached and throws {@link ClassificationDeferred}.
   *
   * Before anything is read, the tick must have {@link CLASSIFY_RESERVE_MS}
   * left, and the item must still be the listed version at the top of the
   * inbox: a file moved elsewhere or replaced since is never downloaded.
   */
  private async placementFor(
    row: ClientDirectoryEntry,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    tick: Tick,
  ): Promise<CachedPlacement> {
    const now = this.now();
    const cached = this.placements.get(candidate.item.id);
    if (cached && cached.eTag === candidate.eTag && now.getTime() - cached.at < this.cacheTtlMs) {
      return cached;
    }

    if (!this.hasTimeFor(tick, CLASSIFY_RESERVE_MS)) throw new OutOfTime();
    await sharePoint.checkInboxItem(inbox, { id: candidate.item.id, eTag: candidate.eTag });
    const paid = this.deps.mode === 'enforce' ? this.deps.paidClassifications : undefined;
    if (paid) {
      let count: number;
      try {
        count = await paid.count(memoKey(rowIdsOf(row), candidate));
      } catch (err) {
        this.reportMemoFailureOnce(tick, rowIdsOf(row), 'read', err, 'inbox.paid_memo_failed');
        throw new OutOfTime();
      }
      if (count >= MAX_PAID_CLASSIFICATIONS) throw new PaidBudgetExhausted(count);
    }

    // Read lazily: the fallback classifier never reads, so nothing is
    // downloaded when Claude is off. A failed read is a failed attempt, not a
    // file for manual review; a file too big for the classifier is.
    let downloadFailure: unknown;
    let content: Promise<Buffer> | undefined;
    let contentSha256: string | undefined;
    const readContent = (): Promise<Buffer> => {
      content ??= sharePoint
        .downloadInboxItem(inbox, candidate.item.id, this.deps.maxDownloadBytes)
        .then((bytes) => {
          // For the index only: which bytes were classified.
          contentSha256 = createHash('sha256').update(bytes).digest('hex');
          return bytes;
        })
        .catch((err: unknown) => {
          if (!(err instanceof ContentTooLargeError)) downloadFailure = err;
          throw err;
        });
      return content;
    };
    const companyName = row.companyNameAliases[0] ?? row.title;
    let outcome: ClassificationOutcome;
    try {
      outcome = await this.deps.classification.classify(
        {
          filename: candidate.name,
          contentType: candidate.item.file?.mimeType || 'application/octet-stream',
          readContent,
          ...(row.nip || companyName ? { client: { nip: row.nip, companyName } } : {}),
        },
        now,
      );
    } catch (err) {
      throw new StageFailure('classify', err);
    }
    if (downloadFailure !== undefined) throw new StageFailure('download', downloadFailure);
    if (outcome.kind === 'retry_later') throw new ClassificationDeferred(outcome);
    // Classified: earlier "retry later" answers no longer count.
    this.retryLaters.forget(versionKey(candidate));
    // Billed (a model answered, usable or not): one more toward the bound.
    if (paid && outcome.decision.usage) {
      try {
        await paid.add(memoKey(rowIdsOf(row), candidate));
      } catch (err) {
        this.reportMemoFailureOnce(tick, rowIdsOf(row), 'write', err, 'inbox.paid_memo_failed');
      }
    }

    const placement: CachedPlacement = {
      eTag: candidate.eTag,
      decision: outcome.decision,
      at: now.getTime(),
      ...(contentSha256 ? { contentSha256 } : {}),
    };
    remember(this.placements, candidate.item.id, placement);
    return placement;
  }

  /**
   * After a move in `enforce`: the file's row in the document index, under
   * this row's client (the row whose channel folder holds the file — never
   * anything the file says). Never throws; a failure is `index.write_failed`.
   */
  private async recordInIndex(
    row: ClientDirectoryEntry,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    moved: { readonly id: string; readonly webUrl?: string },
    decision: AcceptanceDecision,
    tick: Tick,
    placement?: CachedPlacement,
  ): Promise<void> {
    await recordFiling(
      this.index,
      {
        documentId: randomUUID(),
        source: 'inbox',
        client: indexedClient(row),
        driveId: inbox.driveId,
        driveItemId: moved.id,
        decision,
        uploadedByOid: candidate.creatorId,
        ...(moved.webUrl ? { webUrl: moved.webUrl } : {}),
        ...(placement?.contentSha256 ? { contentSha256: placement.contentSha256 } : {}),
        ...(typeof candidate.item.size === 'number' ? { sizeBytes: candidate.item.size } : {}),
      },
      tick.log,
    );
  }

  /** At the retry-later bound: into review with `RETRY_EXHAUSTED` and the last status. */
  private async sortRetryExhausted(
    row: ClientDirectoryEntry,
    ids: RowIds,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    tick: Tick,
    last: { readonly attempts: number; readonly reason: string; readonly status?: number },
  ): Promise<void> {
    await this.sortUnclassified(row, ids, sharePoint, inbox, candidate, tick, {
      counted: false,
      decision: retryExhaustedDecision(this.now(), last.reason),
      extra: {
        retryLaterAttempts: last.attempts,
        ...(last.status !== undefined ? { status: last.status } : {}),
      },
    });
  }

  /**
   * After {@link MAX_PROCESSING_ATTEMPTS} failures, or at the retry-later
   * bound: into `98_Nieposortowane/YYYY/MM` without classifying, so the inbox
   * drains. If even that fails, the file stays and is logged. The same version
   * check, `If-Match` and time limit apply as to any move.
   */
  private async sortUnclassified(
    row: ClientDirectoryEntry,
    ids: RowIds,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    tick: Tick,
    opts: {
      readonly counted: boolean;
      readonly decision?: AcceptanceDecision;
      readonly extra?: Record<string, unknown>;
    },
  ): Promise<void> {
    const driveItemId = candidate.item.id;
    const decision = opts.decision ?? processingFailedDecision(this.now());
    const extra = { unclassified: true, ...opts.extra };
    if (this.deps.mode === 'shadow') {
      await this.reportWouldMove(tick, ids, candidate, decision, extra);
      return;
    }
    try {
      if (!this.hasTimeFor(tick, WRITE_RESERVE_MS)) throw new OutOfTime();
      const folderId = await sharePoint.ensureInboxFolder(inbox, decision.folderPath);
      const moved = await sharePoint.moveWithinInbox(
        inbox,
        { id: driveItemId, eTag: candidate.eTag },
        candidate.name,
        folderId,
      );
      this.forget(candidate);
      tick.counts.sortedToReview += 1;
      tick.log.info(
        {
          event: 'inbox.sorted_to_review',
          ...ids,
          driveItemId,
          ...decisionLogFields(decision),
          nameSuffix: moved.nameSuffix,
          ...extra,
        },
        'inbox.sorted_to_review',
      );
      await this.recordInIndex(row, inbox, candidate, moved, decision, tick);
    } catch (err) {
      // A file already counted as failed this tick is not also deferred.
      if (this.leftForLater(err, tick, ids, candidate, { countDeferred: !opts.counted })) return;
      if (!opts.counted) tick.counts.failed += 1;
      tick.log.error(
        {
          event: 'inbox.failed',
          clientId: ids.clientId,
          listItemId: ids.listItemId,
          driveItemId,
          stage: 'review_fallback',
          err: describeError(err),
        },
        'inbox.failed',
      );
    }
  }

  private forget(candidate: InboxCandidate): void {
    this.placements.delete(candidate.item.id);
    this.failures.delete(candidate.item.id);
    this.retryLaters.forget(versionKey(candidate));
  }

  private summary(tick: Tick): InboxTickSummary {
    return {
      mode: this.deps.mode,
      ...tick.counts,
      durationMs: this.now().getTime() - tick.startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests).
// ---------------------------------------------------------------------------

export interface CandidateRules {
  readonly now: Date;
  /** `INBOX_MIN_AGE_MS`: unmodified for at least this long. */
  readonly minAgeMs: number;
  /** `INBOX_CREATED_AFTER` (epoch ms): created strictly after it. */
  readonly createdAfterMs?: number;
}

/**
 * The direct children the sweep may take, oldest first: files (never a folder
 * or a package), with a name that is not an Office lock file (`~$`) or hidden
 * (`.`), more than 0 bytes and at most 100 MiB, with an `eTag` (every later
 * read and write is checked against it), created after the cutoff when there
 * is one, unmodified for `minAgeMs`, and with a creator id. The rest are
 * counted, never touched.
 */
export function selectCandidates(
  children: readonly InboxItem[],
  rules: CandidateRules,
): {
  candidates: InboxCandidate[];
  young: number;
  ineligible: number;
  beforeCutoff: number;
  noCreator: number;
} {
  const { now, minAgeMs, createdAfterMs } = rules;
  const picked: { candidate: InboxCandidate; modified: number }[] = [];
  let young = 0;
  let ineligible = 0;
  let beforeCutoff = 0;
  let noCreator = 0;
  for (const item of children) {
    if (!item.file || item.folder || item.package) continue;
    const name = item.name ?? '';
    const size = item.size;
    const eTag = item.eTag ?? '';
    if (
      !name ||
      name.startsWith('~$') ||
      name.startsWith('.') ||
      typeof size !== 'number' ||
      size <= 0 ||
      size > MAX_INBOX_FILE_BYTES ||
      !eTag
    ) {
      ineligible += 1;
      continue;
    }
    if (createdAfterMs !== undefined) {
      const created = Date.parse(item.createdDateTime ?? '');
      // Unreadable counts as before: the cutoff exists to leave files alone.
      if (!Number.isFinite(created) || created <= createdAfterMs) {
        beforeCutoff += 1;
        continue;
      }
    }
    const modified = Date.parse(item.lastModifiedDateTime ?? '');
    if (!Number.isFinite(modified) || now.getTime() - modified < minAgeMs) {
      young += 1;
      continue;
    }
    const creatorId = userIdOf(item.createdBy);
    if (!creatorId) {
      noCreator += 1;
      continue;
    }
    const modifierId = userIdOf(item.lastModifiedBy);
    picked.push({ candidate: { item, name, creatorId, modifierId, eTag }, modified });
  }
  picked.sort(
    (a, b) =>
      a.modified - b.modified ||
      (a.candidate.item.id < b.candidate.item.id
        ? -1
        : a.candidate.item.id > b.candidate.item.id
          ? 1
          : 0),
  );
  return {
    candidates: picked.map((p) => p.candidate),
    young,
    ineligible,
    beforeCutoff,
    noCreator,
  };
}

/** The index's view of a bound row: its ids and the client's own identity. */
function indexedClient(row: ClientDirectoryEntry): IndexedClient {
  return {
    listItemId: row.listItemId,
    clientNo: row.clientId,
    nip: row.nip,
    legalName: row.companyNameAliases[0] ?? row.title,
  };
}

/** A user's object id from a `createdBy`/`lastModifiedBy` identity set; '' when none. */
function userIdOf(identity: { readonly user?: { readonly id?: string } } | undefined): string {
  const id = identity?.user?.id?.trim().toLowerCase() ?? '';
  return GUID.test(id) ? id : '';
}

/**
 * The ids the snapshot routes to THIS row: the row's own ids only, looked up
 * in the snapshot's id map (the sweep never reads another row). At most one
 * of them can be the row's client account.
 */
function clientAccountIdsOf(
  row: ClientDirectoryEntry,
  snapshot: ClientDirectorySnapshot,
): ReadonlySet<string> {
  return new Set(
    row.userAadObjectIds
      .map((id) => id.trim().toLowerCase())
      .filter((id) => snapshot.byUserAadObjectId.get(id)?.listItemId === row.listItemId),
  );
}

/** One version of one file: the key of what shadow has already reported. */
function versionKey(candidate: InboxCandidate): string {
  return `${candidate.item.id}|${candidate.eTag}`;
}

/** The same version, in this row, for the shadow memo and the paid count. */
function memoKey(ids: Pick<RowIds, 'listItemId'>, candidate: InboxCandidate): ShadowMemoKey {
  return { listItemId: ids.listItemId, driveItemId: candidate.item.id, eTag: candidate.eTag };
}

function rowIdsOf(row: ClientDirectoryEntry): RowIds {
  return { clientId: row.clientId, listItemId: row.listItemId, teamId: row.teamId ?? '' };
}

/** The tick has too little time left for the next stage: the file waits, not a failure. */
class OutOfTime extends Error {
  constructor() {
    super('Not enough time left in this tick');
  }
}

/** The version has had its {@link MAX_PAID_CLASSIFICATIONS}: to review, unclassified. */
class PaidBudgetExhausted extends Error {
  constructor(readonly paid: number) {
    super('Paid classifications exhausted');
  }
}

/** The classifier could not answer now: the file waits for the next tick, not a failure. */
class ClassificationDeferred extends Error {
  readonly classifier: string;
  readonly reason: string;
  readonly status: number | undefined;

  constructor(outcome: Extract<ClassificationOutcome, { kind: 'retry_later' }>) {
    super('Classification deferred');
    this.classifier = outcome.classifier;
    this.reason = outcome.reason;
    this.status = outcome.status;
  }
}

/** A failure in a stage other than the one being run when it surfaced. */
class StageFailure extends Error {
  constructor(
    public readonly stage: Stage,
    public readonly cause: unknown,
  ) {
    super(`Inbox ${stage} failed`);
  }
}

/** Adds to a bounded map or set, dropping the oldest entry when full. */
function remember<K, V>(store: Map<K, V>, key: K, value: V): void;
function remember<K>(store: Set<K>, key: K): void;
function remember<K, V>(store: Map<K, V> | Set<K>, key: K, value?: V): void {
  if (store.size >= MAX_TRACKED_FILES && !store.has(key)) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  if (store instanceof Map) {
    store.delete(key);
    store.set(key, value as V);
  } else {
    store.add(key);
  }
}

/** Name, code and statuses only — never a message: Graph's can carry paths. */
function describeError(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (err instanceof LedgerAgentError) {
    out['name'] = err.name;
    out['code'] = err.code;
    out['httpStatus'] = err.httpStatus;
    const status = graphStatus(err.cause);
    if (status !== undefined) out['status'] = status;
  } else if (err instanceof Error) {
    out['name'] = err.name;
  } else {
    out['type'] = typeof err;
  }
  if (err instanceof SharePointTargetError) out['targetErrorKind'] = err.kind;
  return out;
}

/** An uploader that could not be read, with Graph's status when there was one. */
function unverified(err: unknown): { verdict: 'unverified'; status?: number } {
  const status =
    err instanceof TeamMembershipReadError || err instanceof UserAccountReadError
      ? err.status
      : undefined;
  return { verdict: 'unverified', ...(status !== undefined ? { status } : {}) };
}
