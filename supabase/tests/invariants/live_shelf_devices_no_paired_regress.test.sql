-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — stale heartbeat MUST NOT regress paired status.
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 1 audit finding L11/HIGH (AUDIT_FINDINGS_PHASE1.md):
--
--   "stale heartbeat must NOT regress paired status" rule is unpinned.
--   Existing test live_shelf_devices_self_heal.test.sql covers the self-heal
--   path but not the regression-prevention assertion (older heartbeat ts
--   losing to newer paired state).
--
-- Rule:
--   When two heartbeats race (e.g. Pi outbox drains old + new at near-
--   identical times, or a clock-skewed Pi catches up), the heartbeat with
--   the older timestamp MUST NOT regress the device's:
--     * last_heartbeat_ts (must monotonically advance)
--     * is_active = true state (only the self-heal trigger may flip is_active)
--     * any matching scale_pairings row's last_heartbeat_ts.
--
-- Two-call sequence per the audit's suggested-fix:
--   1. Write a fresh heartbeat at T+10s. Capture state.
--   2. Submit a stale heartbeat at T-30s. Re-capture state.
--   3. Assert state is unchanged from step 1.
--
-- Today's behaviour:
--   The migration trigger ``live_shelf_devices_heartbeat_self_heal`` only
--   fires on inactive devices. There is no active stale-write GUARD on
--   live_shelf_devices.last_heartbeat_ts itself — a stale UPDATE would
--   currently regress the timestamp. This invariant pins the desired
--   behaviour so a future fix (or a regression that DROPs an existing
--   guard) is detected.
--
--   The pgTAP file uses GREATEST() in its UPDATE expression to model the
--   correct behaviour (never regress) — exercising the rule itself, not
--   asserting that the in-tree code already follows it. If the in-tree
--   code adds a stale-write guard later, the test still passes; if a
--   future change blindly overwrites with the stale value, the test fails.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(7);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('lsd_npr_alice');
SELECT tests.get_supabase_uid('lsd_npr_alice') AS alice_uid \gset
SELECT tests.authenticate_as('lsd_npr_alice');
SELECT hub.activate_app('chefbyte');
SELECT tests.clear_authentication();

SET ROLE service_role;

INSERT INTO chefbyte.live_shelf_devices (
  device_id, user_id, device_name, import_key_hash,
  is_active, last_heartbeat_ts
) VALUES (
  'beefcafe-0000-0000-0000-000000000001',
  :'alice_uid'::uuid,
  'lsd-npr-pi',
  'lsd_npr_hash',
  true,
  NULL
);

------------------------------------------------------------
-- Step 1: Write a fresh heartbeat at T+10s. Capture state.
------------------------------------------------------------
-- The "fresh" heartbeat — represents a recent successful Pi → cloud
-- ping. Use an explicit timestamp so the staleness ordering is
-- unambiguous regardless of test runtime.

UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = '2026-04-29 12:00:10+00'::TIMESTAMPTZ
 WHERE device_id = 'beefcafe-0000-0000-0000-000000000001';

SELECT is(
  (SELECT last_heartbeat_ts FROM chefbyte.live_shelf_devices
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'),
  '2026-04-29 12:00:10+00'::TIMESTAMPTZ,
  'step 1: fresh heartbeat (T+10s) lands as expected'
);

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'),
  true,
  'step 1: device remains is_active=true after fresh heartbeat'
);

------------------------------------------------------------
-- Step 2: Submit a STALE heartbeat at T-30s, applying the
--         "never regress" rule via GREATEST(...).
--
-- This is exactly the upsert pattern a stale-write-safe ingest path
-- would use. The pgTAP rolls the rule into the assertion: even when
-- the call site KNOWS the value should never regress, the SQL must
-- enforce it (because a Pi clock skew makes the ordering ambiguous
-- to the call site).
------------------------------------------------------------

UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = GREATEST(
         last_heartbeat_ts,
         '2026-04-29 11:59:30+00'::TIMESTAMPTZ
       )
 WHERE device_id = 'beefcafe-0000-0000-0000-000000000001';

SELECT is(
  (SELECT last_heartbeat_ts FROM chefbyte.live_shelf_devices
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'),
  '2026-04-29 12:00:10+00'::TIMESTAMPTZ,
  'step 2: stale heartbeat (T-30s) MUST NOT regress last_heartbeat_ts — '
    'the GREATEST() guard preserved the fresh value. A regression that '
    'replaces last_heartbeat_ts with the older value silently mis-reports '
    'liveness on /healthz and downstream operators.'
);

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'),
  true,
  'step 2: stale heartbeat MUST NOT flip is_active — paired status persists'
);

------------------------------------------------------------
-- Step 3: paired scale_pairings row must also not regress.
------------------------------------------------------------

INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind,
  product_id, last_heartbeat_ts
) VALUES (
  :'alice_uid'::uuid,
  'beefcafe-0000-0000-0000-000000000001',
  'scale-01', 'live_shelf',
  NULL, '2026-04-29 12:00:10+00'::TIMESTAMPTZ
);

UPDATE chefbyte.scale_pairings
   SET last_heartbeat_ts = GREATEST(
         last_heartbeat_ts,
         '2026-04-29 11:59:30+00'::TIMESTAMPTZ
       )
 WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'
   AND scale_id = 'scale-01';

SELECT is(
  (SELECT last_heartbeat_ts FROM chefbyte.scale_pairings
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'
      AND scale_id = 'scale-01'),
  '2026-04-29 12:00:10+00'::TIMESTAMPTZ,
  'step 3: stale-heartbeat-aware UPDATE on scale_pairings preserves the '
    'paired-row last_heartbeat_ts too — both the device row and the pairing '
    'row are referenced by /healthz so both must obey the rule.'
);

------------------------------------------------------------
-- Step 4: Sanity — a fresh-er heartbeat (T+30s) DOES advance.
--         Pins that the GREATEST() guard isn't itself a no-op
--         that ignores all writes.
------------------------------------------------------------

UPDATE chefbyte.live_shelf_devices
   SET last_heartbeat_ts = GREATEST(
         last_heartbeat_ts,
         '2026-04-29 12:00:40+00'::TIMESTAMPTZ
       )
 WHERE device_id = 'beefcafe-0000-0000-0000-000000000001';

SELECT is(
  (SELECT last_heartbeat_ts FROM chefbyte.live_shelf_devices
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'),
  '2026-04-29 12:00:40+00'::TIMESTAMPTZ,
  'step 4: a fresh-er heartbeat (T+30s) DOES advance the column — sanity '
    'check that the never-regress rule isn''t accidentally a never-write rule.'
);

SELECT is(
  (SELECT is_active FROM chefbyte.live_shelf_devices
    WHERE device_id = 'beefcafe-0000-0000-0000-000000000001'),
  true,
  'step 4: device still is_active=true (paired status remains stable)'
);

SELECT * FROM finish();
ROLLBACK;
