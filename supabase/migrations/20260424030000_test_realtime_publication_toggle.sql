-- no-test: test-infrastructure helper RPC only — test_alter_publication is exercised by the E2E realtime-health.spec.ts suite, not by pgTAP
-- Test-only RPC for the `realtime-health.spec.ts` end-to-end test. The spec
-- needs to simulate a publication regression by DROPping a known table from
-- `supabase_realtime` mid-test, asserting the new silent-death banner appears
-- within 30s, then re-ADDing the table and asserting the banner clears.
--
-- A plain service-role `admin` client cannot run `ALTER PUBLICATION` because
-- publications are owned by the `supabase_admin` role. Wrapping the DDL in a
-- `SECURITY DEFINER` function owned by that role lets the test trigger the
-- regression through a stable, narrow surface. The function explicitly
-- rejects anything outside `{ ADD, DROP } x chefbyte.*` to keep the blast
-- radius limited — a compromised service-role key cannot use this to nuke
-- arbitrary publications.
--
-- NOTE: this function is deliberately permissive in production (anyone with
-- a service-role key can call it), which is acceptable because (a)
-- service-role keys are already root-equivalent and (b) its only power is
-- toggling tables in the chefbyte schema on/off the realtime publication,
-- which is already within the service-role's natural blast radius.
--
-- Idempotent: repeated ADDs and DROPs don't error.

CREATE OR REPLACE FUNCTION private.test_alter_publication(
  p_action text,
  p_table_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Input validation — reject anything but the narrow surface we support.
  IF p_action NOT IN ('ADD', 'DROP') THEN
    RAISE EXCEPTION 'test_alter_publication: unsupported action %', p_action;
  END IF;
  IF p_table_name !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'test_alter_publication: invalid table identifier %', p_table_name;
  END IF;

  IF p_action = 'ADD' THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'chefbyte'
         AND tablename = p_table_name
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.%I', p_table_name);
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'chefbyte'
         AND tablename = p_table_name
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE chefbyte.%I', p_table_name);
    END IF;
  END IF;
END;
$$;

-- The function needs to run as the publication's owner (supabase_admin in
-- managed Supabase, postgres in local). ALTER OWNER to the role that owns
-- `supabase_realtime` — resolved via pg_publication.
DO $$
DECLARE
  pub_owner_role text;
BEGIN
  SELECT pg_get_userbyid(pubowner)
    INTO pub_owner_role
    FROM pg_publication
   WHERE pubname = 'supabase_realtime';

  IF pub_owner_role IS NULL THEN
    RAISE EXCEPTION 'supabase_realtime publication not found — cannot scope test RPC';
  END IF;

  EXECUTE format('ALTER FUNCTION private.test_alter_publication(text, text) OWNER TO %I', pub_owner_role);
END $$;

-- Only service_role can invoke it.
REVOKE EXECUTE ON FUNCTION private.test_alter_publication(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.test_alter_publication(text, text) TO service_role;
