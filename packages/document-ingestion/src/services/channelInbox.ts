import {
  buildFolderPath,
  createLogger,
  FALLBACK_CATEGORY,
  getCategory,
  isDocumentCategory,
  LedgerAgentError,
  type Classification,
  type ClassifierContext,
  type ClientDirectoryEntry,
  type DocumentCategory,
  type InboxSweepMode,
  type Logger,
  type SharePointTarget,
} from '@bcr/shared';
import { boundClientRows, type ClientDirectorySnapshot } from './clientDirectoryReader';
import { applyInvoiceDirection } from './clientResolver';
import {
  ContentTooLargeError,
  graphStatus,
  SharePointTargetError,
  type InboxFolder,
  type InboxItem,
  type SharePointService,
} from './sharePointService';
import { TeamMembershipReadError, type TeamMembershipSource } from './teamMembership';
import { UserTypeReadError, type UserTypeSource } from './userDirectory';

/**
 * How long one sweep may start new work. The host's `functionTimeout` is
 * 5 minutes; what is not started by then waits for the next tick.
 */
export const INBOX_TICK_DEADLINE_MS = 150_000;

/** Largest file the sweep takes from an inbox; anything bigger stays where it is. */
export const MAX_INBOX_FILE_BYTES = 100 * 1024 * 1024;

/** How long a file's classification is reused while its eTag is unchanged (ms). */
export const CLASSIFICATION_CACHE_TTL_MS = 60 * 60 * 1000;

/** Processing failures after which a file is sorted to review unclassified. */
export const MAX_PROCESSING_ATTEMPTS = 3;

/** Files whose classification, failure count or skip log line are remembered at once. */
const MAX_TRACKED_FILES = 1000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the sweep needs of a client target's SharePoint service. */
export type InboxSharePoint = Pick<
  SharePointService,
  | 'resolveInbox'
  | 'listInboxChildren'
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
  readonly classification: { classify(ctx: ClassifierContext): Promise<Classification> };
  /** `INBOX_MIN_AGE_MS`: younger files may still be uploading. */
  readonly minAgeMs: number;
  /** `INBOX_MAX_FILES_PER_TICK`, across all rows. */
  readonly maxFilesPerTick: number;
  /** Most bytes read of one file for the classifier; more and it is not read. */
  readonly maxDownloadBytes: number;
  /** Defaults to {@link INBOX_TICK_DEADLINE_MS}. */
  readonly tickDeadlineMs?: number;
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
  /** Bound client rows whose channel folder was due to be swept. */
  readonly rows: number;
  /** Direct children that are files old enough, with a creator id. */
  readonly candidates: number;
  /** Moved into a taxonomy folder (enforce). */
  readonly filed: number;
  /** Moved into `98_Nieposortowane/YYYY/MM` (enforce). */
  readonly sortedToReview: number;
  /** Would have been moved (shadow). */
  readonly wouldMove: number;
  /** Not a guest of this row's Team, no creator id, or no such user: left untouched. */
  readonly skippedNotClient: number;
  /** The uploader could not be read this tick: left untouched, read again next tick. */
  readonly skippedUnverified: number;
  /** Modified within `INBOX_MIN_AGE_MS`. */
  readonly skippedYoung: number;
  /** Empty, over 100 MiB, or an Office lock / hidden file. */
  readonly skippedIneligible: number;
  /** Candidates left for the next tick by the budget or the deadline. */
  readonly deferred: number;
  /** Files whose processing failed this tick. */
  readonly failed: number;
  /** Rows whose channel folder could not be resolved or listed. */
  readonly rowsFailed: number;
  readonly durationMs: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Where a file goes: a taxonomy folder, relative to the channel folder. */
export interface InboxPlacement {
  readonly category: DocumentCategory;
  readonly folderPath: string;
  /** `98_Nieposortowane`: for manual review. */
  readonly review: boolean;
}

/** A direct child the sweep may process, once its uploader is checked. */
export interface InboxCandidate {
  readonly item: InboxItem;
  readonly name: string;
  readonly creatorId: string;
  readonly eTag: string;
}

type Stage = 'download' | 'classify' | 'folder' | 'move';

type UploaderVerdict = 'client' | 'not_guest' | 'not_in_team' | 'unknown_user' | 'unverified';

