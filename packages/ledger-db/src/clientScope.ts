import { createHash } from 'node:crypto';
import { LedgerDbError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_ITEM_ID = /^[1-9][0-9]*$/;

/**
 * The namespace of the client ids derived from Client Directory rows. Fixed
 * for ever: changing it gives every client a new id, and the index's rows
 * would belong to nobody the next transaction can open.
 */
export const DIRECTORY_CLIENT_NAMESPACE = '6ea8eafb-b4ec-4933-9941-b9b39803f213';

/** Whether `value` is a UUID in canonical (lower-case) form. */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** An RFC 9562 version-5 (SHA-1, name-based) UUID of `name` in `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  if (!GUID.test(namespace)) {
    throw new LedgerDbError('invalid_scope', 'uuidV5: the namespace is not a UUID');
  }
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The index's `client_id` for a bound Client Directory row: a UUIDv5 of the
 * Directory list's id and the row's list item id. Derived, not looked up, so
 * the client-scoped transaction can be opened before anything is read — the
 * scope is known from the authenticated routing alone, and no query ever runs
 * without one. The list id is part of the name: a recreated Directory list
 * restarts its item ids at 1, and item 1 of a new list must never open the
 * old item 1's documents (its insert then collides on
 * `directory_list_item_id` with a row outside its scope, and RLS refuses it).
 */
export function clientIdForDirectoryRow(directoryListId: string, listItemId: string): string {
  if (!GUID.test(directoryListId)) {
    throw new LedgerDbError('invalid_scope', 'the Client Directory list id is not a GUID');
  }
  if (!LIST_ITEM_ID.test(listItemId)) {
    throw new LedgerDbError('invalid_scope', 'the Client Directory list item id is not a number');
  }
  return uuidV5(
    `client-directory:${directoryListId.toLowerCase()}:${listItemId}`,
    DIRECTORY_CLIENT_NAMESPACE,
  );
}
