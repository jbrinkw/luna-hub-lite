-- pgTAP coverage for hub.profiles.chefbyte_classifier_fallback_enabled
--
-- Verifies:
--   1. Column exists with the correct type + default + NOT NULL.
--   2. Default value of FALSE on a freshly inserted row.
--   3. RLS still works — User A can read/update their own toggle, User
--      B cannot.
--
-- Mirror of agent_settings_rls.test.sql shape so the auth + RLS
-- coverage stays consistent across hub.profiles columns.

BEGIN;
SELECT plan(7);

-- ─── 1. Column shape ────────────────────────────────────────────────

SELECT has_column(
  'hub', 'profiles', 'chefbyte_classifier_fallback_enabled',
  'hub.profiles has chefbyte_classifier_fallback_enabled column'
);

SELECT col_type_is(
  'hub', 'profiles', 'chefbyte_classifier_fallback_enabled', 'boolean',
  'chefbyte_classifier_fallback_enabled is BOOLEAN'
);

SELECT col_not_null(
  'hub', 'profiles', 'chefbyte_classifier_fallback_enabled',
  'chefbyte_classifier_fallback_enabled is NOT NULL'
);

SELECT col_default_is(
  'hub', 'profiles', 'chefbyte_classifier_fallback_enabled', 'false',
  'chefbyte_classifier_fallback_enabled defaults to FALSE'
);

-- ─── 2. Default on fresh insert ─────────────────────────────────────
-- profiles auto-inserts a row on auth.users INSERT via the existing
-- handle_new_user trigger; tests.create_supabase_user fires that
-- chain. Verify the new column lands FALSE.

SELECT tests.create_supabase_user('cf_user_a');
SELECT tests.create_supabase_user('cf_user_b');

SELECT tests.get_supabase_uid('cf_user_a') AS _a_uid \gset
SELECT tests.get_supabase_uid('cf_user_b') AS _b_uid \gset

SELECT tests.authenticate_as('cf_user_a');

SELECT is(
  (SELECT chefbyte_classifier_fallback_enabled
     FROM hub.profiles
    WHERE user_id = :'_a_uid'::uuid),
  FALSE,
  'fresh profile defaults chefbyte_classifier_fallback_enabled to FALSE'
);

-- ─── 3. RLS: owner can flip their own toggle ───────────────────────

UPDATE hub.profiles
   SET chefbyte_classifier_fallback_enabled = TRUE
 WHERE user_id = :'_a_uid'::uuid;

SELECT is(
  (SELECT chefbyte_classifier_fallback_enabled
     FROM hub.profiles
    WHERE user_id = :'_a_uid'::uuid),
  TRUE,
  'owner can UPDATE their own chefbyte_classifier_fallback_enabled'
);

-- ─── 4. RLS: stranger cannot flip another user's toggle ────────────
-- User B authenticates and tries to flip User A's toggle. The UPDATE
-- silently affects 0 rows under RLS (USING clause filters on
-- auth.uid() = user_id). Verify A's value is unchanged.

SELECT tests.authenticate_as('cf_user_b');

UPDATE hub.profiles
   SET chefbyte_classifier_fallback_enabled = FALSE
 WHERE user_id = :'_a_uid'::uuid;

-- Switch back to A to read (B can't see A's row at all).
SELECT tests.authenticate_as('cf_user_a');

SELECT is(
  (SELECT chefbyte_classifier_fallback_enabled
     FROM hub.profiles
    WHERE user_id = :'_a_uid'::uuid),
  TRUE,
  'stranger cannot UPDATE another user''s chefbyte_classifier_fallback_enabled'
);

-- ─── Teardown ──────────────────────────────────────────────────────

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('cf_user_a');
SELECT tests.delete_supabase_user('cf_user_b');

SELECT * FROM finish();
ROLLBACK;
