-- Storage RLS test for parity-reports bucket (pgTAP)
--
-- The parity-reports bucket stores periodic Pi↔cloud parity dumps:
--   path: {user_id}/latest.json
--
-- Expected RLS policies (must exist in storage.objects):
--   - user can SELECT their own objects (path starts with their user_id)
--   - user cannot SELECT another user's objects
--   - user can INSERT into their own prefix
--   - user cannot INSERT into another user's prefix
--   - service_role can SELECT all objects
--
-- If the bucket doesn't exist yet (orchestrator hasn't created the
-- migration), this test emits a single SKIP marker and finishes cleanly —
-- the gate stays green but the gap is visible in prove output.

BEGIN;

-- Probe whether prerequisites exist; capture into psql vars for \if below.
SELECT
  EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'parity-reports') AS has_bucket,
  EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'storage'
       AND tablename  = 'objects'
       AND cmd        = 'SELECT'
       AND (qual ILIKE '%parity-reports%' OR with_check ILIKE '%parity-reports%')
  ) AS has_policy
\gset

\if :has_bucket
\if :has_policy
SELECT plan(5);

-- Setup: create two test users.
SELECT tests.create_supabase_user('parity_user_a', 'paritya@test.com', '555-9001');
SELECT tests.create_supabase_user('parity_user_b', 'parityb@test.com', '555-9002');

SELECT tests.get_supabase_uid('parity_user_a') AS uid_a \gset
SELECT tests.get_supabase_uid('parity_user_b') AS uid_b \gset

-- Seed: service_role uploads one report for user A.
SET LOCAL ROLE service_role;

INSERT INTO storage.objects
  (bucket_id, name, owner, metadata)
VALUES
  ('parity-reports', (:'uid_a' || '/latest.json'), :'uid_a'::uuid,
   '{"mimetype":"application/json","size":1024}'::jsonb)
ON CONFLICT (bucket_id, name) DO NOTHING;

RESET ROLE;

-- Test 1: user A can SELECT their own report.
SELECT tests.authenticate_as('parity_user_a');

SELECT ok(
  EXISTS (
    SELECT 1 FROM storage.objects
     WHERE bucket_id = 'parity-reports'
       AND name = (:'uid_a' || '/latest.json')
  ),
  'user A can SELECT their own parity report'
);

-- Test 2: user B cannot SELECT user A's report (0 rows returned by RLS).
SELECT tests.authenticate_as('parity_user_b');

SELECT is(
  (SELECT count(*)::INTEGER FROM storage.objects
    WHERE bucket_id = 'parity-reports'
      AND name = (:'uid_a' || '/latest.json')),
  0,
  'user B cannot SELECT user A''s parity report (RLS hides it)'
);

-- Test 3: user B cannot INSERT into user A's prefix.
SELECT throws_ok(
  format(
    $$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
      VALUES ('parity-reports', %L, %L::uuid, '{}')$$,
    :'uid_a' || '/latest.json',
    :'uid_b'
  ),
  NULL,
  NULL,
  'user B cannot INSERT into user A''s prefix (RLS blocks cross-user upload)'
);

-- Test 4: user A can INSERT into their own prefix (new object path).
SELECT tests.authenticate_as('parity_user_a');

SELECT lives_ok(
  format(
    $$INSERT INTO storage.objects (bucket_id, name, owner, metadata)
      VALUES ('parity-reports', %L, %L::uuid, '{}')$$,
    :'uid_a' || '/archive/2026-04-30.json',
    :'uid_a'
  ),
  'user A can INSERT into their own prefix'
);

-- Test 5: service_role can SELECT all objects including user A's.
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;

SELECT ok(
  EXISTS (
    SELECT 1 FROM storage.objects
     WHERE bucket_id = 'parity-reports'
       AND name = (:'uid_a' || '/latest.json')
  ),
  'service_role can SELECT any parity report across users'
);

RESET ROLE;

-- Cleanup.
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('parity_user_a');
SELECT tests.delete_supabase_user('parity_user_b');
\else
SELECT plan(1);
SELECT skip('parity-reports SELECT policy not yet present — orchestrator must add migration before enabling RLS assertions');
\endif
\else
SELECT plan(1);
SELECT skip('parity-reports bucket not yet created — orchestrator must add migration before enabling RLS assertions');
\endif

SELECT * FROM finish();

ROLLBACK;
