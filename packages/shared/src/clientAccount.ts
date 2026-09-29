/**
 * The client account rule (owner's decision, 28 Sep 2026): a client's
 * identity is its `{NIP}@bcr-group.pl` account, an Entra Member created by
 * BCR at onboarding. Guests have no capability in the ledger.
 *
 * `tools/lib/bindings.mjs` holds a character-for-character equivalent (the
 * tools are `.mjs` and cannot import TypeScript). Both sides test one case
 * table, `tools/test/client-account-cases.json`: change both or neither.
 */

/** The client accounts' domain: `{NIP}@bcr-group.pl` (owner's decision, 28 Sep 2026). */
export const CLIENT_ACCOUNT_DOMAIN = 'bcr-group.pl';

export type ClientAccountVerdict =
  | 'client'
  | 'guest'
  | 'not_member'
  | 'row_nip_invalid'
  | 'upn_mismatch';

/**
 * Whether `account` is the client account of a Directory row whose NIP is `rowNip`
 * (digits only, as the Directory readers normalise it). Pure; no I/O. It confirms a row
 * already chosen by object id or by location — it must never be used to find one.
 * Order: the type (Guest, then anything but Member), then the row's NIP, then the UPN.
 */
export function clientAccountVerdict(
  account: { readonly userType?: string | null; readonly userPrincipalName?: string | null },
  rowNip: string,
  domain: string = CLIENT_ACCOUNT_DOMAIN,
): ClientAccountVerdict {
  const type = (account.userType ?? '').trim().toLowerCase();
  if (type === 'guest') return 'guest';
  if (type !== 'member') return 'not_member';
  if (!/^[0-9]{10}$/.test(rowNip)) return 'row_nip_invalid';
  const upn = (account.userPrincipalName ?? '').trim().toLowerCase();
  return upn === `${rowNip}@${domain.trim().toLowerCase()}` ? 'client' : 'upn_mismatch';
}
