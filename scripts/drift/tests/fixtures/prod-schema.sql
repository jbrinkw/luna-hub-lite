-- scripts/drift/tests/fixtures/prod-schema.sql
--
-- Fixture representing a "prod" schema dump that DIVERGES from
-- local-schema.sql in a material way: hub.mcp_keys is missing the
-- `last_used_at` column. The meta-test asserts the normalizer
-- surfaces this divergence.
--
-- Also included: legitimate ignored-stanza differences (different
-- role, different SET search_path form) — these should NOT produce
-- diff noise.

SET statement_timeout = '5min';        -- different form from local
SET search_path = 'pg_catalog,public'; -- different dialect from local

CREATE SCHEMA hub;

-- Reordered vs. local: apps before profiles. Normalizer should sort them
-- back into a deterministic order so this doesn't diff.
CREATE TABLE hub.apps (
    user_id uuid NOT NULL,
    app_key text NOT NULL,
    activated_at timestamptz DEFAULT now()
);

CREATE TABLE hub.profiles (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    day_start_hour integer DEFAULT 4,
    timezone text DEFAULT 'UTC'
);

-- Missing `last_used_at` — this is the material divergence.
CREATE TABLE hub.mcp_keys (
    user_id uuid NOT NULL,
    key_hash text NOT NULL,
    created_at timestamptz DEFAULT now()
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

-- Different role than local — ignored.
GRANT ALL ON TABLE hub.profiles TO service_role;
ALTER TABLE hub.profiles OWNER TO service_role;
COMMENT ON COLUMN hub.profiles.user_id IS 'References auth.users (prod copy)';
