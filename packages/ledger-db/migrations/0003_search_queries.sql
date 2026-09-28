-- =============================================================================
-- 0003 — client search: one row per search a client's guest ran, for the
-- durable rate limits (counted under an advisory lock, across every worker)
-- and for counting the model's tokens per client and month. Applied like
-- 0001, inside one transaction, as ledger_owner. Never edit it once applied.
--
-- Never the question and never a filter value: the row keeps what kind of
-- search it was, how it ended, the SHA-256 of the filter that ran and the
-- NAMES of the fields it set (a CHECK keeps them to the filter's field names),
-- the number of results, the model and its token counts, and the latency.
-- The asker is their Entra object id, the same id the bot's gate passed.
--
-- The app writes (INSERT, then one UPDATE when the search ends) and never
-- deletes: ledger_app has no DELETE. Retention (13 months) is the operator's,
-- per client scope as ledger_owner (docs/operations/human-steps.md, "Client
-- search release").
-- =============================================================================

SET LOCAL ROLE ledger_owner;

CREATE TABLE ledger.search_queries (
  query_id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES ledger.clients (client_id),
  user_oid uuid NOT NULL,
  -- question: the guest's words, read by the model; typed: the card's form;
  -- page: the next page of an earlier search.
  kind text NOT NULL CHECK (kind IN ('question', 'typed', 'page')),
  -- started: reserved, not finished (yet, or ever: finishing is best effort).
  outcome text NOT NULL DEFAULT 'started' CHECK (
    outcome IN ('started', 'ok', 'help', 'not_understood', 'unsupported', 'unavailable')
  ),
  filter_sha256 text CHECK (filter_sha256 ~ '^[0-9a-f]{64}$'),
  filter_fields text[] NOT NULL DEFAULT '{}' CHECK (
    filter_fields <@ ARRAY[
      'categories', 'category', 'counterpartyName', 'counterpartyNip', 'currency', 'grossMax',
      'grossMin', 'invoiceNumber', 'monthFrom', 'monthTo', 'status'
    ]::text[]
  ),
  result_count integer CHECK (result_count >= 0),
  model text CHECK (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cache_read_tokens integer CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer CHECK (cache_write_tokens >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The per-asker windows (5 minutes, 24 hours), and the per-client one and the
-- monthly token counts. Each leads with client_id, which every query compares.
CREATE INDEX search_queries_client_user_created_idx
  ON ledger.search_queries (client_id, user_oid, created_at DESC);
CREATE INDEX search_queries_client_created_idx
  ON ledger.search_queries (client_id, created_at DESC);

CREATE TRIGGER search_queries_guard_row_update BEFORE UPDATE ON ledger.search_queries
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_row_update();

-- ---- Row-level security: the isolation boundary -----------------------------

ALTER TABLE ledger.search_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.search_queries FORCE ROW LEVEL SECURITY;
CREATE POLICY search_queries_client_scope ON ledger.search_queries
  USING (client_id = ledger.current_client_id())
  WITH CHECK (client_id = ledger.current_client_id());

-- ---- Privileges: the least the app needs (no DELETE, no TRUNCATE) -----------

REVOKE ALL ON ledger.search_queries FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ledger.search_queries TO ledger_app;
