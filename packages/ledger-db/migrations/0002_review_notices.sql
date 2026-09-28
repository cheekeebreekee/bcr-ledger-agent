-- =============================================================================
-- 0002 — review notices: where a document is (its web link, for staff), and
-- whether staff were told it waits for review. Applied like 0001, inside one
-- transaction, as ledger_owner. Never edit it once applied.
--
-- The notifier reads, per client and in that client's scope, the documents
-- sorted to review that no notice has named yet, posts a card, and only after
-- the webhook accepted it sets review_notified_at on the rows that card named:
-- a refused post is retried by the next run. A new move into 98_ clears the
-- mark again. Both columns are the client's own row data under the same
-- policy as every other column; web_url contains the file's name.
-- =============================================================================

SET LOCAL ROLE ledger_owner;

ALTER TABLE ledger.documents
  ADD COLUMN web_url text CHECK (web_url IS NULL OR web_url ~ '^https://[^\s]+$'),
  ADD COLUMN review_notified_at timestamptz;

-- What the notifier reads: a client's documents in review not yet notified.
CREATE INDEX documents_client_review_pending_idx
  ON ledger.documents (client_id, created_at)
  WHERE status = 'NEEDS_REVIEW' AND review_notified_at IS NULL;
