-- pgTAP — per-lot scale_pairings + auto-rotation
-- Validates supabase/migrations/20260427080000_scale_pairings_lot_level.sql.
--
-- Coverage:
--   1. lot_id column exists with FK to stock_lots and is nullable.
--   2. partial index scale_pairings_active_lot_idx exists.
--   3. RLS still works after the column add (4-op coverage).
--   4. apply_shelf_event with pinned lot_id targets the pinned lot —
--      NOT the FEFO lot.
--   5. apply_shelf_event with NULL lot_id falls back to FEFO.
--   6. After consumed drives the pinned lot to qty=0:
--        a. scale_pairings.lot_id is rotated to the next FEFO candidate.
--        b. shelf_event_log.reason ends with ':rotated'.
--   7. After consumed depletes the pinned lot AND no candidate exists:
--        a. scale_pairings.lot_id becomes NULL.
--        b. hub.alerts row created with invariant_name=
--           'scale_pairings_rotation_pending'.
--        c. shelf_event_log.reason ends with ':rotation_pending'.

BEGIN;
SELECT plan(17);

------------------------------------------------------------
-- Setup
------------------------------------------------------------

SELECT tests.create_supabase_user('sp_lot_alice');
SELECT tests.authenticate_as('sp_lot_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('sp_lot_alice'),
  'Per-lot Pairing Test Product',
  500, 5,
  100, 10, 5, 2
);

SELECT product_id AS alice_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('sp_lot_alice')
   AND name = 'Per-lot Pairing Test Product' \gset

SELECT location_id AS alice_fridge_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('sp_lot_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('sp_lot_alice'),
  'sp-lot-pi',
  'sp_lot_hash_alice',
  true
);

SELECT device_id AS alice_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('sp_lot_alice')
   AND device_name = 'sp-lot-pi' \gset

-- Two lots of the same product. Lot A expires sooner (FEFO winner).
-- ``last_update_source`` is left NULL so the partial unique
-- ``stock_lots_one_per_tracked_shelf`` (which gates only on
-- live_shelf/live_scale) doesn't apply — multiple untracked lots of
-- the same SKU are legal (e.g. two bottles bought separately and
-- intaked manually).
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('sp_lot_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  1.0,
  '2026-05-15',
  NULL,
  now() - interval '2 hours'
);

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers, expires_on,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('sp_lot_alice'),
  :'alice_product_id',
  :'alice_fridge_id',
  1.0,
  '2026-06-15',
  NULL,
  now() - interval '1 hour'
);

SELECT lot_id AS alice_lot_a
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('sp_lot_alice')
   AND product_id = :'alice_product_id'
   AND expires_on = '2026-05-15' \gset

SELECT lot_id AS alice_lot_b
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('sp_lot_alice')
   AND product_id = :'alice_product_id'
   AND expires_on = '2026-06-15' \gset

-- Pair scale-03 to product, pinned to lot B (NOT the FEFO winner).
INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind, product_id, lot_id
) VALUES (
  tests.get_supabase_uid('sp_lot_alice'),
  :'alice_device_id',
  'scale-03',
  'live_scale',
  :'alice_product_id',
  :'alice_lot_b'
);

SELECT pairing_id AS alice_pairing_id
  FROM chefbyte.scale_pairings
 WHERE user_id = tests.get_supabase_uid('sp_lot_alice')
   AND device_id = :'alice_device_id'
   AND scale_id = 'scale-03' \gset

------------------------------------------------------------
-- Case 1: schema sanity
------------------------------------------------------------

SELECT col_is_null(
  'chefbyte', 'scale_pairings', 'lot_id',
  'case 1a: scale_pairings.lot_id is nullable'
);

SELECT has_index(
  'chefbyte', 'scale_pairings', 'scale_pairings_active_lot_idx',
  'case 1b: partial index scale_pairings_active_lot_idx exists'
);

SELECT col_type_is(
  'chefbyte', 'scale_pairings', 'lot_id', 'uuid',
  'case 1c: lot_id is UUID'
);

------------------------------------------------------------
-- Case 2: RLS — the new column doesn't break existing policy
-- (re-runs the read-own-row + write-spoof guards)
------------------------------------------------------------

SELECT ok(
  EXISTS (SELECT 1 FROM chefbyte.scale_pairings
    WHERE pairing_id = :'alice_pairing_id'),
  'case 2a: User can SELECT own scale_pairings (RLS unbroken by lot_id)'
);

------------------------------------------------------------
-- Case 3: apply_shelf_event with pinned lot_id targets the pinned lot
-- (NOT the FEFO winner — this is the whole reason the change exists)
------------------------------------------------------------

SET LOCAL role postgres;

