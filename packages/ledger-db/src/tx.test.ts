import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Logger } from '@bcr/shared';
import { sql } from './sql';
import { assertClientTx, LedgerDb, type ClientTx, type ConnectionLike } from './tx';

const A = '2ed6657d-e927-568b-95e1-2665a8aea6a2';

interface Call {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * A pool of one fake connection that records every statement. Like a
 * node-postgres client it is an EventEmitter: `emit('error')` with nobody
 * listening throws, as it ends the process in production.
 */
function fakePool(fail: (text: string) => Error | undefined = () => undefined) {
  const calls: Call[] = [];
  const released: unknown[] = [];
  const warnings: unknown[] = [];
  let connects = 0;
  const emitter = new EventEmitter();
  const conn: ConnectionLike & EventEmitter = Object.assign(emitter, {
    async query(a: string | { text: string; values: unknown[] }, b?: unknown[]) {
      const call = typeof a === 'string' ? { text: a, values: b ?? [] } : a;
      calls.push(call);
      const err = fail(call.text);
      if (err) throw err;
      return { rows: [{ ok: 1 }] };
    },
    release(destroy?: boolean | Error) {
      released.push(destroy);
    },
  });
  const pool = {
    connect: async () => {
      connects += 1;
      return conn;
    },
    end: jest.fn(async () => undefined),
  };
  const log = { warn: (o: unknown) => warnings.push(o) } as unknown as Logger;
  return {
    db: new LedgerDb(pool, { log }),
    pool,
    conn,
    calls,
    released,
    warnings,
    texts: () => calls.map((c) => c.text.replace(/\s+/g, ' ').trim()),
    connects: () => connects,
  };
}

/** What node-postgres emits when the server ends the session. */
const terminated = () =>
  Object.assign(new Error('terminating connection due to administrator command'), {
    code: '57P01',
  });

describe('LedgerDb.withClientTx', () => {
  it('scopes the transaction: BEGIN, the app role, app.client_id, fn, COMMIT', async () => {
    const f = fakePool();
    const rows = await f.db.withClientTx(A, (tx) => tx.query(sql`SELECT ${1}`));
    expect(rows).toEqual([{ ok: 1 }]);
    expect(f.calls).toEqual([
      { text: 'BEGIN', values: [] },
      { text: 'SET LOCAL ROLE ledger_app', values: [] },
      { text: "SELECT set_config('app.client_id', $1, true)", values: [A] },
      { text: 'SELECT $1', values: [1] },
      { text: 'COMMIT', values: [] },
    ]);
    expect(f.released).toEqual([undefined]);
  });

  it('rolls back and rethrows when fn throws, and returns the connection', async () => {
    const f = fakePool();
    await expect(
      f.db.withClientTx(A, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(f.texts().slice(-1)).toEqual(['ROLLBACK']);
    expect(f.texts()).not.toContain('COMMIT');
    expect(f.released).toEqual([undefined]);
  });

  it('rolls back when the scope cannot be set, and never runs fn', async () => {
    const f = fakePool((t) =>
      t.startsWith('SET LOCAL ROLE') ? new Error('permission denied') : undefined,
    );
    const fn = jest.fn();
    await expect(f.db.withClientTx(A, fn)).rejects.toThrow('permission denied');
    expect(fn).not.toHaveBeenCalled();
    expect(f.texts()).toEqual(['BEGIN', 'SET LOCAL ROLE ledger_app', 'ROLLBACK']);
  });

  it('destroys a connection whose ROLLBACK fails instead of pooling it', async () => {
    const f = fakePool((t) => (t === 'COMMIT' || t === 'ROLLBACK' ? new Error('gone') : undefined));
    await expect(f.db.withClientTx(A, async () => 1)).rejects.toThrow('gone');
    expect(f.released).toEqual([true]);
  });

  it.each(['', 'not-a-uuid', A.toUpperCase(), `${A} `, "x'); SET ROLE ledger_owner; --"])(
    'refuses the scope %j before taking a connection',
    async (clientId) => {
      const f = fakePool();
      await expect(f.db.withClientTx(clientId, async () => 1)).rejects.toMatchObject({
        reason: 'invalid_scope',
      });
      expect(f.connects()).toBe(0);
    },
  );

  it('hands fn a handle that stops working when the transaction ends', async () => {
    const f = fakePool();
    let kept: ClientTx | undefined;
    await f.db.withClientTx(A, async (tx) => {
      kept = tx;
      expect(tx.clientId).toBe(A);
      expect(() => assertClientTx(tx)).not.toThrow();
    });
    expect(() => assertClientTx(kept as ClientTx)).toThrow(/not an open client transaction/);
    await expect((kept as ClientTx).query(sql`SELECT 1`)).rejects.toMatchObject({
      reason: 'tx_closed',
    });
  });

  it('runs only sql`...` statements', async () => {
    const f = fakePool();
    await expect(
      f.db.withClientTx(A, (tx) => tx.query('DELETE FROM ledger.documents' as never)),
    ).rejects.toThrow(/sql`...` statement only/);
    expect(f.texts()).not.toContain('DELETE FROM ledger.documents');
  });

  it('refuses a forged transaction handle', () => {
    const forged: ClientTx = { clientId: A, query: async () => [] };
    expect(() => assertClientTx(forged)).toThrow(/not an open client transaction/);
  });

  it('listens for a dying connection while it holds it, and only then', async () => {
    const f = fakePool();
    let during = -1;
    await f.db.withClientTx(A, async () => {
      during = f.conn.listenerCount('error');
    });
    expect(during).toBe(1);
    expect(f.conn.listenerCount('error')).toBe(0);
    expect(f.warnings).toEqual([]);
    expect(f.released).toEqual([undefined]);
  });

  it('fails the transaction, not the process, when the connection dies in fn', async () => {
    let dead = false;
    const f = fakePool(() =>
      dead
        ? new Error('Client has encountered a connection error and is not queryable')
        : undefined,
    );
    const outcome = f.db.withClientTx(A, async (tx) => {
      await tx.query(sql`SELECT 1`);
      // The server's FATAL, then the socket's end: node-postgres emits both.
      dead = true;
      expect(() => f.conn.emit('error', terminated())).not.toThrow();
      expect(() =>
        f.conn.emit('error', new Error('Connection terminated unexpectedly')),
      ).not.toThrow();
      await tx.query(sql`SELECT 2`);
    });
    await expect(outcome).rejects.toThrow(/not queryable/);
    expect(f.texts().slice(-1)).toEqual(['ROLLBACK']);
    expect(f.released).toEqual([true]);
    expect(f.conn.listenerCount('error')).toBe(0);
    // Name and SQLSTATE of the first error only: never a message.
    expect(f.warnings).toEqual([
      { event: 'index.connection_error', err: { name: 'Error', code: '57P01' } },
    ]);
  });

  it('destroys a connection that reported an error even when its ROLLBACK answers', async () => {
    const f = fakePool();
    await expect(
      f.db.withClientTx(A, async () => {
        f.conn.emit('error', new Error('read ECONNRESET'));
        throw new Error('the statement failed');
      }),
    ).rejects.toThrow('the statement failed');
    expect(f.released).toEqual([true]);
    expect(f.warnings).toEqual([{ event: 'index.connection_error', err: { name: 'Error' } }]);
  });

  it('logs with its own logger when none is given', async () => {
    const f = fakePool();
    const db = new LedgerDb(f.pool);
    await expect(db.withClientTx(A, async () => 1)).resolves.toBe(1);
  });

  it('ends the pool', async () => {
    const f = fakePool();
    await f.db.end();
    expect(f.pool.end).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The invariant: app.client_id is set in ONE place, withClientTx.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..');

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const child = join(abs, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (keep(child)) out.push(relative(REPO, child));
    }
  };
  walk(dir);
  return out.sort();
}

describe('app.client_id is set only in withClientTx', () => {
  const sources = [
    ...filesUnder(
      join(REPO, 'packages'),
      (f) => /\/src\/.*\.ts$/.test(f) && !/\.test\.ts$/.test(f),
    ),
    ...filesUnder(join(REPO, 'tools'), (f) => /\.m?js$/.test(f)),
  ];

  it('scans the sources of every package and the operator tools', () => {
    expect(sources).toContain('packages/ledger-db/src/tx.ts');
    expect(sources).toContain('packages/document-ingestion/src/runtime.ts');
    expect(sources.some((f) => f.startsWith('tools/'))).toBe(true);
  });

  it('names app.client_id or calls set_config in tx.ts alone', () => {
    const offenders = sources.filter((f) => {
      if (f === 'packages/ledger-db/src/tx.ts') return false;
      const text = readFileSync(join(REPO, f), 'utf8');
      return /app\.client_id|set_config/i.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('is only ever read by the SQL: no migration sets it', () => {
    const offenders = filesUnder(join(REPO, 'packages', 'ledger-db'), (f) =>
      f.endsWith('.sql'),
    ).filter((f) =>
      /set_config|SET\s+(LOCAL\s+|SESSION\s+)?app\.client_id/i.test(
        readFileSync(join(REPO, f), 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('is set in tx.ts exactly once, transaction-local', () => {
    const code = readFileSync(join(__dirname, 'tx.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    expect(code).toContain("SELECT set_config('app.client_id', $1, true)");
  });
});
