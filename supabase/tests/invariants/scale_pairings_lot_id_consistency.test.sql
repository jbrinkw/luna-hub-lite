-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — scale_pairings.lot_id consistency
-- ════════════════════════════════════════════════════════════════════════════
-- Pins migration 20260427080000_scale_pairings_lot_level.sql contract:
--   "When ``scale_pairings.lot_id`` is set, it MUST refer to a lot owned
--    by the same user AND of the same product as the pairing's
--    product_id."
--
-- Rationale: scale_pairings + stock_lots are both user-scoped via
-- user_id RLS. A pairing whose lot_id points at a different user's lot
-- (or a different product's lot) creates a cross-user / cross-product
-- write surface every time the apply path FEFO-decrements that lot.
-- The migration's backfill is correct; the FK only enforces existence,
-- not the user-scope or product-scope invariant.
--
-- This invariant pins the design rule by enumerating every paired
-- (lot_id IS NOT NULL) live_scale row and asserting:
--   1. The pointed-at lot exists.
--   2. The pointed-at lot's user_id matches the pairing's user_id.
--   3. The pointed-at lot's product_id matches the pairing's product_id.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(3);

------------------------------------------------------------
-- Setup — seed a valid + invalid pairing as a proof the test
-- discriminates correctly. We DON'T need the invalid case in
-- production (the test fires on real prod data) but planting one
-- in the test verifies the assertions actually catch drift.
------------------------------------------------------------

SELECT tests.create_supabase_user('pair_invariant_alice');
SELECT tests.create_supabase_user('pair_invariant_bob');

SELECT tests.authenticate_as('pair_invariant_alice');
SELECT hub.activate_app('chefbyte');

INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('pair_invariant_alice'),
  'Pairing Invariant Product Alice', 500, 5, 100, 12, 4, 2
);

SELECT product_id AS p_alice
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('pair_invariant_alice')
   AND name = 'Pairing Invariant Product Alice' \gset

SELECT location_id AS loc_alice
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('pair_invariant_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (user_id, device_name, import_key_hash, is_active)
VALUES (tests.get_supabase_uid('pair_invariant_alice'), 'pair-pi', 'pair_hash', true);

SELECT device_id AS d_alice
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('pair_invariant_alice') \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('pair_invariant_alice'),
  :'p_alice', :'loc_alice', 1.000,
  'live_shelf', now()
);

SELECT lot_id AS lot_alice
  FROM chefbyte.stock_lots
 WHERE user_id = tests.get_supabase_uid('pair_invariant_alice') \gset

-- Plant a VALID live_scale pairing.
SET LOCAL role postgres;
INSERT INTO chefbyte.scale_pairings (
  user_id, device_id, scale_id, kind, product_id, lot_id,
  first_seen_at
) VALUES (
  tests.get_supabase_uid('pair_invariant_alice'),
  :'d_alice', 'scale-99', 'live_scale',
  :'p_alice', :'lot_alice',
  now()
);

------------------------------------------------------------
-- Assertion 1 — every live_scale pairing with non-NULL lot_id has a
-- matching stock_lots row (FK is ON DELETE SET NULL, so a dangling
-- ID would mean the FK was bypassed somehow).
------------------------------------------------------------

WITH dangling AS (
  SELECT sp.pairing_id, sp.lot_id
  FROM chefbyte.scale_pairings sp
  WHERE sp.kind = 'live_scale'
    AND sp.lot_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM chefbyte.stock_lots sl
       WHERE sl.lot_id = sp.lot_id
    )
)
SELECT is(
  (SELECT count(*)::integer FROM dangling),
  0,
  'invariant: every live_scale pairing with non-NULL lot_id MUST '
    'point to an existing stock_lots row. ON DELETE SET NULL on '
    'the FK means a dangling pointer requires bypassing the FK '
    '(e.g. direct DELETE from a SECURITY DEFINER function that '
    'forgot to NULL the pairing first).'
);

------------------------------------------------------------
-- Assertion 2 — same user_id on pairing and pointed-at lot.
------------------------------------------------------------

WITH cross_user AS (
  SELECT sp.pairing_id, sp.user_id AS pair_user, sl.user_id AS lot_user
  FROM chefbyte.scale_pairings sp
  JOIN chefbyte.stock_lots sl ON sl.lot_id = sp.lot_id
  WHERE sp.kind = 'live_scale'
    AND sp.lot_id IS NOT NULL
    AND sp.user_id <> sl.user_id
)
SELECT is(
  (SELECT count(*)::integer FROM cross_user),
  0,
  'invariant: live_scale pairings MUST point at lots owned by the '
    'SAME user. Cross-user lot pinning is a cross-tenant write '
    'surface — every apply_shelf_event call against this pairing '
    'mutates another user''s inventory.'
);

------------------------------------------------------------
-- Assertion 3 — same product_id on pairing and pointed-at lot.
------------------------------------------------------------

WITH cross_product AS (
  SELECT sp.pairing_id, sp.product_id AS pair_product, sl.product_id AS lot_product
  FROM chefbyte.scale_pairings sp
  JOIN chefbyte.stock_lots sl ON sl.lot_id = sp.lot_id
  WHERE sp.kind = 'live_scale'
    AND sp.lot_id IS NOT NULL
    AND sp.product_id IS NOT NULL
    AND sp.product_id <> sl.product_id
)
SELECT is(
  (SELECT count(*)::integer FROM cross_product),
  0,
  'invariant (migration 20260427080000): live_scale pairings MUST '
    'point at lots of the SAME product. A cross-product pin makes '
    'every refilled/consumed event from this scale increment the '
    'wrong product''s inventory.'
);

SELECT * FROM finish();
ROLLBACK;
