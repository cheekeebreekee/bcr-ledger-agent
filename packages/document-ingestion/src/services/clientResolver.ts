import {
  buildFolderPath,
  createLogger,
  getCategory,
  invoiceCategoryForDirection,
  isDocumentCategory,
  type Classification,
  type IngestionSource,
  type QuarantineReason,
  type ResolvedClient,
  type SharePointTarget,
} from '@bcr/shared';
import type { ClientDirectoryReader } from './clientDirectoryReader';

export interface ClientResolverOptions {
  /**
   * The staff-only quarantine site. Every upload that cannot be tied to
   * exactly one client goes here. It is never a client Team and never
   * BCR GROUP.
   */
  readonly quarantineTarget: SharePointTarget;
}

/**
 * Result of `resolvePostClassification`: the unchanged client plus a
 * possibly-corrected classification (invoice direction flipped after
 * matching the bound client's own NIP against the parties).
 */
export interface PostClassificationResolution {
  readonly client: ResolvedClient;
  readonly classification: Classification;
  /** Set when the invoice direction was corrected. Useful for tracing. */
  readonly directionCorrection?: 'sprzedaz' | 'zakup';
}

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
 *  - {@link resolve} runs before classification and returns either the one
 *    client the uploader is bound to, or the quarantine with a reason.
 *  - {@link resolvePostClassification} only corrects invoice direction inside
 *    the bound client (sales ⇄ purchase, from the client's own NIP).
 */
export class ClientResolver {
  private readonly log = createLogger('ingestion/clientResolver');

  constructor(
    private readonly directory: ClientDirectoryReader,
    private readonly opts: ClientResolverOptions,
  ) {}

  async resolve(source: IngestionSource): Promise<ResolvedClient> {
    const snapshot = await this.directory.getSnapshot();
    if (snapshot.health === 'unavailable') {
      return this.quarantine('stale_directory');
    }

    const oid = source.userAadObjectId?.trim().toLowerCase() ?? '';
    if (!oid) return this.quarantine('unmapped');

    if (snapshot.conflictedUserIds.has(oid)) return this.quarantine('conflict');
    if (snapshot.staffUserIds.has(oid)) return this.quarantine('staff');

    const row = snapshot.byUserAadObjectId.get(oid);
    if (!row) return this.quarantine('unmapped');

    this.log.info(
      { clientId: row.clientId, listItemId: row.listItemId },
      'routed to client via userAadObjectId',
    );
    return {
      source: 'directory',
      clientId: row.clientId,
      listItemId: row.listItemId,
      title: row.title,
      matchedBy: 'userAadObjectId',
      target: row.target,
      nip: row.nip,
      companyName: row.companyNameAliases[0] ?? row.title,
    };
  }

  /** The quarantine resolution for a reason. Also used when a client target turns out unwritable. */
  quarantine(reason: QuarantineReason): ResolvedClient {
    return { source: 'quarantine', reason, target: this.opts.quarantineTarget };
  }

  /**
   * Correct invoice direction inside the bound client. Never changes the
   * client: the returned `client` is always the one passed in.
   */
  resolvePostClassification(
    preResolved: ResolvedClient,
    classification: Classification,
  ): PostClassificationResolution {
    if (preResolved.source !== 'directory' || !preResolved.nip) {
      return { client: preResolved, classification };
    }
    const applied = applyInvoiceDirection(classification, preResolved.nip);
    if (!applied) {
      return { client: preResolved, classification };
    }
    this.log.info(
      { clientId: preResolved.clientId, direction: applied.direction },
      'invoice direction derived from the bound client NIP',
    );
    return {
      client: preResolved,
      classification: applied.classification,
      directionCorrection: applied.direction,
    };
  }
}

// ---------------------------------------------------------------------------
// Direction override (exported for unit tests).
// ---------------------------------------------------------------------------

/**
 * If the classification is an invoice and the bound client appears as a
 * seller or buyer in `parties`, ensure the category matches that direction.
 * Returns `null` when no correction is warranted (already correct, not an
 * invoice, no matching party, missing year/month for the rebuild, etc.).
 */
export function applyInvoiceDirection(
  classification: Classification,
  clientNip: string,
): { classification: Classification; direction: 'sprzedaz' | 'zakup' } | null {
  const parties = classification.parties;
  if (!parties || parties.length === 0) return null;

  const currentCategory = classification.fields.category;
  // Only touch invoice-ish categories and the manual-review bucket —
  // don't retro-flip contracts, statements, reports, etc.
  if (
    currentCategory !== 'faktury_sprzedazy' &&
    currentCategory !== 'faktury_zakupu' &&
    currentCategory !== 'nieposortowane'
  ) {
    return null;
  }

  const clientParty = parties.find(
    (p) => p.nip === clientNip && (p.role === 'seller' || p.role === 'buyer'),
  );
  if (!clientParty) return null;

  const direction: 'sprzedaz' | 'zakup' =
    clientParty.role === 'seller' ? 'sprzedaz' : 'zakup';
  const targetCategory = invoiceCategoryForDirection(direction);

  if (currentCategory === targetCategory) return null; // already correct

  const year = numOrUndef(classification.fields.year);
  const month = numOrUndef(classification.fields.month);
  if (year === undefined || month === undefined) return null;
  if (!isDocumentCategory(targetCategory)) return null;

  const def = getCategory(targetCategory);
  const newFolder = buildFolderPath(targetCategory, { year, month });

  return {
    direction,
    classification: {
      ...classification,
      documentType: def.polishLabel,
      folderPath: newFolder,
      fields: {
        ...classification.fields,
        category: targetCategory,
        directionCorrection: direction,
      },
    },
  };
}

function numOrUndef(v: string | number | undefined): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}
