import { createLogger, type Logger } from '@bcr/shared';
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
  /**
   * node-postgres emits `error` on a connection whose socket dies. While the
   * connection is checked out the pool no longer listens, so the holder must.
   */
  on(event: 'error', listener: (err: Error) => void): unknown;
  removeListener(event: 'error', listener: (err: Error) => void): unknown;
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

export interface LedgerDbOptions {
  /** Defaults to the `ledger-db/tx` logger. */
  readonly log?: Logger;
}

/** How a read-only client transaction opens: one snapshot, no writes. */
export const BEGIN_READ_ONLY = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

/** How {@link LedgerDb.withClientTx} opens its transaction. */
export interface ClientTxOptions {
  /**
   * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: any write in the
   * transaction fails (SQLSTATE 25006), whatever `fn` runs, and every
   * statement reads the one snapshot the first took, so a page and its count
   * agree even while a filing commits. A read-only transaction never fails
   * serialization (only writes do). For reads a client's request drives, such
   * as search. Writes keep READ COMMITTED: the quota reservation counts after
   * its lock with a fresh snapshot.
   */
  readonly readOnly?: boolean;
}

/**
 * The document index's database handle. Its one way in is
 * {@link withClientTx}: every statement the app runs is inside a transaction
 * scoped to exactly one client, and row-level security does the rest.
 */
export class LedgerDb {
  private readonly log: Logger;

  constructor(
    private readonly pool: PoolLike,
    opts: LedgerDbOptions = {},
  ) {
    this.log = opts.log ?? createLogger('ledger-db/tx');
  }

  /**
   * Runs `fn` in a transaction scoped to `clientId`:
   *
   *     BEGIN;           -- BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
   *                      --   with { readOnly: true }
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
   *
   * A connection that dies while it is held (a server restart or maintenance,
   * a network reset, `idle_in_transaction_session_timeout`, an operator's
   * `pg_terminate_backend`) fails this transaction and nothing else. The
   * pool listens for a connection's `error` only while it is idle; an `error`
   * event nobody hears ends the process, and with it every upload on the
   * worker, after the document is already filed. So the connection is
   * listened to for as long as it is checked out: the failure is logged by
   * name and SQLSTATE only, the pending statement rejects as usual, and the
   * connection is destroyed, never pooled.
   */
  async withClientTx<T>(
    clientId: string,
    fn: (tx: ClientTx) => Promise<T>,
    opts: ClientTxOptions = {},
  ): Promise<T> {
    if (!isCanonicalUuid(clientId)) {
      throw new LedgerDbError('invalid_scope', 'the client id is not a canonical UUID');
    }
    const conn = await this.pool.connect();
    const tx = new ScopedTx(conn, clientId);
    let destroy = false;
    let connectionLost = false;
    const onConnectionError = (err: Error & { code?: unknown }): void => {
      // node-postgres can emit twice for one death (the server's FATAL, then
      // the socket's end): the first carries the SQLSTATE.
      if (connectionLost) return;
      connectionLost = true;
      this.log.warn(
        {
          event: 'index.connection_error',
          err: { name: err.name, ...(typeof err.code === 'string' ? { code: err.code } : {}) },
        },
        'index.connection_error',
      );
    };
    conn.on('error', onConnectionError);
    try {
      await conn.query(opts.readOnly === true ? BEGIN_READ_ONLY : 'BEGIN');
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
      // Back in the pool, the pool's own listener takes over (pool.ts).
      conn.removeListener('error', onConnectionError);
      conn.release(destroy || connectionLost ? true : undefined);
    }
  }

  /** Closes the pool (tests, the migrate CLI). */
  async end(): Promise<void> {
    await this.pool.end();
  }
}
