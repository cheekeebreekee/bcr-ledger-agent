-- =============================================================================
-- 0001 — the document index: roles, schema, clients, documents, row-level
-- security. Applied by `corepack yarn workspace @bcr/ledger-db migrate`, as
-- the server's Entra administrator (a superuser in the DB tests), inside one
-- transaction. Never edit it once applied: the runner compares checksums.
--
-- The isolation boundary is the database's own: FORCE ROW LEVEL SECURITY on
-- every table, one policy per table comparing client_id with
-- ledger.current_client_id(), which is NULL unless the transaction set
-- app.client_id. No scope, no rows; no scope, no writes. The app's role
-- (ledger_app) owns nothing and cannot bypass RLS; the objects belong to
-- ledger_owner, which nobody logs in as, and FORCE makes the owner subject to
-- the same policies.
-- =============================================================================

-- ---- Roles (cluster-wide: created once, then reused) -------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_owner') THEN
    CREATE ROLE ledger_owner NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    CREATE ROLE ledger_app NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- The migrating administrator creates the objects as ledger_owner: it must be
-- able to SET ROLE to it. Only SET: nothing of ledger_owner's is inherited.
GRANT ledger_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;

-- ---- Schema -----------------------------------------------------------------

CREATE SCHEMA ledger AUTHORIZATION ledger_owner;

SET LOCAL ROLE ledger_owner;
-- From here on every object is owned by ledger_owner.

REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA ledger TO ledger_app;

-- The scope of the current transaction, or NULL. The setting app.client_id is
-- set in one place only, @bcr/ledger-db's withClientTx, transaction-local and
-- after SET LOCAL ROLE ledger_app. An unset setting reads as '' once the
-- session has seen it, hence NULLIF; anything that is not a UUID fails the
-- cast, and the statement with it.
CREATE FUNCTION ledger.current_client_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.client_id', true), '')::uuid $$;

-- A Polish NIP: ten digits, weights 6 5 7 2 3 4 5 6 7, sum mod 11 equals the
-- tenth digit (10 never does), and not all zeros. The same rule as
-- isValidNip in @bcr/shared; the DB tests compare the two.
CREATE FUNCTION ledger.nip_is_valid(nip text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN nip !~ '^[0-9]{10}$' OR nip = '0000000000' THEN false
      ELSE (
        6 * substr(nip, 1, 1)::int + 5 * substr(nip, 2, 1)::int + 7 * substr(nip, 3, 1)::int +
        2 * substr(nip, 4, 1)::int + 3 * substr(nip, 5, 1)::int + 4 * substr(nip, 6, 1)::int +
        5 * substr(nip, 7, 1)::int + 6 * substr(nip, 8, 1)::int + 7 * substr(nip, 9, 1)::int
      ) % 11 = substr(nip, 10, 1)::int
    END
  $$;

-- client_id never changes, on any table: not by the app (RLS would refuse a
-- move to another scope anyway), not by an owner or an administrator by
-- mistake. Also stamps updated_at.
CREATE FUNCTION ledger.guard_row_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
      RAISE EXCEPTION 'ledger: client_id is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END
  $$;

-- ---- Tables -----------------------------------------------------------------

-- One row per client, keyed by the tenant key client_id. The ingestion derives
-- client_id from its Client Directory row (a UUIDv5 of the list id and the
-- item id) so that its transaction's scope is known before anything is read;
-- the default is for clients created by later sources.
CREATE TABLE ledger.clients (
  client_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  directory_list_item_id text NOT NULL UNIQUE
    CHECK (directory_list_item_id ~ '^[1-9][0-9]*$'),
  client_no text,
  nip text UNIQUE CHECK (ledger.nip_is_valid(nip)),
  legal_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per filed document (in its category, or in 98_ for review).
-- Quarantined documents have no client and are never here.
CREATE TABLE ledger.documents (
  document_id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES ledger.clients (client_id),
  source text NOT NULL CHECK (source IN ('bot', 'inbox', 'backfill')),
  drive_id text NOT NULL CHECK (drive_id <> ''),
  drive_item_id text NOT NULL CHECK (drive_item_id <> ''),
  status text NOT NULL CHECK (status IN ('FILED', 'NEEDS_REVIEW')),
  category text NOT NULL CHECK (category ~ '^[a-z_]+$'),
  suggested_category text CHECK (suggested_category ~ '^[a-z_]+$'),
  confidence numeric(3, 2) CHECK (confidence BETWEEN 0 AND 1),
  classifier text,
  model text,
  review_reasons text[] NOT NULL DEFAULT '{}',
  document_month date CHECK (extract(day FROM document_month) = 1),
  folder_path text,
  uploaded_by_oid uuid,
  content_sha256 text CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes >= 0),
  invoice_number text,
  issue_date date,
  sale_date date,
  currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  net_amount numeric(14, 2),
  vat_amount numeric(14, 2),
  gross_amount numeric(14, 2),
  seller_nip text CHECK (ledger.nip_is_valid(seller_nip)),
  seller_name text,
  buyer_nip text CHECK (ledger.nip_is_valid(buyer_nip)),
  buyer_name text,
  ksef_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, drive_item_id)
);

-- Search: newest first (keyset), by month and category, by counterparty NIP,
-- by gross amount. Each leads with client_id, which every query compares.
CREATE INDEX documents_client_created_idx
  ON ledger.documents (client_id, created_at DESC, document_id DESC);
CREATE INDEX documents_client_month_idx
  ON ledger.documents (client_id, document_month, category);
CREATE INDEX documents_client_seller_nip_idx
  ON ledger.documents (client_id, seller_nip) WHERE seller_nip IS NOT NULL;
CREATE INDEX documents_client_buyer_nip_idx
  ON ledger.documents (client_id, buyer_nip) WHERE buyer_nip IS NOT NULL;
CREATE INDEX documents_client_gross_idx
  ON ledger.documents (client_id, gross_amount) WHERE gross_amount IS NOT NULL;

CREATE TRIGGER clients_guard_row_update BEFORE UPDATE ON ledger.clients
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_row_update();
CREATE TRIGGER documents_guard_row_update BEFORE UPDATE ON ledger.documents
  FOR EACH ROW EXECUTE FUNCTION ledger.guard_row_update();

-- ---- Row-level security: the isolation boundary -----------------------------

ALTER TABLE ledger.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_client_scope ON ledger.clients
  USING (client_id = ledger.current_client_id())
  WITH CHECK (client_id = ledger.current_client_id());

ALTER TABLE ledger.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_client_scope ON ledger.documents
  USING (client_id = ledger.current_client_id())
  WITH CHECK (client_id = ledger.current_client_id());

-- ---- Privileges: the least the app needs ------------------------------------
-- No DELETE, no TRUNCATE, nothing on ledger_meta, CREATE on nothing.

REVOKE ALL ON ALL TABLES IN SCHEMA ledger FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ledger.clients, ledger.documents TO ledger_app;
GRANT EXECUTE ON FUNCTION ledger.current_client_id(), ledger.nip_is_valid(text) TO ledger_app;
