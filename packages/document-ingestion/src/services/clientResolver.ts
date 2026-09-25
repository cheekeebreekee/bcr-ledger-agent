import {
  buildFolderPath,
  createLogger,
  getCategory,
  invoiceCategoryForDirection,
  isDocumentCategory,
  type Classification,
  type DocumentParty,
  type IngestionSource,
  type ResolvedClient,
  type SharePointTarget,
} from '@bcr/shared';
import type { ClientDirectoryReader } from './clientDirectoryReader';

export interface ClientResolverOptions {
  /**
   * Configured fallback target used when no directory row matches.
   * This is the "BCR Group" bucket per ARCHITECTURE.md §4.2.
   */
  readonly fallbackTarget: SharePointTarget;
  /** Business key used in logs/results for fallback uploads. */
  readonly fallbackClientId: string;
  /** Human-readable label for the fallback bucket. */
  readonly fallbackTitle?: string;
}

/**
 * Result of `resolvePostClassification` — the client to file to plus a
 * possibly-corrected classification (e.g. invoice direction flipped after
 * matching parties against the resolved client's NIP).
 */
export interface PostClassificationResolution {
  readonly client: ResolvedClient;
  readonly classification: Classification;
  /** Set when the classification was refined post-hoc. Useful for tracing. */
  readonly directionCorrection?: 'sprzedaz' | 'zakup';
  /** Set when a content NIP promoted a fallback to a Directory client. */
  readonly promotedFromFallback?: boolean;
}

/**
 * Decides **which client** an incoming ingestion request belongs to and
 * refines the classification based on content-extracted parties.
 *
 * Two-phase resolution:
 *  - {@link resolve} runs BEFORE classification and uses only the request
 *    envelope (Teams channel id, later user id). It may return a real
 *    client or the fallback bucket.
 *  - {@link resolvePostClassification} runs AFTER Claude has extracted the
 *    document's parties. If the pre-resolution was `fallback` and a party
 *    NIP matches a Directory row, the request is promoted to that client.
 *    For invoice categories it also flips sales ⇄ purchase when the
 *    resolved client's NIP matches a specific party role.
 *
 * Admin routing and anti-fraud mismatch handling remain intentionally out
 * of scope — a non-admin's channel/user context is treated as authoritative.
 */
export class ClientResolver {
  private readonly log = createLogger('ingestion/clientResolver');
  private readonly fallback: ResolvedClient;

  constructor(
    private readonly directory: ClientDirectoryReader,
    opts: ClientResolverOptions,
  ) {
    this.fallback = {
      clientId: opts.fallbackClientId,
      title: opts.fallbackTitle ?? opts.fallbackClientId,
      source: 'fallback',
      target: opts.fallbackTarget,
      nip: '',
      companyName: '',
    };
  }

  async resolve(source: IngestionSource): Promise<ResolvedClient> {
    const snapshot = await this.directory.getSnapshot();

    // Signed-in user identity (works for 1:1 DMs — the only reliable path
    // for bot file uploads in Teams). Channel-based routing was removed
    // because Teams channel messages either (a) drop-attach files into
    // SharePoint without notifying the bot, or (b) @mention messages only
    // carry the mention HTML in `activity.attachments` — no file payload.
    const rawUserAadObjectId = source.userAadObjectId?.trim().toLowerCase();
    if (rawUserAadObjectId) {
      const match = snapshot.byUserAadObjectId.get(rawUserAadObjectId);
      if (match && !match.isAdmin) {
        this.log.info(
          {
            userAadObjectId: rawUserAadObjectId,
            clientId: match.clientId,
            title: match.title,
          },
          'routed to client via userAadObjectId',
        );
        return {
          clientId: match.clientId,
          title: match.title,
          source: 'directory',
          matchedBy: 'userAadObjectId',
          target: match.target,
          nip: match.nip,
          companyName: match.companyNameAliases[0] ?? match.title,
        };
      }
      if (match?.isAdmin) {
        this.log.info(
          { userAadObjectId: rawUserAadObjectId, clientId: match.clientId },
          'matched an admin user — deferring to content routing (falling back)',
        );
      }
    }

    // No match on user id — fall back. Content-based promotion may still
    // upgrade this to a Directory client in `resolvePostClassification`.
    this.log.info(
      {
        conversationId: source.conversationId,
        userAadObjectId: rawUserAadObjectId,
      },
      'no directory match on user id — routing to fallback',
    );
    return this.fallback;
  }

  /**
   * Cross-reference the extracted `parties` against the Directory:
   *  - If the pre-resolved client was `fallback` and exactly one party
   *    matches a Directory client's NIP, promote the routing to that client.
   *  - If the effective client's NIP appears in `parties` and the current
   *    invoice category disagrees with the party's role, flip direction and
   *    rebuild the folder path.
   *
   * Always returns a resolution. Any refinement failure degrades to the
   * pre-resolved routing so uploads never block on this step.
   */
  async resolvePostClassification(
    preResolved: ResolvedClient,
    classification: Classification,
  ): Promise<PostClassificationResolution> {
    const parties = classification.parties ?? [];

    let client = preResolved;
    let promotedFromFallback = false;

    if (client.source === 'fallback' && parties.length > 0) {
      const promoted = await this.promoteFromContent(parties);
      if (promoted) {
        this.log.info(
          { clientId: promoted.clientId, title: promoted.title },
          'promoted fallback → directory client via content NIP match',
        );
        client = promoted;
        promotedFromFallback = true;
      }
    }

    let refined = classification;
    let directionCorrection: 'sprzedaz' | 'zakup' | undefined;

    if (client.nip && parties.length > 0) {
      const applied = applyInvoiceDirection(classification, client.nip);
      if (applied) {
        refined = applied.classification;
        directionCorrection = applied.direction;
        this.log.info(
          {
            clientId: client.clientId,
            direction: applied.direction,
            oldFolder: classification.folderPath,
            newFolder: refined.folderPath,
          },
          'invoice direction derived from parties',
        );
      }
    }

    return {
      client,
      classification: refined,
      ...(directionCorrection ? { directionCorrection } : {}),
      ...(promotedFromFallback ? { promotedFromFallback } : {}),
    };
  }

  private async promoteFromContent(
    parties: readonly DocumentParty[],
  ): Promise<ResolvedClient | null> {
    const snapshot = await this.directory.getSnapshot();
    // clientId → the party that matched. Using a Map lets us detect the
    // "multiple Directory clients present in the same document" case cheaply.
    const matched = new Map<string, DocumentParty>();

    for (const p of parties) {
      if (!p.nip) continue;
      const entry = snapshot.byNip.get(p.nip);
      if (entry && !entry.isAdmin) {
        matched.set(entry.clientId, p);
      }
    }

    if (matched.size === 0) return null;
    if (matched.size > 1) {
      this.log.warn(
        { clientIds: [...matched.keys()] },
        'multiple Directory clients present in the document — keeping fallback',
      );
      return null;
    }

    const [onlyClientId] = matched.keys();
    const entry = snapshot.entries.find((e) => e.clientId === onlyClientId);
    if (!entry) return null; // Should never happen; belt-and-braces.

    return {
      clientId: entry.clientId,
      title: entry.title,
      source: 'directory',
      matchedBy: 'nip',
      target: entry.target,
      nip: entry.nip,
      companyName: entry.companyNameAliases[0] ?? entry.title,
    };
  }
}

// ---------------------------------------------------------------------------
// Direction override (exported for unit tests).
// ---------------------------------------------------------------------------

/**
 * If the classification is an invoice and the resolved client appears as a
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
