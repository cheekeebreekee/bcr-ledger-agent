import {
  CLIENT_ACCOUNT_DOMAIN,
  clientAccountVerdict,
  createLogger,
  type IngestionSource,
  type Logger,
  type QuarantineReason,
  type QuarantineResolution,
  type RefusalReason,
  type RefusedResolution,
  type ResolvedClient,
  type SharePointTarget,
} from '@bcr/shared';
import { isBoundRow, type ClientDirectoryReader } from './clientDirectoryReader';
import { TeamMembershipReadError, type MembershipCheck } from './teamMembership';
import { UserAccountReadError, type UserAccount, type UserAccountSource } from './userDirectory';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ClientResolverOptions {
  /**
   * The staff-only quarantine site. Every Member's upload that cannot be tied
   * to exactly one client goes here. It is never a client Team and never
   * BCR GROUP.
   */
  readonly quarantineTarget: SharePointTarget;
  /**
   * Whether a bound uploader must be in their row's Team and no other, read
   * at upload time (`MEMBERSHIP_CHECK_MODE`). Required, so no resolver can be
   * built that silently skips it; build it with `membershipCheckFor`.
   */
  readonly membership: MembershipCheck;
  /**
   * The uploader's account (`userType`, `userPrincipalName`), read from Entra
   * on every request, before the Directory. Required: the client account
   * rule has no mode.
   */
  readonly accounts: UserAccountSource;
  /** The client accounts' domain. Defaults to `CLIENT_ACCOUNT_DOMAIN`; injected in tests. */
  readonly clientAccountDomain?: string;
  /** Injected in tests; defaults to the `ingestion/clientResolver` logger. */
  readonly log?: Logger;
}

/**
 * Who is asking: the authenticated user id, and nothing that could name a
 * client. `purpose` goes into the log lines only (`upload` when absent); it
 * changes nothing about the decision.
 */
export type ResolveRequest = Pick<IngestionSource, 'userAadObjectId'> & {
  readonly purpose?: 'upload' | 'search';
};

/**
 * Decides **which client** an upload belongs to — from the authenticated
 * uploader's identity and nothing else.
 *
 * Document content never selects or changes the client. The previous design
 * moved unrouted uploads to whichever client's NIP appeared among the parties
 * Claude extracted; that filed one client's bank statement into a supplier's
 * Team, and a crafted or prompt-injected document could plant files in any
 * client's space. It is gone, and a source test keeps it gone.
 *
 * {@link resolve} runs before classification. A client is its
 * `{NIP}@bcr-group.pl` account, an Entra Member, and guests have no
 * capability, so the uploader's account is read first: a Guest, a non-Member,
 * a deleted user or an unreadable account is **refused** (nothing is stored
 * for it, not even in the quarantine), whatever the Directory says. A Member
 * is then mapped by object id to exactly one bound row, confirmed as that
 * row's client account (`clientAccountVerdict`: its UPN is
 * `{row NIP}@bcr-group.pl`; the NIP only confirms the row the id chose, it
 * never finds one), and routed only while their Teams, read from Entra at
 * upload time, are exactly their row's TeamId: a client account added to a
 * second client's Team after binding would otherwise file that client's
 * documents here. Every other Member goes to the quarantine with a reason.
 *
 * Nothing after classification comes back here: invoice direction (sales ⇄
 * purchase, from the bound client's own identity) is settled inside
 * classification (`invoiceDirection.ts`), and it only ever picks a folder of
 * the client resolved here.
 */
export class ClientResolver {
  private readonly log: Logger;
  private readonly domain: string;

  constructor(
    private readonly directory: ClientDirectoryReader,
    private readonly opts: ClientResolverOptions,
  ) {
    this.log = opts.log ?? createLogger('ingestion/clientResolver');
    this.domain = opts.clientAccountDomain ?? CLIENT_ACCOUNT_DOMAIN;
  }

