import { isCanonicalUuid } from './clientScope';
import { LedgerDbError } from './errors';
import { Sql } from './sql';

/**
 * The group role every client transaction runs as. It owns nothing, has no
 * BYPASSRLS, and holds only SELECT/INSERT/UPDATE on the ledger tables; the
 * app's login is granted it WITH INHERIT FALSE, so outside a transaction the
 * login can read nothing at all.
 */
export const LEDGER_APP_ROLE = 'ledger_app';

/** A query result as far as this package reads it. */
export interface QueryResultLike {
  readonly rows: unknown[];
}

/** One pooled connection (node-postgres `PoolClient`), narrowed for tests. */
export interface ConnectionLike {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>;
  query(config: { text: string; values: unknown[] }): Promise<QueryResultLike>;
  /** `true` (or an error) destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean | Error): void;
}

/** A connection pool (node-postgres `Pool`), narrowed for tests. */
export interface PoolLike {
  connect(): Promise<ConnectionLike>;
  end(): Promise<void>;
}

/**
 * A transaction scoped to one client. Minted only by
 * {@link LedgerDb.withClientTx}: the repositories refuse any other object, and
 * a handle stops working when its transaction ends.
 */
export interface ClientTx {
  /** The client this transaction is scoped to (`ledger.clients.client_id`). */
  readonly clientId: string;
  /** Runs one `sql`...`` statement in the transaction; returns its rows. */
  query<R = Record<string, unknown>>(statement: Sql): Promise<R[]>;
}

/** The transactions that are open now. A forged or ended handle is not in it. */
const openTxs = new WeakSet<ClientTx>();

/**
 * Throws unless `tx` is a transaction {@link LedgerDb.withClientTx} opened and
 * has not ended. Every repository function calls it first.
 */
export function assertClientTx(tx: ClientTx): void {
  if (!openTxs.has(tx)) {
    throw new LedgerDbError('tx_closed', 'not an open client transaction of this package');
  }
}

class ScopedTx implements ClientTx {
  #conn: ConnectionLike | null;

  constructor(
    conn: ConnectionLike,
    readonly clientId: string,
  ) {
    this.#conn = conn;
  }

  async query<R = Record<string, unknown>>(statement: Sql): Promise<R[]> {
    if (!(statement instanceof Sql)) {
      throw new TypeError('ClientTx.query takes an sql`...` statement only');
    }
    const conn = this.#conn;
    if (!conn || !openTxs.has(this)) {
      throw new LedgerDbError('tx_closed', 'the client transaction has ended');
    }
    const result = await conn.query(statement.toQuery());
    return result.rows as R[];
  }

  close(): void {
    this.#conn = null;
    openTxs.delete(this);
  }
}

/**
 * The document index's database handle. Its one way in is
 * {@link withClientTx}: every statement the app runs is inside a transaction
 * scoped to exactly one client, and row-level security does the rest.
 */
export class LedgerDb {
  constructor(private readonly pool: PoolLike) {}

  /**
   * Runs `fn` in a transaction scoped to `clientId`:
   *
   *     BEGIN;
   *     SET LOCAL ROLE ledger_app;
   *     SELECT set_config('app.client_id', $1, true);
   *     … fn …
   *     COMMIT;          -- ROLLBACK if fn or anything above throws
   *
   * THE ONLY PLACE `app.client_id` IS SET (a source scan in `tx.test.ts`
   * fails otherwise). Both the role and the setting are transaction-local, so
   * the pooled connection goes back with neither: the next statement on it,
   * scoped or not, starts from the login, which holds no privilege of its own.
   * Row-level security on every ledger table compares `client_id` with
   * `ledger.current_client_id()`, which is NULL without the setting, so an
   * unscoped statement reads nothing and writes nothing.
   *
   * `clientId` must be a canonical UUID, checked before a connection is taken.
   * A connection whose ROLLBACK fails is destroyed, not returned to the pool.
   */
  async withClientTx<T>(clientId: string, fn: (tx: ClientTx) => Promise<T>): Promise<T> {
    if (!isCanonicalUuid(clientId)) {
      throw new LedgerDbError('invalid_scope', 'the client id is not a canonical UUID');
    }
    const conn = await this.pool.connect();
    const tx = new ScopedTx(conn, clientId);
    let destroy = false;
    try {
      await conn.query('BEGIN');
      await conn.query(`SET LOCAL ROLE ${LEDGER_APP_ROLE}`);
      await conn.query("SELECT set_config('app.client_id', $1, true)", [clientId]);
      openTxs.add(tx);
      const result = await fn(tx);
      tx.close();
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      tx.close();
      try {
        await conn.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      throw err;
    } finally {
      tx.close();
      conn.release(destroy ? true : undefined);
    }
  }

  /** Closes the pool (tests, the migrate CLI). */
  async end(): Promise<void> {
    await this.pool.end();
  }
}
