import { normalizeNip } from '@bcr/shared';
import { clientIdForDirectoryRow } from '../clientScope';
import { LedgerDbError } from '../errors';
import { sql } from '../sql';
import { assertClientTx, type ClientTx } from '../tx';

/** A bound Client Directory row, as the index keeps it. */
export interface DirectoryClientRow {
  /** The Client Directory list's Graph id (`CLIENT_DIRECTORY_LIST_ID`). */
  readonly directoryListId: string;
  /** The row's list item id: the key the client row is upserted by. */
  readonly listItemId: string;
  /** The Directory's `ClientId` (business number, e.g. `0002`). May be empty. */
  readonly clientNo: string;
  /** The client's NIP as the Directory has it. Stored only if valid. */
  readonly nip: string;
  /** The client's name. May be empty. */
  readonly legalName: string;
  readonly active: boolean;
}

/**
 * Creates or refreshes the client row of a bound Directory row, keyed by its
 * list item id, inside that client's own transaction. The row's `client_id`
 * is the transaction's scope, which must be the id derived from this row
 * ({@link clientIdForDirectoryRow}): a row is never written into another
 * client's scope. An existing row with the same list item id but another
 * `client_id` (a recreated Directory list) is outside the scope, so RLS makes
 * the upsert fail rather than touch it.
 *
 * A NIP that fails the checksum is stored as NULL (the column's CHECK would
 * refuse it). A NIP another client row already holds fails the upsert
 * (unique violation, SQLSTATE 23505): two bound rows sharing a NIP is a
 * Directory conflict for a person to resolve, not something to paper over.
 */
export async function upsertFromDirectory(tx: ClientTx, row: DirectoryClientRow): Promise<void> {
  assertClientTx(tx);
  if (clientIdForDirectoryRow(row.directoryListId, row.listItemId) !== tx.clientId) {
    throw new LedgerDbError(
      'scope_mismatch',
      'the Directory row is not the scope of this transaction',
    );
  }
  const rows = await tx.query<{ client_id: string }>(sql`
    INSERT INTO ledger.clients
      (client_id, directory_list_item_id, client_no, nip, legal_name, status)
    VALUES (
      ${tx.clientId}, ${row.listItemId}, ${blankToNull(row.clientNo)}, ${normalizeNip(row.nip)},
      ${blankToNull(row.legalName)}, ${row.active ? 'active' : 'inactive'}
    )
    ON CONFLICT (directory_list_item_id) DO UPDATE SET
      client_no = EXCLUDED.client_no,
      nip = EXCLUDED.nip,
      legal_name = EXCLUDED.legal_name,
      status = EXCLUDED.status
    RETURNING client_id::text AS client_id`);
  if (rows[0]?.client_id !== tx.clientId) {
    throw new LedgerDbError(
      'scope_mismatch',
      'the client row is not the scope of this transaction',
    );
  }
}

function blankToNull(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}
