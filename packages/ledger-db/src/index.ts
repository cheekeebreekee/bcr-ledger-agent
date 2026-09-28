/**
 * Public surface of @bcr/ledger-db, the document index. Consumers import from
 * here only; sub-paths are private.
 *
 * Every statement the app runs goes through `LedgerDb.withClientTx(clientId,
 * fn)`, the one place the client scope is set (tx.ts), and row-level security
 * in the database keeps each transaction to its client.
 */
export { Sql, sql, joinSql } from './sql';
export { LedgerDbError, sqlStateOf, type LedgerDbErrorReason } from './errors';
export {
  DIRECTORY_CLIENT_NAMESPACE,
  clientIdForDirectoryRow,
  isCanonicalUuid,
  uuidV5,
} from './clientScope';
export {
  LEDGER_POOL_MAX,
  OSSRDBMS_SCOPE,
  createLedgerCredential,
  createLedgerPool,
  entraPassword,
  ledgerPoolConfig,
  type LedgerPoolConfig,
  type LedgerPoolOptions,
} from './pool';
export {
  LEDGER_APP_ROLE,
  LedgerDb,
  assertClientTx,
  type ClientTx,
  type ClientTxOptions,
  type ConnectionLike,
  type LedgerDbOptions,
  type PoolLike,
  type QueryResultLike,
} from './tx';
export * as clientsRepo from './repos/clientsRepo';
export * as documentsRepo from './repos/documentsRepo';
export * as searchQueriesRepo from './repos/searchQueriesRepo';
export type { DirectoryClientRow } from './repos/clientsRepo';
export type {
  ClientViewRow,
  DocumentInvoiceFields,
  DocumentRecord,
  DocumentRow,
  DocumentSearchFilter,
  DocumentSource,
  DocumentStatus,
  MatchCount,
  MonthlyCount,
  PendingReviewNotice,
  RecordOutcome,
  SearchPage,
  SearchResult,
} from './repos/documentsRepo';
export { SEARCH_FILTER_FIELDS, type SearchFilterField } from './repos/searchFilter';
export type {
  FilterDigest,
  ReserveResult,
  SearchQueryFinish,
  SearchQueryKind,
  SearchQueryOutcome,
  SearchQuota,
  SearchQuotaName,
  SearchReservation,
  SearchTokenUsage,
} from './repos/searchQueriesRepo';
export {
  MIGRATIONS_DIR,
  VERIFY_SQL_FILE,
  applyMigrations,
  grantAppLogin,
  loadMigrations,
  verifySchema,
  type AdminClient,
  type Migration,
  type MigrationRun,
  type VerifyProblem,
} from './migrate';
