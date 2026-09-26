import {
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
  type AcceptanceDecision,
} from './acceptancePolicy';
import type { ClassificationOutcome } from './classificationService';
import { boundClientRows, type ClientDirectorySnapshot } from './clientDirectoryReader';
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
import { UserTypeReadError, type UserTypeSource } from './userDirectory';

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
  /** Whether an uploader is a guest (`userType`). */
  readonly users: UserTypeSource;
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
  /** Defaults to {@link INBOX_TICK_DEADLINE_MS}. */
  readonly tickDeadlineMs?: number;
  /** Defaults to {@link INBOX_TICK_HARD_LIMIT_MS}. */
  readonly tickHardLimitMs?: number;
  /** Defaults to {@link CLASSIFICATION_CACHE_TTL_MS}. */
  readonly classificationCacheTtlMs?: number;
  /** Defaults to {@link MAX_PROCESSING_ATTEMPTS}. */
  readonly maxAttempts?: number;
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
   * The classifier could not answer now (429, 529, 5xx, a timeout): left in
   * the inbox for the next tick, not a failure, never sent to review.
   */
  readonly retryLater: number;
  /**
   * Created, or last changed, by someone who is not a guest of this row's
   * Team; no creator id; or no such user: left untouched.
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
  /** Candidates left for the next tick by the budget, the deadline or the time limit. */
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

type UploaderVerdict =
  | 'client'
  | 'not_guest'
  | 'not_in_team'
  | 'unknown_user'
  | 'modified_by_other'
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
}

/**
 * The channel-inbox intake: each bound client's channel folder
 * ("Dokumenty księgowe") is that client's inbox.
 *
 * Teams guests — every client — cannot attach a file in a 1:1 chat with the
 * bot, but can attach one to a channel post or upload it in the channel's
 * files tab, which stores it in the channel folder. Each tick this service
 * takes the files at the top of every bound row's channel folder and moves
 * each client upload, by id, into its taxonomy folder inside that same
 * channel folder.
 *
 * Who the client is follows from WHERE the file is: the one bound Directory
 * row whose drive and channel folder hold it. Never from who uploaded it and
 * never from what it says. A file is taken only when its creator AND whoever
 * changed it last are guests and members of that row's Team (a guest who is
 * also in other Teams is fine: the file is already in this client's space,
 * and nothing crosses). Anything else — a staff or member upload, a guest's
 * file that staff replaced, a guest of another Team — is left untouched.
 *
 * It acts only on the version it listed: right before it reads a file, and
 * again before it moves it, the item must still be a direct child of the
 * channel folder at the listed `eTag`, and the move itself is sent with
 * `If-Match`. A file someone moved, renamed or replaced meanwhile is left
 * where it now is. It never recurses (subfolders are the filed area), never
 * copies, never deletes, never moves across drives and never overwrites. In
 * `shadow` it does everything but write, and logs what it would move. A
 * classifier that cannot answer now leaves the file for the next tick. Logs carry ids, codes, counts and taxonomy paths only.
 */
export class ChannelInbox {
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly deadlineMs: number;
  private readonly hardLimitMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxAttempts: number;
  private readonly onlyRows: ReadonlySet<string> | undefined;
  private readonly placements = new Map<string, CachedPlacement>();
  private readonly failures = new Map<string, number>();
  private readonly reportedSkips = new Set<string>();
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
        retryLater: 0,
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
      await this.sweepRow(row, tick);
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

  private async sweepRow(row: ClientDirectoryEntry, tick: Tick): Promise<void> {
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

    for (const [index, candidate] of selected.candidates.entries()) {
      if (this.outOfBudget(tick)) {
        tick.counts.deferred += selected.candidates.length - index;
        return;
      }
      const uploader = await this.uploaderVerdict(candidate, ids.teamId);
      if (uploader.verdict !== 'client') {
        if (uploader.verdict === 'unverified') tick.counts.skippedUnverified += 1;
        else tick.counts.skippedNotClient += 1;
        this.reportSkipOnce(tick, ids, candidate, uploader.verdict, uploader.status);
        continue;
      }
      tick.processed += 1;
      await this.processFile(row, ids, sharePoint, inbox, candidate, tick);
    }
  }

  /**
   * The inbox is for the client's own uploads: the file's creator must be a
   * guest AND in this row's Team, and so must whoever changed it last — a
   * guest's file that staff replaced holds staff's content. Anything that
   * cannot be read is `unverified` (with Graph's status, when there was one),
   * and the file waits.
   */
  private async uploaderVerdict(
    candidate: InboxCandidate,
    teamId: string,
  ): Promise<{ verdict: UploaderVerdict; status?: number }> {
    const creator = await this.userVerdict(candidate.creatorId, teamId);
    if (creator.verdict !== 'client' || candidate.modifierId === candidate.creatorId) {
      return creator;
    }
    if (!candidate.modifierId) return { verdict: 'modified_by_other' };
    const modifier = await this.userVerdict(candidate.modifierId, teamId);
    if (modifier.verdict === 'client' || modifier.verdict === 'unverified') return modifier;
    return { verdict: 'modified_by_other' };
  }

