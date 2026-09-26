import { LedgerAgentError } from '@bcr/shared';
import { DatabaseError } from 'pg';

/**
 * Why the index refused something before (or instead of) asking the database:
 *
 *  - `invalid_scope`: a client id that is not a UUID, so no transaction opens;
 *  - `scope_mismatch`: a client row written in another client's transaction;
 *  - `tx_closed`: a transaction handle used after its transaction ended;
 *  - `invalid_record`, `invalid_filter`, `invalid_cursor`: input that does
 *    not fit the index (the message names the field, never its value);
 *  - `no_token`: no Entra token for the database;
 *  - `migration_changed`, `migration_invalid`: an applied migration was
 *    edited, or a migration file is misnamed or out of sequence.
 */
export type LedgerDbErrorReason =
  | 'invalid_scope'
  | 'scope_mismatch'
  | 'tx_closed'
  | 'invalid_record'
  | 'invalid_filter'
  | 'invalid_cursor'
  | 'no_token'
  | 'migration_changed'
  | 'migration_invalid';

/**
 * An error of the document index. Its message names fields and codes only:
 * never a value, since values are client data.
 */
export class LedgerDbError extends LedgerAgentError {
  constructor(
    public readonly reason: LedgerDbErrorReason,
    message: string,
    cause?: unknown,
  ) {
    super('LedgerDbError', message, 500, cause);
  }
}

/**
 * The SQLSTATE of an error the server returned (`23505`, `42501`, …), or
 * `undefined` for anything else — a refused or dropped connection, a
 * timeout, a TLS failure — whose Node `code` (`EPIPE`, …) is not one.
 */
export function sqlStateOf(err: unknown): string | undefined {
  return err instanceof DatabaseError && typeof err.code === 'string' ? err.code : undefined;
}