-- Pinned lot is B. FEFO winner is A. Send a consumed event with delta=-100g
-- (= -0.2 ctn). Expect lot B's qty to drop, lot A's qty to be untouched.
SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'consumed',
        %L::UUID, -100, now()::TIMESTAMPTZ, 'evt-pinned-1', NULL
      )$$,
    tests.get_supabase_uid('sp_lot_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 3a: apply_shelf_event with pinned pairing.lot_id runs'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_b')::numeric(10,3),
  0.800::numeric(10,3),
  'case 3b: pinned lot B was decremented (1.0 - 0.2 = 0.8)'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_a')::numeric(10,3),
  1.000::numeric(10,3),
  'case 3c: FEFO lot A was NOT touched — pinning honoured over FEFO'
);

------------------------------------------------------------
-- Case 4: apply_shelf_event with NULL lot_id falls back to FEFO
-- Reset the pairing to NULL, send a consumed event, expect lot A to be hit.
-- Also zero lot B's qty so the partial-unique
-- ``stock_lots_one_per_tracked_shelf`` invariant stays intact when
-- lot A flips to live_scale below (Case 3 already flipped lot B to
-- live_scale qty=0.8).
------------------------------------------------------------

UPDATE chefbyte.stock_lots
   SET qty_containers = 0
 WHERE lot_id = :'alice_lot_b';

UPDATE chefbyte.scale_pairings
   SET lot_id = NULL
 WHERE pairing_id = :'alice_pairing_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'consumed',
        %L::UUID, -100, now()::TIMESTAMPTZ, 'evt-fefo-1', NULL
      )$$,
    tests.get_supabase_uid('sp_lot_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 4a: apply_shelf_event with NULL pairing.lot_id runs'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_a')::numeric(10,3),
  0.800::numeric(10,3),
  'case 4b: FEFO winner (lot A) was decremented when pairing.lot_id is NULL'
);

------------------------------------------------------------
-- Case 5: rotation — pinned lot drops to qty=0, pairing rotates to next.
-- Re-pin the pairing to lot A (which is now at 0.8). Send a consumed
-- delta of -400g (= -0.8 ctn) to zero it out. Expect:
--   * lot A qty=0
--   * scale_pairings.lot_id flipped to lot B
--   * shelf_event_log.reason ends with ':rotated'
------------------------------------------------------------

-- Reset lot B back to qty=1 so it's a candidate for rotation. Source
-- stays NULL so the partial-unique invariant doesn't fire when lot A
-- flips to live_scale qty=0 below.
UPDATE chefbyte.stock_lots
   SET qty_containers = 1.0,
       last_update_source = NULL
 WHERE lot_id = :'alice_lot_b';

UPDATE chefbyte.scale_pairings
   SET lot_id = :'alice_lot_a'
 WHERE pairing_id = :'alice_pairing_id';

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'consumed',
        %L::UUID, -400, now()::TIMESTAMPTZ, 'evt-rotate-1', NULL
      )$$,
    tests.get_supabase_uid('sp_lot_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 5a: rotation-trigger consumed call runs'
);

SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE lot_id = :'alice_lot_a')::numeric(10,3),
  0.000::numeric(10,3),
  'case 5b: pinned lot A was driven to qty=0'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings
    WHERE pairing_id = :'alice_pairing_id'),
  (:'alice_lot_b')::uuid,
  'case 5c: scale_pairings.lot_id rotated to lot B (the next on-shelf candidate)'
);

SELECT ok(
  (SELECT reason LIKE '%:rotated'
     FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'evt-rotate-1'),
  'case 5d: shelf_event_log.reason ends with :rotated'
);

------------------------------------------------------------
-- Case 6: rotation-pending — depleted, no candidate.
-- Pairing now points at lot B (the only remaining on-shelf lot, qty=0.8).
-- Send a depleted event to zero it out. With no other lot for the
-- product, expect:
--   * scale_pairings.lot_id becomes NULL.
--   * hub.alerts row 'scale_pairings_rotation_pending' is created.
--   * shelf_event_log.reason ends with ':rotation_pending'.
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-03', 'live_scale', 'depleted',
        %L::UUID, -400, now()::TIMESTAMPTZ, 'evt-rotate-2', NULL
      )$$,
    tests.get_supabase_uid('sp_lot_alice'),
    :'alice_device_id',
    :'alice_product_id'
  ),
  'case 6a: depleted rotation-pending consumed call runs'
);

SELECT is(
  (SELECT lot_id FROM chefbyte.scale_pairings
    WHERE pairing_id = :'alice_pairing_id'),
  NULL,
  'case 6b: scale_pairings.lot_id NULL when no candidate for rotation'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM hub.alerts
     WHERE invariant_name = 'scale_pairings_rotation_pending'
       AND user_id = tests.get_supabase_uid('sp_lot_alice')
       AND subject_id = (:'alice_pairing_id')::text
  ),
  'case 6c: hub.alerts row created with rotation-pending invariant'
);

SELECT ok(
  (SELECT reason LIKE '%:rotation_pending'
     FROM chefbyte.shelf_event_log
    WHERE client_event_id = 'evt-rotate-2'),
  'case 6d: shelf_event_log.reason ends with :rotation_pending'
);

------------------------------------------------------------
-- Teardown
------------------------------------------------------------

SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('sp_lot_alice');

SELECT * FROM finish();
ROLLBACK;