  async resolve(source: ResolveRequest): Promise<ResolvedClient> {
    // `purpose` is in every identity line; the older lines keep it optional.
    const named = { purpose: source.purpose ?? 'upload' };
    const purpose = source.purpose ? { purpose: source.purpose } : {};

    // 1. The id. Validation already guarantees a GUID; defensive.
    const oid = source.userAadObjectId?.trim().toLowerCase() ?? '';
    if (!GUID.test(oid)) return this.refused('no_identity', named);

    // 2. The account, before the Directory: a guest is refused whatever the
    //    Directory says. A failure is never cached (the reader's rule).
    let account: UserAccount | null;
    try {
      account = await this.opts.accounts.accountOf(oid);
    } catch (err) {
      const status = err instanceof UserAccountReadError ? err.status : undefined;
      this.log.warn(
        { event: 'identity.unverified', ...named, ...(status !== undefined ? { status } : {}) },
        'identity.unverified',
      );
      return this.refused('identity_unverified', named, oid);
    }
    if (account === null) return this.refused('unknown_user', named, oid);
    const type = (account.userType ?? '').trim().toLowerCase();
    if (type === 'guest') return this.refused('guest', named, oid);
    if (type !== 'member') return this.refused('not_member', named, oid);

    // 3. Members only from here: the Directory, each miss to the quarantine.
    const snapshot = await this.directory.getSnapshot();
    if (snapshot.health === 'unavailable') {
      return this.quarantine('stale_directory');
    }

    if (snapshot.conflictedUserIds.has(oid)) return this.quarantine('conflict');
    if (snapshot.forbiddenUserIds.has(oid)) return this.quarantine('forbidden_target');
    if (snapshot.staffUserIds.has(oid)) return this.quarantine('staff');
    if (snapshot.unboundUserIds.has(oid)) return this.quarantine('unbound_target');

    const row = snapshot.byUserAadObjectId.get(oid);
    if (!row) return this.quarantine('unmapped');
    // The snapshot never routes a row the binding tool has not bound; checked
    // again where it is used. Such a row would file into the library root, and
    // nobody checked that its account is in this client's Team and no other.
    const teamId = row.teamId;
    if (!teamId || !isBoundRow(row)) return this.quarantine('unbound_target');

    const ids = { clientId: row.clientId, listItemId: row.listItemId, teamId };

    // 4. The row's client account: its UPN is `{row NIP}@domain`. Before the
    //    Teams read, so a staff id bound by mistake costs no memberOf read.
    //    The row was chosen by the id above; the NIP only confirms it.
    const accountCheck = clientAccountVerdict(account, row.nip, this.domain);
    if (accountCheck !== 'client') {
      this.log.warn(
        { event: 'client_account.mismatch', ...ids, ...named, accountCheck },
        'client_account.mismatch',
      );
      return this.quarantine('not_client_account');
    }

    // 5. The Teams: exactly the row's (the only check with a mode).
    const held = await this.checkMembership(oid, ids, purpose);
    if (held) return held;

    this.log.info(
      {
        ...ids,
        ...purpose,
        account: 'verified',
        membership: this.opts.membership.mode === 'off' ? 'unchecked' : 'verified',
      },
      'routed to client via userAadObjectId',
    );
    return {
      source: 'directory',
      clientId: row.clientId,
      listItemId: row.listItemId,
      title: row.title,
      matchedBy: 'userAadObjectId',
      target: row.target,
      teamId,
      nip: row.nip,
      companyName: row.companyNameAliases[0] ?? row.title,
    };
  }

  /**
   * The row's Team must be the uploader's only Team. `null` when it is (or
   * the check is off); otherwise the quarantine, with the reason logged by
   * ids and counts only — never another Team's id or name.
   */
  private async checkMembership(
    oid: string,
    ids: { readonly clientId: string; readonly listItemId: string; readonly teamId: string },
    purpose: { readonly purpose?: string },
  ): Promise<QuarantineResolution | null> {
    const check = this.opts.membership;
    if (check.mode === 'off') return null;

    let teams: ReadonlySet<string>;
    try {
      teams = new Set([...(await check.source.teamsOf(oid))].map((t) => t.trim().toLowerCase()));
    } catch (err) {
      const status = err instanceof TeamMembershipReadError ? err.status : undefined;
      this.log.warn(
        {
          event: 'membership.unverified',
          ...ids,
          ...purpose,
          ...(status !== undefined ? { status } : {}),
        },
        'membership.unverified',
      );
      return this.quarantine('membership_unverified');
    }

    const inRowTeam = teams.has(ids.teamId.trim().toLowerCase());
    const otherTeamCount = teams.size - (inRowTeam ? 1 : 0);
    if (inRowTeam && otherTeamCount === 0) return null;

    this.log.warn(
      {
        event: 'membership.mismatch',
        ...ids,
        ...purpose,
        teamCount: teams.size,
        inRowTeam,
        otherTeamCount,
      },
      'membership.mismatch',
    );
    return this.quarantine('membership_mismatch');
  }

  /** A refusal, logged by id and code only (never the UPN). */
  private refused(
    reason: RefusalReason,
    purpose: { readonly purpose: string },
    userAadObjectId?: string,
  ): RefusedResolution {
    this.log.info(
      {
        event: 'identity.refused',
        reason,
        ...purpose,
        ...(userAadObjectId ? { userAadObjectId } : {}),
      },
      'identity.refused',
    );
    return this.refuse(reason);
  }

  /**
   * The refusal for a reason: not a client account. Nothing is done for the
   * request, nothing is stored, and there is no target — not even the
   * quarantine.
   */
  refuse(reason: RefusalReason): RefusedResolution {
    return { source: 'refused', reason };
  }

  /** The quarantine resolution for a reason. Also used when a client target turns out unwritable. */
  quarantine(reason: QuarantineReason): QuarantineResolution {
    return { source: 'quarantine', reason, target: this.opts.quarantineTarget };
  }
}
