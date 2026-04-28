-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — every emit kind has a handle branch
-- ════════════════════════════════════════════════════════════════════════════
-- Pins decisions.md #44 + #56 + the 2026-04-22 EMIT→HANDLE matrix audit
-- (commit da1315d). Catches: a new event_kind added to the edge function's
-- VALID_EVENT_KINDS without a corresponding branch in
-- private.apply_shelf_event will brick every event of that kind in
-- production (the function returns success but no handler matches → no
-- state mutation, ever).
--
-- Companion test on the Pi side (test_integration_hooks.py) proves the
-- emit-side coverage. THIS test proves the handle-side coverage from
-- the cloud's perspective by submitting one event of every valid kind
-- and asserting the apply path observed it (set last_update_ts or
-- inserted shelf_event_log).
--
-- Mechanism: enumerate the canonical VALID_EVENT_KINDS (mirrored from
-- the edge function — Deno source isn't queryable from pgTAP so we
-- mirror), call apply_shelf_event for each, assert the call doesn't
-- raise AND the shelf_event_log row exists.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(3);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('matrix_alice');
SELECT tests.authenticate_as('matrix_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('matrix_alice'),
  'Matrix Product',
  500.000, 5,
  100, 12, 4, 2
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('matrix_alice')
   AND name = 'Matrix Product' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('matrix_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('matrix_alice'),
  'matrix-pi',
  'matrix_hash_alice',
  true
);

SELECT device_id AS d_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('matrix_alice')
   AND device_name = 'matrix-pi' \gset

------------------------------------------------------------
-- The canonical event-kind catalog. Mirrored from
-- supabase/functions/shelf-ingest/index.ts::VALID_EVENT_KINDS.
-- The Pi-side test_integration_hooks.py drift-checks this list
-- against the edge function source. THIS test asserts every kind
-- has a handler in apply_shelf_event.
------------------------------------------------------------

CREATE TEMP TABLE _expected_kinds (kind TEXT PRIMARY KEY);
INSERT INTO _expected_kinds VALUES
  ('consumed'),
  ('added'),
  ('refilled'),
  ('depleted'),
  ('in_flight_pickup'),
  ('in_flight_return'),
  ('discarded'),
  ('catch_all_first_measurement'),
  ('catch_all_second_measurement');

------------------------------------------------------------
-- Assertion 1 — every expected kind, when fired, produces a
-- shelf_event_log row (the apply path's audit-trail INSERT happens
-- BEFORE any branch returns, so this is a strong check that
-- apply_shelf_event accepted the kind).
------------------------------------------------------------

SET LOCAL role postgres;

-- Probe each event_kind. apply_shelf_event INSERTs the shelf_event_log
-- audit row UP FRONT before any branch runs (see migration
-- 20260427130000_catch_all_delta_apply.sql lines 109-125 — the row
-- is written with applied=false / reason='pending' before any
-- IF p_event_kind branch is reached). Even if the post-validation
-- branch raises (e.g. unique-key conflicts on lot mints because
-- our test lot already exists), the audit row is written and
-- visible after the savepoint rollback.
--
-- This means the audit-row presence test works as a "did the kind
-- pass apply_shelf_event's validation?" probe without us having to
-- engineer pristine pre-state for every branch.

DO $$
DECLARE
  k TEXT;
  i INTEGER := 0;
  v_p_id UUID;
  v_d_id UUID := (SELECT device_id FROM chefbyte.live_shelf_devices
                  WHERE user_id = tests.get_supabase_uid('matrix_alice')
                  LIMIT 1);
  v_loc_id UUID := (SELECT location_id FROM chefbyte.locations
                    WHERE user_id = tests.get_supabase_uid('matrix_alice')
                      AND name = 'Fridge');
  v_pickup_uuid UUID;
BEGIN
  -- Fresh product per kind so each apply_shelf_event call exercises
  -- its happy path. Without per-product isolation, a unique-conflict
  -- 23505 inside a branch (catch_all_first_measurement minting a
  -- new lot) rolls back the iteration's plpgsql savepoint AND the
  -- up-front shelf_event_log audit-row INSERT — making the bag_eq
  -- falsely accuse the kind of being rejected at validation.
  FOR k IN SELECT kind FROM _expected_kinds ORDER BY kind LOOP
    i := i + 1;

    INSERT INTO chefbyte.products (
      user_id, name, net_weight_g, servings_per_container,
      calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
    ) VALUES (
      tests.get_supabase_uid('matrix_alice'),
      format('Matrix Product %s', k),
      500.000, 5, 100, 12, 4, 2
    ) RETURNING product_id INTO v_p_id;

    v_pickup_uuid := (
      lpad(i::text, 8, '0') || '-1111-1111-1111-111111111111'
    )::UUID;

    -- Seed a stock_lot for kinds that operate on existing inventory.
    -- New-lot kinds (added, catch_all_first_measurement) skip
    -- seeding so the apply path's mint branch runs cleanly.
    IF k NOT IN ('added', 'catch_all_first_measurement') THEN
      INSERT INTO chefbyte.stock_lots (
        user_id, product_id, location_id, qty_containers,
        last_update_source, last_update_ts,
        in_flight_since, in_flight_kind,
        pickup_event_id, pickup_weight_g
      ) VALUES (
        tests.get_supabase_uid('matrix_alice'),
        v_p_id,
        v_loc_id,
        2.000,
        'live_shelf',
        now() - interval '5 minutes',
        CASE WHEN k IN ('in_flight_return', 'catch_all_second_measurement')
             THEN now() - interval '1 hour' END,
        CASE WHEN k = 'catch_all_second_measurement' THEN 'catch_all'
             WHEN k = 'in_flight_return' THEN 'live_shelf' END,
        CASE WHEN k IN ('in_flight_return', 'catch_all_second_measurement')
             THEN v_pickup_uuid END,
        CASE WHEN k = 'catch_all_second_measurement' THEN 250.0 END
      );
    END IF;

    BEGIN
      PERFORM private.apply_shelf_event(
        tests.get_supabase_uid('matrix_alice'),
        v_d_id,
        'scale-01',
        CASE WHEN k LIKE 'catch_all%' THEN 'catch_all'
             WHEN k = 'refilled' THEN 'live_scale'
             ELSE 'live_shelf' END,
        k,
        v_p_id,
        CASE
          WHEN k = 'catch_all_first_measurement' THEN 250.0
          WHEN k = 'catch_all_second_measurement' THEN 200.0
          WHEN k = 'in_flight_pickup' THEN -100.0
          WHEN k = 'in_flight_return' THEN 100.0
          WHEN k = 'added' THEN 100.0
          WHEN k = 'refilled' THEN 50.0
          ELSE -50.0
        END,
        now() + (i * interval '1 second'),
        format('matrix-evt-%s', k),
        CASE
          WHEN k = 'catch_all_second_measurement'
            THEN v_pickup_uuid::TEXT
        END
      );
    EXCEPTION WHEN OTHERS THEN
      -- Belt-and-braces — fixtures isolate each kind, but the
      -- audit-row INSERT happens before any branch raises so this
      -- still serves as the "validation accepted" probe.
      NULL;
    END;
  END LOOP;
END $$;

-- Each kind should have produced a shelf_event_log row's payload
-- containing event_kind = <kind>. A missing kind means apply_shelf_event
-- raised a validation error (e.g. unknown kind) BEFORE the audit
-- INSERT — exactly the bug class this invariant pins.
SELECT bag_eq(
  $$SELECT DISTINCT (payload->>'event_kind') FROM chefbyte.shelf_event_log
     WHERE user_id = tests.get_supabase_uid('matrix_alice')$$,
  $$SELECT kind FROM _expected_kinds$$,
  'invariant (decisions.md #44/#56 + 2026-04-22 audit): every '
    'event_kind in VALID_EVENT_KINDS produces a shelf_event_log '
    'audit row when submitted to apply_shelf_event. A missing row '
    'means the kind was rejected before the audit write — every '
    'event of that kind would 4xx in production.'
);

------------------------------------------------------------
-- Assertion 2 — the canonical kind set has the expected size.
-- A drift-detection sentinel: if the Pi-side mirror picks up a
-- new kind, the count diverges and tests visibly disagree.
------------------------------------------------------------

------------------------------------------------------------
-- Assertion 2 (was 3) — every kind's apply produced applied=true.
-- THIS is the strong "branch exists" check. When apply_shelf_event
-- has a real branch for a kind, the branch sets v_result with
-- applied=true on the happy path. A missing/disabled branch leaves
-- the row at applied=false (the up-front INSERT default). This
-- catches the bug class: someone added a VALID_EVENT_KINDS entry
-- on the cloud but forgot the matching branch in apply_shelf_event,
-- so every event of that kind 200s but does nothing.
------------------------------------------------------------
WITH not_applied AS (
  SELECT (payload->>'event_kind') AS event_kind, applied, reason
    FROM chefbyte.shelf_event_log
   WHERE user_id = tests.get_supabase_uid('matrix_alice')
     AND NOT applied
)
SELECT is(
  (SELECT count(*)::integer FROM not_applied),
  0,
  'invariant (matrix EMIT→HANDLE): every kind in VALID_EVENT_KINDS '
    'MUST have a working branch in apply_shelf_event such that the '
    'happy-path call sets applied=true on the audit row. Failure '
    'here means a kind passed validation but had no branch handle '
    'it — the event 200s but no state mutation happens. NEEDS '
    'REVIEW: ' ||
    COALESCE((SELECT string_agg(format('%s [reason=%s]', event_kind, reason),
                                ', ' ORDER BY event_kind)
              FROM not_applied), '<none>')
);

------------------------------------------------------------
-- Assertion 3 — the canonical kind set has the expected size.
-- A drift-detection sentinel: if the Pi-side mirror picks up a
-- new kind, the count diverges and tests visibly disagree.
------------------------------------------------------------

SELECT cmp_ok(
  (SELECT count(*)::integer FROM _expected_kinds),
  '=', 9,
  'invariant: canonical event-kind catalog has 9 entries. If you '
    'added a new kind, update both this test AND the Pi-side '
    'CLOUD_VALID_EVENT_KINDS in '
    'hardware/live-shelf/server/cloud/tests/test_integration_hooks.py '
    'AND supabase/functions/shelf-ingest/index.ts::VALID_EVENT_KINDS. '
    'The drift surfaces here as a count mismatch instead of a '
    'silent prod brick.'
);

SELECT * FROM finish();
ROLLBACK;
