import {
  buildFolderPath,
  getCategory,
  invoiceCategoryForDirection,
  type Classification,
  type ClassifierContext,
  type DocumentCategory,
} from '@bcr/shared';

/** The review flag for an invoice whose direction could not be tied to the client. */
export const DIRECTION_UNRESOLVED = 'DIRECTION_UNRESOLVED';

/**
 * The most confidence an invoice keeps when its direction is unresolved:
 * below any threshold the configuration accepts, so it can never be filed as
 * a sales or a purchase invoice on a guess.
 */
export const DIRECTION_UNRESOLVED_MAX_CONFIDENCE = 0.5;

export type InvoiceDirection = 'sprzedaz' | 'zakup';

/** Which party the primed client is, as the model read it (`client_role`). */
export type ClientRole = 'seller' | 'buyer' | 'none' | 'unknown';

/** The two categories whose folder depends on the direction. */
export function isDirectedInvoice(
  category: unknown,
): category is 'faktury_sprzedazy' | 'faktury_zakupu' {
  return category === 'faktury_sprzedazy' || category === 'faktury_zakupu';
}

/**
 * Settles sales vs purchase for an invoice from the bound client's OWN
 * identity, and from nothing else:
 *
 *  1. the client's NIP on exactly one side (seller or buyer) of the parties
 *     the model extracted — deterministic, and it wins over the model;
 *  2. otherwise the model's `client_role`, which it could only answer by
 *     matching the client's NIP or name primed in the prompt.
 *
 * Without a client identity, when the client is neither party, or when its
 * NIP is on both sides, it does not guess: the invoice keeps the model's category as a suggestion,
 * its confidence is capped at {@link DIRECTION_UNRESOLVED_MAX_CONFIDENCE}, and
 * it carries {@link DIRECTION_UNRESOLVED}, so the acceptance policy sends it
 * to review. Anything that is not a sales or purchase invoice is returned as
 * it is. It never changes the client; it only picks between two folders of
 * the client it was given.
 */
export function settleInvoiceDirection(
  classification: Classification,
  client: ClassifierContext['client'],
): Classification {
  const category = classification.fields.category;
  if (!isDirectedInvoice(category)) return classification;

  const fromNip = directionFromNip(classification, client);
  const found =
    fromNip === 'both' ? undefined : (fromNip ?? directionFromRole(classification, client));
  if (!found) {
    return {
      ...classification,
      confidence: Math.min(classification.confidence, DIRECTION_UNRESOLVED_MAX_CONFIDENCE),
      reviewReasons: withReason(classification.reviewReasons, DIRECTION_UNRESOLVED),
    };
  }

  const target: DocumentCategory = invoiceCategoryForDirection(found.direction);
  return {
    ...classification,
    documentType: getCategory(target).polishLabel,
    folderPath: folderFor(target, classification),
    fields: {
      ...classification.fields,
      category: target,
      direction: found.direction,
      directionSource: found.source,
    },
  };
}

interface FoundDirection {
  readonly direction: InvoiceDirection;
  readonly source: 'nip' | 'model';
}

/** `both` when the client's NIP is on both sides: nothing can settle that. */
function directionFromNip(
  classification: Classification,
  client: ClassifierContext['client'],
): FoundDirection | 'both' | undefined {
  const nip = digits(client?.nip);
  if (!nip) return undefined;
  const roles = new Set(
    (classification.parties ?? [])
      .filter((p) => p.nip === nip && (p.role === 'seller' || p.role === 'buyer'))
      .map((p) => p.role),
  );
  if (roles.size === 2) return 'both';
  if (roles.size === 0) return undefined;
  return { direction: roles.has('seller') ? 'sprzedaz' : 'zakup', source: 'nip' };
}

function directionFromRole(
  classification: Classification,
  client: ClassifierContext['client'],
): FoundDirection | undefined {
  // The model can only have matched an identity it was given.
  if (!digits(client?.nip) && !client?.companyName.trim()) return undefined;
  const role = classification.fields.clientRole;
  if (role === 'seller') return { direction: 'sprzedaz', source: 'model' };
  if (role === 'buyer') return { direction: 'zakup', source: 'model' };
  return undefined;
}

function folderFor(category: DocumentCategory, classification: Classification): string {
  const { year, month } = classification.fields;
  if (typeof year !== 'number' || typeof month !== 'number') return '';
  try {
    return buildFolderPath(category, { year, month });
  } catch {
    return '';
  }
}

function withReason(reasons: readonly string[] | undefined, reason: string): readonly string[] {
  return reasons?.includes(reason) ? reasons : [...(reasons ?? []), reason];
}

function digits(value: string | undefined): string {
  return (value ?? '').replace(/\D+/g, '');
}
