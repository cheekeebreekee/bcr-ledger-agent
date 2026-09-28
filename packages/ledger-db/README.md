# @bcr/ledger-db — the document index

PostgreSQL (Azure Database for PostgreSQL Flexible Server, `infrastructure/db.bicep`) holding one
row per filed document, for search and, later, billing. **The isolation boundary is the database's
row-level security**, not the application code:

- every table in schema `ledger` has `ENABLE` + `FORCE ROW LEVEL SECURITY` and one policy,
  `client_id = ledger.current_client_id()` (`USING` and `WITH CHECK`);
- `ledger.current_client_id()` reads the transaction-local setting the app sets in exactly one
  place, `LedgerDb.withClientTx` (`src/tx.ts`; a source scan in `tx.test.ts` fails anywhere else),
  and is `NULL` without it: no scope, no rows, no writes;
- the app's role `ledger_app` owns nothing and cannot bypass RLS; the app's login (the ingestion
  managed identity) is granted it `WITH INHERIT FALSE, SET TRUE`, so outside a client
  transaction it can read nothing at all; objects belong to `ledger_owner` (`NOLOGIN`);
- `client_id` is immutable (a trigger), and every statement is an `sql`-tagged template with
  bind parameters only.

## Commands

```bash
corepack yarn workspace @bcr/ledger-db test           # unit tests (fakes)
corepack yarn workspace @bcr/ledger-db test:coverage  # 90/90/85/85
corepack yarn test:db                                 # RLS matrix etc. on postgres:16 (Docker)
corepack yarn workspace @bcr/ledger-db migrate        # operator, as the Entra admin (see below)
```

`test:db` starts a throwaway `postgres:16` container with Docker (random loopback port, random
password) unless `LEDGER_TEST_DATABASE_URL` names a superuser URL (CI's service container).

`migrate` is run by the operator signed in with `az login` as the server's Entra administrator,
with `LEDGER_DB_HOST`, `LEDGER_DB_NAME` (default `ledger`) and `LEDGER_DB_ADMIN_USER` (the
administrator's UPN). Its sub-commands: `status`, `verify`, `grant-app <login>`,
`client-id <listItemId>` (`src/cli/migrate.ts`). The release runbook is
`docs/operations/human-steps.md` → *Document index release*.

## Adding a migration

- A new file `migrations/NNNN_name.sql`, numbered after the last. Never edit an applied one:
  the runner compares checksums and stops.
- Start it with `SET LOCAL ROLE ledger_owner;` so what it creates belongs to `ledger_owner`.
- A new table in schema `ledger` needs a `client_id uuid NOT NULL`, `ENABLE` + `FORCE ROW LEVEL
  SECURITY`, the one client policy, the `guard_row_update` trigger, and only the grants
  `ledger_app` needs. `sql/verify.sql` fails on anything less, and the RLS matrix in
  `itest/rls.itest.ts` fails until the table has its case there.
- A table that is not per client (reference data) goes in another schema, never in `ledger`.
- **Apply a migration before deploying the build that uses it**, and keep migrations additive
  (new nullable columns, new tables) so the running build keeps working in between. The other
  order fails every index write that names a missing column (`index.write_failed`, SQLSTATE
  `42703`), and nothing writes those rows again. 0002 (`web_url`, `review_notified_at`) was
  applied before the build that writes `web_url`.
