-- pgTAP coverage for chefbyte.review_queue + upsert / resolve helpers
-- (sync-audit finding #5 cloud mirror of Pi review_queue).
--
-- Verifies:
--   1. service_role upserts a review for User A.
--   2. upsert_review_queue_from_pi is idempotent on (user_id, pi_review_id).
--   3. RLS isolation between users.
--   4. status / kind CHECK constraints.
--   5. resolve_review enforces caller scoping.

BEGIN;
SELECT plan(12);

SELECT tests.create_supabase_user('rqm_a');
SELECT tests.create_supabase_user('rqm_b');

SELECT tests.authenticate_as('rqm_a');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('rqm_b');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

-- Capture UIDs before switching to service_role (which lacks ``tests`` schema).
SELECT tests.get_supabase_uid('rqm_a') AS _a_uid \gset
SELECT tests.get_supabase_uid('rqm_b') AS _b_uid \gset

-- ─────────────────────────────────────────────────────────────────────
-- 1. service_role inserts a review for user A via the upsert helper
-- ─────────────────────────────────────────────────────────────────────
SET LOCAL ROLE service_role;

SELECT lives_ok(
  format($f$
    SELECT chefbyte.upsert_review_queue_from_pi_admin(
      %L::uuid,
      'a0000000-0000-0000-0000-000000000001'::uuid,
      'low_confidence',
      NULL, NULL,
      '{"item_id":"prod-x","confidence":0.42}'::jsonb,
      '["events/e1/before.jpg"]'::jsonb,
      now()
    )
  $f$, :'_a_uid'),
  'service_role can upsert a Pi-driven review row for user A'
);

-- Same (user_id, pi_review_id) → idempotent.
SELECT chefbyte.upsert_review_queue_from_pi_admin(
  :'_a_uid'::uuid,
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'low_confidence',
  NULL, NULL,
  '{"item_id":"prod-x","confidence":0.42}'::jsonb,
  '["events/e1/before.jpg"]'::jsonb,
  now()
);

SELECT is(
  (SELECT count(*)::int FROM chefbyte.review_queue
    WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
  1,
  'replay of upsert is idempotent on (user_id, pi_review_id)'
);

-- Replay refreshes pending metadata (proposed JSON updated).
SELECT chefbyte.upsert_review_queue_from_pi_admin(
  :'_a_uid'::uuid,
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'low_confidence',
  NULL, NULL,
  '{"item_id":"prod-y","confidence":0.55}'::jsonb,
  '["events/e1/before.jpg","events/e1/after.jpg"]'::jsonb,
  now()
);

SELECT is(
  (SELECT proposed->>'item_id' FROM chefbyte.review_queue
    WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
  'prod-y',
  'pending review proposed metadata refreshed on replay'
);

RESET ROLE;

-- ─────────────────────────────────────────────────────────────────────
-- 2. RLS isolation — User B cannot SELECT User A's row
-- ─────────────────────────────────────────────────────────────────────
SELECT tests.authenticate_as('rqm_b');

SELECT is(
  (SELECT count(*)::int FROM chefbyte.review_queue
    WHERE user_id = :'_a_uid'::uuid),
  0,
  'User B cannot SELECT User A review_queue rows (RLS)'
);

UPDATE chefbyte.review_queue
   SET status = 'dismissed'
 WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001';

SELECT tests.authenticate_as('rqm_a');
SELECT is(
  (SELECT status FROM chefbyte.review_queue
    WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
  'pending',
  'User B UPDATE was no-op (RLS) — User A row still pending'
);

-- ─────────────────────────────────────────────────────────────────────
-- 3. CHECK constraints
-- ─────────────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;

SELECT throws_ok(
  format($f$
    INSERT INTO chefbyte.review_queue (user_id, pi_review_id, kind, status)
    VALUES (%L::uuid, 'a0000000-0000-0000-0000-000000000099'::uuid, 'low_confidence', 'bogus')
  $f$, :'_a_uid'),
  '23514',
  NULL,
  'status CHECK rejects values outside (pending,resolved,dismissed)'
);

SELECT throws_ok(
  format($f$
    INSERT INTO chefbyte.review_queue (user_id, pi_review_id, kind)
    VALUES (%L::uuid, 'a0000000-0000-0000-0000-0000000000aa'::uuid, 'not_a_kind')
  $f$, :'_a_uid'),
  '23514',
  NULL,
  'kind CHECK rejects unknown enum values'
);

RESET ROLE;

-- ─────────────────────────────────────────────────────────────────────
-- 4. resolve_review (cloud UI path) — User A resolves their own row
-- ─────────────────────────────────────────────────────────────────────
SELECT tests.authenticate_as('rqm_a');

SELECT lives_ok(
  $$ SELECT chefbyte.resolve_review(
       (SELECT review_id FROM chefbyte.review_queue
         WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
       'resolved',
       '{"candidate_id":"prod-y","note":"correct"}'::jsonb
     ) $$,
  'User A can resolve their own review'
);

SELECT is(
  (SELECT status FROM chefbyte.review_queue
    WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
  'resolved',
  'review status flipped to resolved'
);

SELECT is(
  (SELECT user_response->>'candidate_id' FROM chefbyte.review_queue
    WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
  'prod-y',
  'user_response persisted'
);

-- Replay of upsert on a resolved row does NOT clobber user_response.
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
SELECT chefbyte.upsert_review_queue_from_pi_admin(
  :'_a_uid'::uuid,
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'low_confidence',
  NULL, NULL,
  '{"item_id":"REPLAY"}'::jsonb,
  NULL,
  now()
);
RESET ROLE;

SELECT tests.authenticate_as('rqm_a');
SELECT is(
  (SELECT user_response->>'candidate_id' FROM chefbyte.review_queue
    WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000001'),
  'prod-y',
  'upsert does not overwrite user_response on already-resolved row'
);

-- ─────────────────────────────────────────────────────────────────────
-- 5. resolve_review rejects User B trying to resolve User A's row
-- ─────────────────────────────────────────────────────────────────────
SELECT tests.clear_authentication();
SET LOCAL ROLE service_role;
SELECT chefbyte.upsert_review_queue_from_pi_admin(
  :'_a_uid'::uuid,
  'a0000000-0000-0000-0000-000000000002'::uuid,
  'weight_mismatch',
  NULL, NULL, NULL, NULL, now()
);
RESET ROLE;

SELECT tests.authenticate_as('rqm_b');
SELECT throws_ok(
  $$ SELECT chefbyte.resolve_review(
       (SELECT review_id FROM chefbyte.review_queue
         WHERE pi_review_id = 'a0000000-0000-0000-0000-000000000002'),
       'resolved',
       NULL
     ) $$,
  'P0002',
  NULL,
  'User B cannot resolve User A review (caller-scoping)'
);

-- Teardown
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('rqm_a');
SELECT tests.delete_supabase_user('rqm_b');

SELECT * FROM finish();
ROLLBACK;
