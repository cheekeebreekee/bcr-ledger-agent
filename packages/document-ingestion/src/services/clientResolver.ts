import {
  createLogger,
  type IngestionSource,
  type Logger,
  type QuarantineReason,
  type ResolvedClient,
  type SharePointTarget,
} from '@bcr/shared';
import { isBoundRow, type ClientDirectoryReader } from './clientDirectoryReader';
import { TeamMembershipReadError, type MembershipCheck } from './teamMembership';

export interface ClientResolverOptions {
  /**
   * The staff-only quarantine site. Every upload that cannot be tied to
   * exactly one client goes here. It is never a client Team and never
   * BCR GROUP.
   */
  readonly quarantineTarget: SharePointTarget;
  /**
   * Whether a bound uploader must be in their row's Team and no other, read
   * at upload time (`MEMBERSHIP_CHECK_MODE`). Required, so no resolver can be
   * built that silently skips it; build it with `membershipCheckFor`.
   */
  readonly membership: MembershipCheck;
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
 * {@link resolve} runs before classification and returns either the one
 * client the uploader is bound to, or the quarantine with a reason. A bound
 * uploader routes only while their Teams, read from Entra at upload time, are
 * exactly their row's TeamId: a guest added to a second client's Team after
 * binding would otherwise file that client's documents here.
 *
 * Nothing after classification comes back here: invoice direction (sales ⇄
 * purchase, from the bound client's own identity) is settled inside
 * classification (`invoiceDirection.ts`), and it only ever picks a folder of
 * the client resolved here.
 */
export class ClientResolver {
  private readonly log: Logger;

  constructor(
    private readonly directory: ClientDirectoryReader,
    private readonly opts: ClientResolverOptions,
  ) {
    this.log = opts.log ?? createLogger('ingestion/clientResolver');
  }

  async resolve(source: ResolveRequest): Promise<ResolvedClient> {
    const snapshot = await this.directory.getSnapshot();
    if (snapshot.health === 'unavailable') {
      return this.quarantine('stale_directory');
    }

    const oid = source.userAadObjectId?.trim().toLowerCase() ?? '';
    if (!oid) return this.quarantine('unmapped');

    if (snapshot.conflictedUserIds.has(oid)) return this.quarantine('conflict');
    if (snapshot.forbiddenUserIds.has(oid)) return this.quarantine('forbidden_target');
    if (snapshot.staffUserIds.has(oid)) return this.quarantine('staff');
    if (snapshot.unboundUserIds.has(oid)) return this.quarantine('unbound_target');

    const row = snapshot.byUserAadObjectId.get(oid);
    if (!row) return this.quarantine('unmapped');
    // The snapshot never routes a row the binding tool has not bound; checked
    // again where it is used. Such a row would file into the library root, and
    // nobody checked that its guests are in this client's Team and no other.
    const teamId = row.teamId;
    if (!teamId || !isBoundRow(row)) return this.quarantine('unbound_target');

    const ids = { clientId: row.clientId, listItemId: row.listItemId, teamId };
    const purpose = source.purpose ? { purpose: source.purpose } : {};
    const refused = await this.checkMembership(oid, ids, purpose);
    if (refused) return refused;

    this.log.info(
      {
        ...ids,
        ...purpose,
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
  ): Promise<ResolvedClient | null> {
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

  /** The quarantine resolution for a reason. Also used when a client target turns out unwritable. */
  quarantine(reason: QuarantineReason): ResolvedClient {
    return { source: 'quarantine', reason, target: this.opts.quarantineTarget };
  }
}
