import { DatabaseError } from 'pg';
import { sqlStateOf } from './errors';
import {
  clientIdForDirectoryRow,
  DIRECTORY_CLIENT_NAMESPACE,
  isCanonicalUuid,
  uuidV5,
} from './clientScope';

/** Synthetic, upper-cased as Graph may return it. */
const LIST = 'C0FFEE00-1234-4ABC-9DEF-00112233AABB';

describe('uuidV5', () => {
  it('matches the RFC 9562 test vector', () => {
    // www.example.com in the DNS namespace.
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('refuses a namespace that is not a UUID', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow(/namespace/);
  });
});

describe('clientIdForDirectoryRow', () => {
  it('is a stable canonical UUIDv5, whatever the case of the list id', () => {
    const id = clientIdForDirectoryRow(LIST, '2');
    expect(isCanonicalUuid(id)).toBe(true);
    expect(id[14]).toBe('5');
    expect(clientIdForDirectoryRow(LIST.toLowerCase(), '2')).toBe(id);
    expect(id).toBe(uuidV5(`client-directory:${LIST.toLowerCase()}:2`, DIRECTORY_CLIENT_NAMESPACE));
  });

  it('differs per row, and per list for the same item id', () => {
    const other = '11111111-2222-4333-8444-555555555555';
    expect(clientIdForDirectoryRow(LIST, '2')).not.toBe(clientIdForDirectoryRow(LIST, '3'));
    expect(clientIdForDirectoryRow(LIST, '2')).not.toBe(clientIdForDirectoryRow(other, '2'));
  });

  it.each([
    ['not-a-guid', '2', /list id/],
    [LIST, '0', /list item id/],
    [LIST, '02', /list item id/],
    [LIST, '2a', /list item id/],
    [LIST, '', /list item id/],
  ])('refuses list %j item %j', (list, item, message) => {
    expect(() => clientIdForDirectoryRow(list, item)).toThrow(message);
  });
});

describe('isCanonicalUuid', () => {
  it('accepts lower case only', () => {
    expect(isCanonicalUuid('2ed6657d-e927-568b-95e1-2665a8aea6a2')).toBe(true);
    expect(isCanonicalUuid('2ED6657D-E927-568B-95E1-2665A8AEA6A2')).toBe(false);
    expect(isCanonicalUuid('2ed6657d')).toBe(false);
    expect(isCanonicalUuid(42)).toBe(false);
  });
});

describe('sqlStateOf', () => {
  it("reads the server's SQLSTATE, and nothing from a connection error", () => {
    const refused = Object.assign(new DatabaseError('duplicate key', 0, 'error'), {
      code: '23505',
    });
    expect(sqlStateOf(refused)).toBe('23505');
    expect(sqlStateOf(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBeUndefined();
    expect(sqlStateOf(new DatabaseError('no code', 0, 'error'))).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
  });
});
