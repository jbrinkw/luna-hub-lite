-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — live_scale pairings MUST pin a lot_id when
-- a candidate stock_lot exists.
-- ════════════════════════════════════════════════════════════════════════════
-- Pins migration 20260429190000_backfill_live_scale_lot_id.sql contract:
--   "For every chefbyte.scale_pairings row where kind = 'live_scale'
--    AND product_id IS NOT NULL AND there exists at least one
--    stock_lots row for (user_id, product_id), assert lot_id IS NOT NULL."
--
-- Rationale: When a live_scale pairing has product_id but lot_id IS NULL,
-- the apply_shelf_event live_scale branch (see migration
-- 20260429010000_live_scale_never_mints_v2.sql, resolver tiers b → c → d)
-- falls through to FEFO/heuristic lot selection. That works for the single-
-- lot case but is wrong the moment >1 lot exists for the product. Recurring
-- sync-drift bugs (consumed/refilled landing on the wrong lot, qty drift)
-- trace back to this gap.
--
-- The complementary lot_id-consistency invariant
-- (scale_pairings_lot_id_consistency.test.sql) pins what happens when
-- lot_id IS NOT NULL (must be same user + same product). THIS test pins
-- the orthogonal rule that lot_id MUST be set whenever a candidate exists.
--
-- POSITIVE FAILURE PROOF:
-- The setup plants a deliberately-broken pairing (product_id set, lot_id
-- NULL, but lots exist for that user+product), then asserts the invariant
-- query catches it before fixing the row and asserting the global query
-- shows zero violations. This guards against tautology / weak assertions.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(3);

------------------------------------------------------------
-- Setup — seed a violator + a healthy row to prove the assertion
-- discriminates correctly.
------------------------------------------------------------

SELECT tests.create_supabase_user('lot_id_invariant_alice');
SELECT tests.authenticate_as('lot_id_invariant_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('lot_id_invariant_alice'),
  'Lot ID Invariant Product', 500, 5, 100, 12, 4, 2
);

SELECT product_id AS p_alice
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('lot_id_invariant_alice')
   AND name = 'Lot ID Invariant Product' \gset

SELECT location_id AS loc_alice
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('lot_id_invariant_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('lot_id_invariant_alice'),
  'lot-id-pi', 'lot_id_hash', true
);

SELECT device_id AS d_alice
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('lot_id_invariant_alice') \gset

-- Plant a stock_lot for the product. This is the "candidate exists"
-- precondition for the invariant.
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('lot_id_invariant_alice'),
  :'p_alice', :'loc_alice', 1.000,
  'live_scale', now()
);

SELECT lot_id AS lot_alice
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('lot_id_invariant_alice') \gset

-- Plant the broken pairing (product_id set, lot_id NULL).
SET LOCAL role postgres;
INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind, product_id, lot_id,
  first_seen_at
) VALUES (
  tests.get_supabase_uid('lot_id_invariant_alice'),
  :'d_alice', 'scale-broken', 'live_scale',
  :'p_alice', NULL,
  now()
);

------------------------------------------------------------
-- Assertion 1 — meta-correctness: the invariant query MUST catch the
-- planted violation. If this fails the assertion is broken (e.g. wrong
-- WHERE clause, missed an EXISTS leg).
------------------------------------------------------------

WITH violators AS (
  SELECT sp.pairing_id
    FROM chefbyte.scale_pairings sp
   WHERE sp.kind = 'live_scale'
     AND sp.product_id IS NOT NULL
     AND sp.lot_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM chefbyte.stock_lots sl
        WHERE sl.user_id = sp.user_id
          AND sl.product_id = sp.product_id
     )
)
SELECT is(
  (SELECT count(*)::integer FROM violators
    WHERE pairing_id IN (
      SELECT pairing_id FROM chefbyte.scale_pairings
      WHERE scale_id = 'scale-broken'
        AND user_id = tests.get_supabase_uid('lot_id_invariant_alice')
    )
  ),
  1,
  'meta: the invariant query catches the planted (product_id NOT NULL, '
    'lot_id NULL, candidate lot exists) violator. If this fails the '
    'invariant query is broken — it would let real production drift '
    'slip through.'
);

------------------------------------------------------------
-- Fix the row, then assert the global invariant holds.
------------------------------------------------------------

UPDATE chefbyte.scale_pairings
   SET lot_id = :'lot_alice'
 WHERE scale_id = 'scale-broken'
   AND user_id = tests.get_supabase_uid('lot_id_invariant_alice');

------------------------------------------------------------
-- Assertion 2 — the planted row no longer violates after the fix.
------------------------------------------------------------

WITH violators AS (
  SELECT sp.pairing_id
    FROM chefbyte.scale_pairings sp
   WHERE sp.kind = 'live_scale'
     AND sp.product_id IS NOT NULL
     AND sp.lot_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM chefbyte.stock_lots sl
        WHERE sl.user_id = sp.user_id
          AND sl.product_id = sp.product_id
     )
     AND sp.scale_id = 'scale-broken'
     AND sp.user_id = tests.get_supabase_uid('lot_id_invariant_alice')
)
SELECT is(
  (SELECT count(*)::integer FROM violators),
  0,
  'after pinning lot_id, the planted row no longer violates the '
    'invariant. Confirms the fix path (UPDATE lot_id) clears the '
    'condition the assertion is checking.'
);

------------------------------------------------------------
-- Assertion 3 — global production invariant: NO live_scale pairing in the
-- whole DB has product_id set, lot_id NULL, and at least one matching lot.
-- This is the assertion that runs against real prod data after the
-- backfill migration applies.
------------------------------------------------------------

WITH violators AS (
  SELECT sp.pairing_id, sp.scale_id, sp.user_id, sp.product_id
    FROM chefbyte.scale_pairings sp
   WHERE sp.kind = 'live_scale'
     AND sp.product_id IS NOT NULL
     AND sp.lot_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM chefbyte.stock_lots sl
        WHERE sl.user_id = sp.user_id
          AND sl.product_id = sp.product_id
     )
)
SELECT is(
  (SELECT count(*)::integer FROM violators),
  0,
  'invariant (migration 20260429190000): every live_scale pairing with '
    'product_id IS NOT NULL AND at least one matching stock_lots row '
    'MUST have lot_id IS NOT NULL. Manual-pair UI and the LiveTrack '
    'wizard now both pin lot_id at creation; the cloud→Pi pairings '
    'sync poller forwards lot_id; this invariant guards against any '
    'future code path that reintroduces the gap.'
);

SELECT * FROM finish();
ROLLBACK;