  /** One user: a guest, and a member of this row's Team? */
  private async userVerdict(
    userId: string,
    teamId: string,
  ): Promise<{ verdict: UploaderVerdict; status?: number }> {
    let userType: string | null;
    try {
      userType = await this.deps.users.userTypeOf(userId);
    } catch (err) {
      return unverified(err);
    }
    if (userType === null) return { verdict: 'unknown_user' };
    if (userType.toLowerCase() !== 'guest') return { verdict: 'not_guest' };
    let teams: ReadonlySet<string>;
    try {
      teams = await this.deps.membership.teamsOf(userId);
    } catch (err) {
      return unverified(err);
    }
    const team = teamId.trim().toLowerCase();
    const inTeam = team !== '' && [...teams].some((t) => t.trim().toLowerCase() === team);
    return { verdict: inTeam ? 'client' : 'not_in_team' };
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
      await this.sortUnclassified(ids, sharePoint, inbox, candidate, tick, { counted: false });
      return;
    }

    let stage: Stage = 'check';
    try {
      const decision = await this.placementFor(row, sharePoint, inbox, candidate, tick);
      if (this.deps.mode === 'shadow') {
        this.reportWouldMove(tick, ids, candidate, decision);
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
      this.forget(driveItemId);
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
    } catch (err) {
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
        await this.sortUnclassified(ids, sharePoint, inbox, candidate, tick, { counted: true });
      }
    }
  }

  /**
   * Not failures, and never counted towards the review fallback: a file that
   * changed since it was listed (`skippedChanged`, logged once as
   * `inbox.skipped` `changed`), one the tick has no time left for
   * (`deferred`), and one the classifier could not answer for now
   * (`retryLater`, logged as `inbox.retry_later` with the API's status). All
   * are left where they are for the next tick.
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
    if (err instanceof ClassificationDeferred) {
      tick.counts.retryLater += 1;
      tick.log.warn(
        {
          event: 'inbox.retry_later',
          clientId: ids.clientId,
          listItemId: ids.listItemId,
          driveItemId: candidate.item.id,
          classifier: err.classifier,
          reason: err.reason,
          ...(err.status !== undefined ? { status: err.status } : {}),
        },
        'inbox.retry_later',
      );
      return true;
    }
    return false;
  }

  /** Shadow: what would be moved, and where. */
  private reportWouldMove(
    tick: Tick,
    ids: RowIds,
    candidate: InboxCandidate,
    decision: AcceptanceDecision,
    extra: Record<string, unknown> = {},
  ): void {
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
  ): Promise<AcceptanceDecision> {
    const now = this.now();
    const cached = this.placements.get(candidate.item.id);
    if (cached && cached.eTag === candidate.eTag && now.getTime() - cached.at < this.cacheTtlMs) {
      return cached.decision;
    }

    if (!this.hasTimeFor(tick, CLASSIFY_RESERVE_MS)) throw new OutOfTime();
    await sharePoint.checkInboxItem(inbox, { id: candidate.item.id, eTag: candidate.eTag });

    // Read lazily: the fallback classifier never reads, so nothing is
    // downloaded when Claude is off. A failed read is a failed attempt, not a
    // file for manual review; a file too big for the classifier is.
    let downloadFailure: unknown;
    let content: Promise<Buffer> | undefined;
    const readContent = (): Promise<Buffer> => {
      content ??= sharePoint
        .downloadInboxItem(inbox, candidate.item.id, this.deps.maxDownloadBytes)
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

    remember(this.placements, candidate.item.id, {
      eTag: candidate.eTag,
      decision: outcome.decision,
      at: now.getTime(),
    });
    return outcome.decision;
  }

  /**
   * After {@link MAX_PROCESSING_ATTEMPTS} failures: into
   * `98_Nieposortowane/YYYY/MM` without classifying, so the inbox drains. If
   * even that fails, the file stays and is logged. The same version check,
   * `If-Match` and time limit apply as to any move.
   */
  private async sortUnclassified(
    ids: RowIds,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
    tick: Tick,
    opts: { readonly counted: boolean },
  ): Promise<void> {
    const driveItemId = candidate.item.id;
    const decision = processingFailedDecision(this.now());
    if (this.deps.mode === 'shadow') {
      this.reportWouldMove(tick, ids, candidate, decision, { unclassified: true });
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
      this.forget(driveItemId);
      tick.counts.sortedToReview += 1;
      tick.log.info(
        {
          event: 'inbox.sorted_to_review',
          ...ids,
          driveItemId,
          ...decisionLogFields(decision),
          nameSuffix: moved.nameSuffix,
          unclassified: true,
        },
        'inbox.sorted_to_review',
      );
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

  private forget(driveItemId: string): void {
    this.placements.delete(driveItemId);
    this.failures.delete(driveItemId);
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

/** A user's object id from a `createdBy`/`lastModifiedBy` identity set; '' when none. */
function userIdOf(identity: { readonly user?: { readonly id?: string } } | undefined): string {
  const id = identity?.user?.id?.trim().toLowerCase() ?? '';
  return GUID.test(id) ? id : '';
}

/** The tick has too little time left for the next stage: the file waits, not a failure. */
class OutOfTime extends Error {
  constructor() {
    super('Not enough time left in this tick');
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
    err instanceof TeamMembershipReadError || err instanceof UserTypeReadError
      ? err.status
      : undefined;
  return { verdict: 'unverified', ...(status !== undefined ? { status } : {}) };
}
