-- scripts/drift/tests/fixtures/local-schema.sql
--
-- Fixture representing a "local" schema dump. Used by
-- scripts/drift/tests/test_nightly_ast_meta.sh to exercise the
-- normalizer + diff pipeline.
--
-- This fixture DIFFERS from prod-schema.sql in a MATERIAL way — a
-- column is missing from the prod side. The meta-test asserts the
-- pipeline produces a non-empty diff, exit code 1, ok=false.

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET search_path = public, pg_catalog;

CREATE SCHEMA hub;

CREATE TABLE hub.profiles (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    day_start_hour integer DEFAULT 4,
    timezone text DEFAULT 'UTC'
);

CREATE TABLE hub.apps (
    user_id uuid NOT NULL,
    app_key text NOT NULL,
    activated_at timestamptz DEFAULT now()
);

-- "material" divergence: local has a column prod doesn't.
CREATE TABLE hub.mcp_keys (
    user_id uuid NOT NULL,
    key_hash text NOT NULL,
    created_at timestamptz DEFAULT now(),
    last_used_at timestamptz
);

CREATE OR REPLACE FUNCTION hub.get_logical_date(uid uuid)
    RETURNS date
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = ''
AS $$
BEGIN
  RETURN current_date;
END;
$$;

GRANT ALL ON TABLE hub.profiles TO postgres;
ALTER TABLE hub.profiles OWNER TO postgres;
COMMENT ON COLUMN hub.profiles.user_id IS 'References auth.users';
