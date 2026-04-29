-- pgTAP invariant — live_shelf qty_containers stays at "one container".
--
-- USER RULE (2026-04-29, after Gatorade/Chicken qty=2.4/1.4 bug):
--   "a lot should not be much more than 1 and only that for error bounds
--    with hardware weight tracking."
--
-- A stock_lots row tracked by live_shelf (last_update_source='live_shelf')
-- represents exactly ONE physical container. The qty must therefore stay
-- at or near 1.0 — the 0.05 epsilon allows for hardware rounding/error
-- but rejects the partial-bottle accumulation pattern (qty drifting to
-- 1.4, 1.7, 2.4 etc as users repeatedly placed partial bottles back).
--
-- Companion to migration
-- 20260429210000_partial_place_no_qty_bump.sql, which both fixes the
-- accumulation logic AND backfills affected rows to qty=1.0.
--
-- This test is a pure DATA invariant — no setup, just SELECT against
-- existing rows. It runs against the test/local DB which has no
-- live_shelf rows seeded; if seeded rows are added later, they must
-- conform.

BEGIN;
SELECT plan(2);

------------------------------------------------------------
-- 1. No live_shelf qty>0 row exceeds 1.0 + epsilon.
------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int
     FROM chefbyte.stock_lots
    WHERE last_update_source = 'live_shelf'
      AND qty_containers > 1.05),
  0,
  'no live_shelf-tracked row has qty_containers > 1.05 (one-container rule)'
);

------------------------------------------------------------
-- 2. Live-fire end-to-end: planting an existing live_shelf qty=1.0
--    lot and triggering ANOTHER live_shelf placement (the partial-
--    return scenario) MUST NOT bump qty_containers past 1.0.
------------------------------------------------------------
SELECT tests.create_supabase_user('clamp_alice');
SELECT tests.authenticate_as('clamp_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, gross_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('clamp_alice'),
  'Clamp Test Gatorade',
  -- net 591g (the actual liquid). gross intentionally NULL to mirror
  -- the production state where the bug repros.
  591, NULL, 1, 200, 50, 0, 0
);

SELECT product_id AS clamp_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('clamp_alice')
   AND name = 'Clamp Test Gatorade' \gset

SELECT location_id AS clamp_loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('clamp_alice')
   AND name = 'Fridge' \gset

-- Plant an existing live_shelf-tracked qty=1.0 lot (representing the
-- bottle the user already placed once).
INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('clamp_alice'),
  :'clamp_product_id',
  :'clamp_loc_id',
  1.0,
  'live_shelf',
  now() - interval '5 minutes'
);

-- Trigger a partial-return placement (delta_g=206g; net=591g; the
-- pre-fix arithmetic would have produced qty = 1.0 + 206/591 ≈ 1.349).
SET LOCAL role postgres;
SELECT private.resolve_add_to_shelf_lot(
  tests.get_supabase_uid('clamp_alice'),
  :'clamp_product_id',
  'live_shelf',
  :'clamp_loc_id',
  206.0,
  NULL,
  now()
) AS clamp_resolved \gset
RESET role;

SELECT tests.authenticate_as('clamp_alice');

SELECT cmp_ok(
  (SELECT qty_containers
     FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('clamp_alice')
      AND product_id = :'clamp_product_id'
      AND last_update_source = 'live_shelf')::numeric,
  '<=',
  1.05::numeric,
  'partial-return placement does NOT bump qty_containers past 1.05'
);

SELECT * FROM finish();
ROLLBACK;