interface CachedPlacement {
  readonly eTag: string;
  readonly placement: InboxPlacement;
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
 * never from what it says. A file is taken only when its creator is a guest
 * and a member of that row's Team (a guest who is also in other Teams is
 * fine: the file is already in this client's space, and nothing crosses).
 * Anything else — a staff or member upload, a guest of another Team — is
 * left untouched.
 *
 * It never recurses (subfolders are the filed area), never copies, never
 * deletes, never moves across drives and never overwrites. In `shadow` it
 * does everything but write, and logs what it would move. Logs carry ids and
 * counts only.
 */
export class ChannelInbox {
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly deadlineMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxAttempts: number;
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
    this.cacheTtlMs = deps.classificationCacheTtlMs ?? CLASSIFICATION_CACHE_TTL_MS;
    this.maxAttempts = deps.maxAttempts ?? MAX_PROCESSING_ATTEMPTS;
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
        skippedNotClient: 0,
        skippedUnverified: 0,
        skippedYoung: 0,
        skippedIneligible: 0,
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
    const rows = this.inTurn(boundClientRows(snapshot));
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

  private outOfBudget(tick: Tick): boolean {
    return (
      tick.processed >= this.deps.maxFilesPerTick ||
      this.now().getTime() - tick.startedAt >= this.deadlineMs
    );
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

    const selected = selectCandidates(children, this.now(), this.deps.minAgeMs);
    tick.counts.candidates += selected.candidates.length;
    tick.counts.skippedYoung += selected.young;
    tick.counts.skippedIneligible += selected.ineligible;
    tick.counts.skippedNotClient += selected.noCreator;

    for (const [index, candidate] of selected.candidates.entries()) {
      if (this.outOfBudget(tick)) {
        tick.counts.deferred += selected.candidates.length - index;
        return;
      }
      const uploader = await this.uploaderVerdict(candidate.creatorId, ids.teamId);
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
   * The inbox is for the client's own uploads: its creator must be a guest
   * AND in this row's Team. Anything that cannot be read is `unverified`
   * (with Graph's status, when there was one), and the file waits.
   */
  private async uploaderVerdict(
    creatorId: string,
    teamId: string,
  ): Promise<{ verdict: UploaderVerdict; status?: number }> {
    let userType: string | null;
    try {
      userType = await this.deps.users.userTypeOf(creatorId);
    } catch (err) {
      return unverified(err);
    }
    if (userType === null) return { verdict: 'unknown_user' };
    if (userType.toLowerCase() !== 'guest') return { verdict: 'not_guest' };
    let teams: ReadonlySet<string>;
    try {
      teams = await this.deps.membership.teamsOf(creatorId);
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
    reason: Exclude<UploaderVerdict, 'client'>,
    status: number | undefined,
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

    let stage: Stage = 'classify';
    try {
      const placement = await this.placementFor(row, sharePoint, inbox, candidate);
      if (this.deps.mode === 'shadow') {
        tick.counts.wouldMove += 1;
        tick.log.info(
          {
            event: 'inbox.would_move',
            ...ids,
            driveItemId,
            category: placement.category,
            review: placement.review,
          },
          'inbox.would_move',
        );
        return;
      }
      stage = 'folder';
      const folderId = await sharePoint.ensureInboxFolder(inbox, placement.folderPath);
      stage = 'move';
      const moved = await sharePoint.moveWithinInbox(inbox, driveItemId, candidate.name, folderId);
      this.forget(driveItemId);
      const event = placement.review ? 'inbox.sorted_to_review' : 'inbox.filed';
      if (placement.review) tick.counts.sortedToReview += 1;
      else tick.counts.filed += 1;
      tick.log.info(
        {
          event,
          ...ids,
          driveItemId,
          category: placement.category,
          nameSuffix: moved.nameSuffix,
        },
        event,
      );
    } catch (err) {
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
   * Classify once per (driveItemId, eTag) an hour, so a file whose move keeps
   * failing is not sent to the model every tick. The classifier is primed
   * with THIS row's client identity only, as on the bot path, and the result
   * may only flip invoice direction; it never chooses the client.
   */
  private async placementFor(
    row: ClientDirectoryEntry,
    sharePoint: InboxSharePoint,
    inbox: InboxFolder,
    candidate: InboxCandidate,
  ): Promise<InboxPlacement> {
    const now = this.now();
    const cached = this.placements.get(candidate.item.id);
    if (cached && cached.eTag === candidate.eTag && now.getTime() - cached.at < this.cacheTtlMs) {
      return cached.placement;
    }

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
    const classified = await this.deps.classification.classify({
      filename: candidate.name,
      contentType: candidate.item.file?.mimeType || 'application/octet-stream',
      readContent,
      ...(row.nip || companyName ? { client: { nip: row.nip, companyName } } : {}),
    });
    if (downloadFailure !== undefined) throw new StageFailure('download', downloadFailure);

    const directed = row.nip
      ? (applyInvoiceDirection(classified, row.nip)?.classification ?? classified)
      : classified;
    const placement = inboxPlacement(directed, now);
    remember(this.placements, candidate.item.id, {
      eTag: candidate.eTag,
      placement,
      at: now.getTime(),
    });
    return placement;
  }

  /**
   * After {@link MAX_PROCESSING_ATTEMPTS} failures: into
   * `98_Nieposortowane/YYYY/MM` without classifying, so the inbox drains. If
   * even that fails, the file stays and is logged.
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
    const folderPath = reviewFolderPath(this.now());
    if (this.deps.mode === 'shadow') {
      tick.counts.wouldMove += 1;
      tick.log.info(
        {
          event: 'inbox.would_move',
          ...ids,
          driveItemId,
          category: FALLBACK_CATEGORY,
          review: true,
          unclassified: true,
        },
        'inbox.would_move',
      );
      return;
    }
    try {
      const folderId = await sharePoint.ensureInboxFolder(inbox, folderPath);
      const moved = await sharePoint.moveWithinInbox(inbox, driveItemId, candidate.name, folderId);
      this.forget(driveItemId);
      tick.counts.sortedToReview += 1;
      tick.log.info(
        {
          event: 'inbox.sorted_to_review',
          ...ids,
          driveItemId,
          category: FALLBACK_CATEGORY,
          nameSuffix: moved.nameSuffix,
          unclassified: true,
        },
        'inbox.sorted_to_review',
      );
    } catch (err) {
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

/**
 * The direct children the sweep may take, oldest first: files (never a folder
 * or a package), with a name that is not an Office lock file (`~$`) or hidden
 * (`.`), more than 0 bytes and at most 100 MiB, unmodified for `minAgeMs`,
 * and with a creator id. The rest are counted, never touched.
 */
export function selectCandidates(
  children: readonly InboxItem[],
  now: Date,
  minAgeMs: number,
): { candidates: InboxCandidate[]; young: number; ineligible: number; noCreator: number } {
  const picked: { candidate: InboxCandidate; modified: number }[] = [];
  let young = 0;
  let ineligible = 0;
  let noCreator = 0;
  for (const item of children) {
    if (!item.file || item.folder || item.package) continue;
    const name = item.name ?? '';
    const size = item.size;
    if (
      !name ||
      name.startsWith('~$') ||
      name.startsWith('.') ||
      typeof size !== 'number' ||
      size <= 0 ||
      size > MAX_INBOX_FILE_BYTES
    ) {
      ineligible += 1;
      continue;
    }
    const modified = Date.parse(item.lastModifiedDateTime ?? '');
    if (!Number.isFinite(modified) || now.getTime() - modified < minAgeMs) {
      young += 1;
      continue;
    }
    const creatorId = item.createdBy?.user?.id?.trim().toLowerCase() ?? '';
    if (!GUID.test(creatorId)) {
      noCreator += 1;
      continue;
    }
    picked.push({ candidate: { item, name, creatorId, eTag: item.eTag ?? '' }, modified });
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
  return { candidates: picked.map((p) => p.candidate), young, ineligible, noCreator };
}

/**
 * Where a classified file goes, built with the taxonomy (`buildFolderPath`)
 * from the category id alone, so the model's own folder path is never used.
 * An unknown category, the fallback's result, or a dated category without a
 * usable date goes to `98_Nieposortowane/YYYY/MM` for this month.
 */
export function inboxPlacement(classification: Classification, now: Date): InboxPlacement {
  const category = classification.fields.category;
  if (isDocumentCategory(category) && category !== FALLBACK_CATEGORY) {
    try {
      const folderPath = getCategory(category).dated
        ? buildFolderPath(category, datePartsOf(classification))
        : buildFolderPath(category);
      return { category, folderPath, review: false };
    } catch {
      // A dated category without a usable date: manual review.
    }
  }
  return { category: FALLBACK_CATEGORY, folderPath: reviewFolderPath(now), review: true };
}

/** `98_Nieposortowane/YYYY/MM` for the month of `now` (UTC), like the fallback classifier. */
export function reviewFolderPath(now: Date): string {
  return buildFolderPath(FALLBACK_CATEGORY, {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  });
}

function datePartsOf(c: Classification): { year: number; month: number } {
  const { year, month } = c.fields;
  if (typeof year !== 'number' || typeof month !== 'number') {
    throw new Error('A dated category needs a numeric year and month');
  }
  return { year, month };
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
