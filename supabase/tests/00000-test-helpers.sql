-- pgTAP Test Helpers
-- Runs first alphabetically. Creates the `tests` schema and helper functions
-- used by all subsequent test files. NOT wrapped in BEGIN/ROLLBACK so the
-- schema persists for the test run.

-- Install pgTAP (already available as extension in local Supabase)
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- Create tests schema
CREATE SCHEMA IF NOT EXISTS tests;

-- Grant usage so authenticated/anon roles can call helpers
GRANT usage ON SCHEMA tests TO anon, authenticated;

------------------------------------------------------------------------
-- tests.create_supabase_user(identifier, email, phone, metadata)
-- Creates a user in auth.users with a test_identifier in metadata.
-- The handle_new_user trigger will auto-create their hub.profiles row.
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tests.create_supabase_user(
  identifier text,
  email text DEFAULT NULL,
  phone text DEFAULT NULL,
  metadata jsonb DEFAULT NULL
)
RETURNS uuid
SECURITY DEFINER
SET search_path = auth, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
  user_id uuid;
BEGIN
  user_id := extensions.uuid_generate_v4();

  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, phone, encrypted_password,
    email_confirmed_at, phone_confirmed_at,
    raw_user_meta_data, raw_app_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new,
    email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    user_id, 'authenticated', 'authenticated',
    coalesce(email, concat(identifier, '@test.com')), phone, '',
    now(), now(),
    jsonb_build_object('test_identifier', identifier) || coalesce(metadata, '{}'::jsonb),
    '{}'::jsonb,
    now(), now(),
    '', '', '', ''
  )
  RETURNING id INTO user_id;

  RETURN user_id;
END;
$$;

------------------------------------------------------------------------
-- tests.get_supabase_uid(identifier) → uuid
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tests.get_supabase_uid(identifier text)
RETURNS uuid
SECURITY DEFINER
SET search_path = auth, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
  supabase_user uuid;
BEGIN
  SELECT id INTO supabase_user
    FROM auth.users
   WHERE raw_user_meta_data ->> 'test_identifier' = identifier
   LIMIT 1;

  IF supabase_user IS NULL THEN
    RAISE EXCEPTION 'User with identifier % not found', identifier;
  END IF;

  RETURN supabase_user;
END;
$$;

------------------------------------------------------------------------
-- tests.get_supabase_user(identifier) → json
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tests.get_supabase_user(identifier text)
RETURNS json
SECURITY DEFINER
SET search_path = auth, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
  supabase_user json;
BEGIN
  SELECT row_to_json(u) INTO supabase_user
    FROM (
      SELECT id, email, phone, raw_user_meta_data, raw_app_meta_data
        FROM auth.users
       WHERE raw_user_meta_data ->> 'test_identifier' = identifier
       LIMIT 1
    ) u;

  IF supabase_user IS NULL OR supabase_user ->> 'id' IS NULL THEN
    RAISE EXCEPTION 'User with identifier % not found', identifier;
  END IF;

  RETURN supabase_user;
END;
$$;

------------------------------------------------------------------------
-- tests.authenticate_as(identifier)
-- Sets role to 'authenticated' and populates request.jwt.claims
-- so RLS policies see the correct auth.uid().
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tests.authenticate_as(identifier text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  user_data json;
  original_auth_data text;
BEGIN
  original_auth_data := current_setting('request.jwt.claims', true);
  user_data := tests.get_supabase_user(identifier);

  IF user_data IS NULL OR user_data ->> 'id' IS NULL THEN
    RAISE EXCEPTION 'User with identifier % not found', identifier;
  END IF;

  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object(
    'sub', user_data ->> 'id',
    'email', user_data ->> 'email',
    'phone', user_data ->> 'phone',
    'user_metadata', user_data -> 'raw_user_meta_data',
    'app_metadata', user_data -> 'raw_app_meta_data'
  )::text, true);

EXCEPTION
  WHEN OTHERS THEN
    SET LOCAL role = authenticated;
    SET LOCAL "request.jwt.claims" TO '';
    RAISE;
END;
$$;

------------------------------------------------------------------------
-- tests.clear_authentication()
-- Resets role to anon and clears JWT claims.
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tests.clear_authentication()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('role', 'anon', true);
  PERFORM set_config('request.jwt.claims', null, true);
END;
$$;

------------------------------------------------------------------------
-- tests.delete_supabase_user(identifier)
-- Removes a test user from auth.users (FK cascade handles profiles).
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tests.delete_supabase_user(identifier text)
RETURNS void
SECURITY DEFINER
SET search_path = auth, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM auth.users
   WHERE raw_user_meta_data ->> 'test_identifier' = identifier;
END;
$$;

------------------------------------------------------------------------
-- Minimal TAP output to satisfy pg_prove
------------------------------------------------------------------------
SELECT plan(1);
SELECT pass('Test helpers installed');
SELECT * FROM finish();
