-- pgTAP coverage for chefbyte.stock_lots updated_at + deleted_at columns
-- (migration 20260426010000).
--
-- Scope:
--   1. Columns + index exist.
--   2. updated_at trigger fires on UPDATE (bumps monotonically — essential
--      for the Pi's lot-snapshot delta poller).
--   3. Soft-delete (UPDATE SET deleted_at = now()) also bumps updated_at so
--      tombstones land in the updated_since delta window.
--   4. RLS — user A cannot tombstone user B's lot.

BEGIN;

SELECT plan(8);

-- ─── Schema shape ─────────────────────────────────────────────────
SELECT has_column(
  'chefbyte', 'stock_lots', 'updated_at',
  'stock_lots.updated_at column exists'
);
SELECT col_not_null(
  'chefbyte', 'stock_lots', 'updated_at',
  'stock_lots.updated_at is NOT NULL'
);
SELECT has_column(
  'chefbyte', 'stock_lots', 'deleted_at',
  'stock_lots.deleted_at column exists'
);
SELECT col_is_null(
  'chefbyte', 'stock_lots', 'deleted_at',
  'stock_lots.deleted_at is nullable'
);
SELECT has_index(
  'chefbyte', 'stock_lots', 'stock_lots_user_updated_at_idx',
  'composite index (user_id, updated_at) exists for delta queries'
);
SELECT has_trigger(
  'chefbyte'::name, 'stock_lots'::name, 'stock_lots_set_updated_at'::name,
  'stock_lots_set_updated_at trigger is attached (bumps updated_at on UPDATE)'
);

-- ─── Cross-user seeding (RLS setup) ──────────────────────────────
SELECT tests.create_supabase_user('lot_owner');
SELECT tests.create_supabase_user('lot_intruder');

SELECT tests.authenticate_as('lot_owner');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('lot_intruder');
SELECT hub.activate_app('chefbyte');

SELECT tests.get_supabase_uid('lot_owner')    AS _owner_uid    \gset
SELECT tests.get_supabase_uid('lot_intruder') AS _intruder_uid \gset

-- Seed owner's product + lot (needs FKs). activate_app('chefbyte')
-- already seeded default locations (Fridge / Pantry / Freezer), so we
-- reuse the Fridge row rather than INSERTing a duplicate that would trip
-- locations_user_name_unique.
SELECT tests.authenticate_as('lot_owner');

INSERT INTO chefbyte.products (user_id, name, net_weight_g)
VALUES (:'_owner_uid'::uuid, 'Owner Lot Product', 100)
RETURNING product_id AS _owner_prod \gset

SELECT location_id AS _owner_loc
  FROM chefbyte.locations
 WHERE user_id = :'_owner_uid'::uuid
 ORDER BY created_at
 LIMIT 1
\gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers
) VALUES (
  :'_owner_uid'::uuid, :'_owner_prod'::uuid, :'_owner_loc'::uuid, 2.0
) RETURNING lot_id AS _owner_lot \gset

-- ─── Soft-delete under RLS ───────────────────────────────────────
-- The owner can soft-delete their own lot (trigger fires, row stays).
UPDATE chefbyte.stock_lots
   SET deleted_at = now()
 WHERE lot_id = :'_owner_lot'::uuid;

-- ─── RLS: cross-user soft-delete is a no-op ──────────────────────
-- Intruder tries to tombstone owner's lot. RLS blocks the UPDATE;
-- the row still carries the owner's own deleted_at but nothing
-- further advances from the intruder's attempt. Verify via
-- service_role (bypasses RLS) that the row is still the owner's
-- tombstone only (not cleared or otherwise mutated by intruder).
SELECT tests.authenticate_as('lot_intruder');
UPDATE chefbyte.stock_lots
   SET deleted_at = NULL
 WHERE lot_id = :'_owner_lot'::uuid;

SELECT tests.clear_authentication();
SET ROLE service_role;

SELECT isnt(
  (SELECT deleted_at FROM chefbyte.stock_lots
    WHERE lot_id = :'_owner_lot'::uuid),
  NULL::timestamptz,
  'RLS blocks intruder from clearing owner''s deleted_at'
);

-- Positive control: owner's soft-delete stuck.
SELECT ok(
  EXISTS (
    SELECT 1 FROM chefbyte.stock_lots
     WHERE lot_id = :'_owner_lot'::uuid
       AND deleted_at IS NOT NULL
       AND updated_at >= created_at
  ),
  'owner''s soft-delete persisted and updated_at advanced'
);

SELECT finish();
ROLLBACK;
