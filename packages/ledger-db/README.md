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
  bind parameters only;
- `sql/verify.sql` checks all of it (and that the trigger is on every table and `ledger_app` holds
  no `DELETE` or `TRUNCATE`): no rows is a pass.

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

## Client search

A client's guest searches their own client's documents through the ingestion (`POST /api/search`);
this package holds its reads and its durable limits. The scope is the bound Directory row's
`clientIdForDirectoryRow`, as for filing: nothing in a filter, a cursor or the model's output can
name a client.

- **Reads** — `documentsRepo.searchClientView(tx, filter, { limit, after })` (10 a page by
  default, keyset cursor as `search`) and `documentsRepo.countMatching(tx, filter, cap)` (counts at
  most `cap` + 1 rows: `{ total, capped }`), in `withClientTx(scope, fn, { readOnly: true })`,
  which opens with `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` (any write fails, SQLSTATE
  `25006`; one snapshot, so the page and its count agree). They select only the
  client-view columns (`CLIENT_VIEW_FIELDS`: never who uploaded, the hash, drive ids, the model,
  its confidence or suggestion), and share `search`'s one condition builder
  (`src/repos/searchFilter.ts`), which always adds `client_id = <scope>` on top of RLS.
- **The filter** is `@bcr/shared`'s `ClientSearchFilter` (a `DocumentSearchFilter`), checked again
  here: an unknown key is refused, NIP, amounts and currency are normalised, `counterpartyName`
  matches either party's name with `strpos` (so `%` and `_` are characters, never wildcards) and
  `invoiceNumber` is a whole-number match on `lower(btrim(...))`.
- **Limits** — `searchQueriesRepo.reserve(tx, { queryId, userOid, kind })`, in the client's
  read-write transaction after `clientsRepo.upsertFromDirectory` and before anything paid. Under a
  transaction-scoped advisory lock per client it counts `ledger.search_queries` (0003) against
  `SEARCH_QUOTAS` — questions 10 per 5 minutes and 60 per 24 hours per asker, typed and page
  requests 30 per 5 minutes per asker, questions 300 per 24 hours per client — and records the
  search as `started`, or returns `rate_limited` with `retryAfterSeconds` and records nothing.
- **Records** — `searchQueriesRepo.finish(tx, …)` sets the outcome once (best effort), with
  `filterDigest(filter)`: the filter's SHA-256 and field names, never a value (a CHECK allows only
  field names in `filter_fields`), plus result count, model, token counts and latency. The
  question is never stored.
- **Retention** is the operator's (13 months): `ledger_app` has no `DELETE`, so it runs as the
  Entra administrator with `SET LOCAL ROLE ledger_owner` in each client's scope (FORCE ROW LEVEL
  SECURITY holds the owner too): `DELETE FROM ledger.search_queries WHERE created_at < now() -
  interval '13 months'`. Runbook: `docs/operations/human-steps.md` → *Client search release*.
- Apply 0003 before deploying the ingestion build that reserves searches: without the table,
  `reserve` fails (`42P01`).

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
