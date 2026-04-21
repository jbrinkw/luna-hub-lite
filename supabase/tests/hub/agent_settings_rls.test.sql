-- RLS isolation tests for hub.agent_settings
-- Policies (all auth.uid() = user_id):
--   SELECT: "Users can read own agent settings"
--   INSERT: "Users can insert own agent settings" (WITH CHECK)
--   UPDATE: "Users can update own agent settings" (USING)
-- Note: no DELETE policy for authenticated — deletes are silent no-op under RLS.
-- PK: user_id (one agent_settings row per user).
BEGIN;
SELECT plan(6);

-- Setup: two users
SELECT tests.create_supabase_user('ag_rls_a');
SELECT tests.create_supabase_user('ag_rls_b');

-- Capture UIDs now so later branches that run under service_role
-- (which lacks usage on the `tests` schema) can still reference them.
SELECT tests.get_supabase_uid('ag_rls_a') AS _a_uid \gset
SELECT tests.get_supabase_uid('ag_rls_b') AS _b_uid \gset

-- ═══════════════════════════════════════════════════════════════
-- User A inserts their own agent_settings row.
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('ag_rls_a');

INSERT INTO hub.agent_settings
  (user_id, anthropic_key_encrypted, system_prompt)
VALUES (
  tests.get_supabase_uid('ag_rls_a'),
  'sk-ant-fake-encrypted-owner',
  'Owner prompt: be concise'
);

-- Regression guard: User A can see their own row
SELECT ok(
  EXISTS (SELECT 1 FROM hub.agent_settings
    WHERE user_id = tests.get_supabase_uid('ag_rls_a')),
  'User A can SELECT own agent_settings'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot SELECT / UPDATE / DELETE User A's row
-- ═══════════════════════════════════════════════════════════════

SELECT tests.authenticate_as('ag_rls_b');

SELECT is(
  (SELECT count(*)::integer FROM hub.agent_settings
    WHERE user_id = tests.get_supabase_uid('ag_rls_a')),
  0,
  'User B cannot SELECT User A agent_settings'
);

UPDATE hub.agent_settings
  SET system_prompt = 'Hacked prompt',
      anthropic_key_encrypted = 'sk-ant-attacker-overwrite'
  WHERE user_id = tests.get_supabase_uid('ag_rls_a');
SELECT tests.authenticate_as('ag_rls_a');
SELECT is(
  (SELECT system_prompt FROM hub.agent_settings
    WHERE user_id = tests.get_supabase_uid('ag_rls_a')),
  'Owner prompt: be concise',
  'User B cannot UPDATE User A agent_settings'
);

-- DELETE via RLS silently affects 0 rows (no DELETE policy exists for
-- authenticated; USING defaults to no rows visible for deletion).
SELECT tests.authenticate_as('ag_rls_b');
DELETE FROM hub.agent_settings
  WHERE user_id = tests.get_supabase_uid('ag_rls_a');
SELECT tests.authenticate_as('ag_rls_a');
SELECT ok(
  EXISTS (SELECT 1 FROM hub.agent_settings
    WHERE user_id = tests.get_supabase_uid('ag_rls_a')),
  'User B cannot DELETE User A agent_settings'
);

-- ═══════════════════════════════════════════════════════════════
-- User B cannot INSERT a row spoofing User A's user_id
-- WITH CHECK ((SELECT auth.uid()) = user_id) → throws RLS violation.
-- Since user_id is the PK, we can't test duplicate-insert collision here;
-- but the WITH CHECK violation fires before the uniqueness check anyway.
-- To get a clean RLS violation (not PK collision), we first DELETE User A's
-- row via service_role so a spoofed insert would otherwise be a valid row.
-- ═══════════════════════════════════════════════════════════════

-- Clear User A's row via service_role so the intrusion attempt
-- isn't masked by PK collision (user_id is PK).
SET ROLE service_role;
DELETE FROM hub.agent_settings
  WHERE user_id = :'_a_uid'::uuid;
SET ROLE postgres;

SELECT tests.authenticate_as('ag_rls_b');

SELECT throws_ok(
  $$ INSERT INTO hub.agent_settings
       (user_id, anthropic_key_encrypted, system_prompt)
     VALUES (
       (SELECT id FROM auth.users
         WHERE raw_user_meta_data->>'test_identifier' = 'ag_rls_a'),
       'sk-ant-attacker-spoofed',
       'Spoofed prompt'
     ) $$,
  '42501',
  NULL,
  'User B cannot INSERT agent_settings owned by User A (RLS WITH CHECK)'
);

-- ═══════════════════════════════════════════════════════════════
-- User B can still INSERT their own row (regression guard: policy
-- isn't WITH CHECK (false))
-- ═══════════════════════════════════════════════════════════════

INSERT INTO hub.agent_settings
  (user_id, system_prompt)
VALUES (
  tests.get_supabase_uid('ag_rls_b'),
  'B''s own prompt'
);

SELECT is(
  (SELECT system_prompt FROM hub.agent_settings
    WHERE user_id = tests.get_supabase_uid('ag_rls_b')),
  'B''s own prompt',
  'User B can INSERT their own agent_settings (policy not WITH CHECK false)'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('ag_rls_a');
SELECT tests.delete_supabase_user('ag_rls_b');

SELECT * FROM finish();
ROLLBACK;
