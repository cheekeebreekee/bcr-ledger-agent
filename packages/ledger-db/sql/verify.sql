-- =============================================================================
-- verify.sql — the document index's isolation invariants, as one read-only
-- query. Every row it returns is a broken invariant; NO ROWS IS A PASS.
--
-- Run by `corepack yarn workspace @bcr/ledger-db migrate` after every run
-- (and `… migrate verify` on its own), by the DB integration tests, and by
-- hand every day (docs/operations/human-steps.md, "Document index release"):
--
--   psql "host=$DB_HOST dbname=ledger user=$ADMIN_UPN sslmode=require" \
--     -f packages/ledger-db/sql/verify.sql
--
-- It reads the catalogs only: no client data, and no scope needed.
-- =============================================================================
WITH
ledger_tables AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner, c.relacl
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'ledger' AND c.relkind IN ('r', 'p')
),
policies AS (
  SELECT t.relname, p.polname, p.polcmd, p.polpermissive, p.polroles,
         pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expr,
         pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
  FROM ledger_tables t
  JOIN pg_catalog.pg_policy p ON p.polrelid = t.oid
),
-- A login that can actually use ledger_app (SET or INHERIT), not an
-- administrator that only holds ADMIN OPTION on it.
app_members AS (
  SELECT m.rolname, m.rolsuper, m.rolbypassrls, am.inherit_option
  FROM pg_catalog.pg_auth_members am
  JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
  JOIN pg_catalog.pg_roles m ON m.oid = am.member
  WHERE r.rolname = 'ledger_app' AND (am.set_option OR am.inherit_option)
),
problems AS (
  SELECT 'rls_not_enabled' AS check_name, relname::text AS object,
         'ROW LEVEL SECURITY is not enabled' AS detail
  FROM ledger_tables WHERE NOT relrowsecurity
  UNION ALL
  SELECT 'rls_not_forced', relname::text, 'ROW LEVEL SECURITY is not forced (the owner bypasses it)'
  FROM ledger_tables WHERE NOT relforcerowsecurity
  UNION ALL
  SELECT 'policy_missing', t.relname::text, 'no policy: every statement would fail or, if RLS is off, see everything'
  FROM ledger_tables t
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = t.oid)
  UNION ALL
  SELECT 'policy_not_client_scoped', relname || '.' || polname,
         'USING is not client_id = ledger.current_client_id()'
  FROM policies
  WHERE polcmd <> 'a'
    AND coalesce(using_expr, '') !~ '^\(client_id = (ledger\.)?current_client_id\(\)\)$'
  UNION ALL
  SELECT 'policy_check_not_client_scoped', relname || '.' || polname,
         'WITH CHECK is not client_id = ledger.current_client_id()'
  FROM policies
  WHERE polcmd IN ('*', 'a', 'w')
    AND coalesce(check_expr, '') !~ '^\(client_id = (ledger\.)?current_client_id\(\)\)$'
  UNION ALL
  SELECT 'policy_restrictive_or_role_bound', relname || '.' || polname,
         'expected one PERMISSIVE policy for PUBLIC'
  FROM policies
  WHERE NOT polpermissive OR polroles <> '{0}'::oid[]
  UNION ALL
  SELECT 'client_id_missing', t.relname::text, 'no NOT NULL uuid column client_id to scope by'
  FROM ledger_tables t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = t.oid AND a.attname = 'client_id' AND a.attnotnull
      AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped
  )
  UNION ALL
  SELECT 'guard_trigger_missing', t.relname::text,
         'no enabled BEFORE UPDATE row trigger running ledger.guard_row_update(): client_id could change'
  FROM ledger_tables t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE tg.tgrelid = t.oid AND NOT tg.tgisinternal AND tg.tgenabled IN ('O', 'A')
      AND n.nspname = 'ledger' AND p.proname = 'guard_row_update'
      -- tgtype bits: 1 FOR EACH ROW, 2 BEFORE, 16 UPDATE.
      AND (tg.tgtype & 19) = 19
  )
  UNION ALL
  SELECT 'app_role_can_delete', t.relname::text, 'ledger_app holds ' || acl.privilege_type
  FROM ledger_tables t,
       LATERAL pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) acl
  WHERE acl.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app')
    AND acl.privilege_type IN ('DELETE', 'TRUNCATE')
  UNION ALL
  SELECT 'owner_not_ledger_owner', relname::text,
         'owned by ' || pg_catalog.pg_get_userbyid(relowner)
  FROM ledger_tables
  WHERE pg_catalog.pg_get_userbyid(relowner) <> 'ledger_owner'
  UNION ALL
  SELECT 'public_privilege', t.relname::text, 'PUBLIC holds ' || acl.privilege_type
  FROM ledger_tables t,
       LATERAL pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) acl
  WHERE acl.grantee = 0
  UNION ALL
  SELECT 'role_missing', r.name, 'role does not exist'
  FROM (VALUES ('ledger_owner'), ('ledger_app')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name)
  UNION ALL
  SELECT 'role_privileged', rolname::text,
         concat_ws(', ',
           CASE WHEN rolsuper THEN 'SUPERUSER' END,
           CASE WHEN rolbypassrls THEN 'BYPASSRLS' END,
           CASE WHEN rolcanlogin THEN 'LOGIN' END)
  FROM pg_catalog.pg_roles
  WHERE rolname IN ('ledger_owner', 'ledger_app') AND (rolsuper OR rolbypassrls OR rolcanlogin)
  UNION ALL
  SELECT 'app_role_owns', 'ledger_app', 'owns ' || what
  FROM (
    SELECT 'relation ' || c.relname AS what FROM pg_catalog.pg_class c
    WHERE c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app')
    UNION ALL
    SELECT 'schema ' || n.nspname FROM pg_catalog.pg_namespace n
    WHERE n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app')
    UNION ALL
    SELECT 'function ' || p.proname FROM pg_catalog.pg_proc p
    WHERE p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app')
    UNION ALL
    SELECT 'type ' || ty.typname FROM pg_catalog.pg_type ty
    WHERE ty.typowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app')
  ) owned
  UNION ALL
  SELECT 'app_role_can_create', 'ledger_app', 'CREATE on schema ' || n.nspname
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname IN ('ledger', 'ledger_meta', 'public')
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ledger_app')
    AND pg_catalog.has_schema_privilege('ledger_app', n.oid, 'CREATE')
  UNION ALL
  SELECT 'app_member_privileged', rolname::text,
         'a login that can use ledger_app is SUPERUSER or BYPASSRLS'
  FROM app_members WHERE rolsuper OR rolbypassrls
  UNION ALL
  SELECT 'app_member_inherits', rolname::text,
         'granted ledger_app WITH INHERIT TRUE: it holds ledger privileges outside a transaction'
  FROM app_members WHERE inherit_option
  UNION ALL
  SELECT 'scope_function_changed', 'ledger.current_client_id()',
         'missing, SECURITY DEFINER, or no longer reads app.client_id'
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ledger' AND p.proname = 'current_client_id' AND NOT p.prosecdef
      AND p.prosrc LIKE '%current_setting(''app.client_id'', true)%'
  )
)
SELECT check_name, object, detail FROM problems ORDER BY check_name, object;
