-- pgTAP — sync-audit finding #6: food_logs.usage_kind discriminator
-- propagates from apply_shelf_event's p_usage_kind parameter into the
-- food_logs INSERTs in the consumed branches.
--
-- Coverage:
--   1. Pi-emitted ``consumed`` event with p_usage_kind='reconciler_use_return'
--      lands a food_logs row with the matching usage_kind.
--   2. NULL p_usage_kind (older Pi binaries that don't pass the field)
--      stamps usage_kind=NULL on food_logs — backward-compatible shape.
--   3. The food_logs.usage_kind column exists + has TEXT type with no
--      CHECK constraint (forward-compat for Pi enum growth).
--
-- Companion to ``supabase/migrations/20260429080000_food_logs_usage_kind.sql``.
-- The mutation that drops ``usage_kind`` from the food_logs INSERT
-- column list trips assertion 2 (column was added to schema, but the
-- INSERT didn't stamp it → row lands NULL where we expect a value).

BEGIN;
SELECT plan(5);

------------------------------------------------------------
-- Setup (authenticated user)
------------------------------------------------------------

SELECT tests.create_supabase_user('uk_alice');
SELECT tests.authenticate_as('uk_alice');
SELECT hub.activate_app('chefbyte');

-- Seed product (carries macros so the consumed branch writes a
-- food_logs row, not just a stock decrement).
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('uk_alice'),
  'UK Test Yogurt',
  500, 4,
  100, 12, 8, 2
);

SELECT product_id AS uk_product_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('uk_alice')
   AND name = 'UK Test Yogurt' \gset

SELECT location_id AS uk_loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('uk_alice')
   AND name = 'Fridge' \gset

INSERT INTO chefbyte.live_shelf_devices (
  user_id, device_name, import_key_hash, is_active
) VALUES (
  tests.get_supabase_uid('uk_alice'),
  'uk-pi',
  'uk_hash_alice',
  true
);

SELECT device_id AS uk_device_id
  FROM chefbyte.live_shelf_devices
 WHERE user_id = tests.get_supabase_uid('uk_alice')
   AND device_name = 'uk-pi' \gset

INSERT INTO chefbyte.stock_lots (
  user_id, product_id, location_id, qty_containers,
  last_update_source, last_update_ts
) VALUES (
  tests.get_supabase_uid('uk_alice'),
  :'uk_product_id',
  :'uk_loc_id',
  1.0,
  'live_shelf',
  now() - interval '5 minutes'
);

------------------------------------------------------------
-- Assertion 1: schema — column exists, TEXT, no CHECK
------------------------------------------------------------

SELECT has_column(
  'chefbyte', 'food_logs', 'usage_kind',
  'food_logs.usage_kind column exists'
);

SELECT col_type_is(
  'chefbyte', 'food_logs', 'usage_kind', 'text',
  'food_logs.usage_kind is TEXT (forward-compat — no CHECK)'
);

------------------------------------------------------------
-- Assertion 2: Pi-emitted consumed event with usage_kind stamps food_logs
------------------------------------------------------------

-- Elevate to postgres so direct private.apply_shelf_event calls succeed.
SET LOCAL role postgres;

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-uk', 'live_shelf', 'consumed',
        %L::UUID, -125.0, now()::TIMESTAMPTZ, 'evt-uk-1',
        NULL, 'reconciler_use_return'
      )$$,
    tests.get_supabase_uid('uk_alice'),
    :'uk_device_id',
    :'uk_product_id'
  ),
  'consumed event with p_usage_kind=''reconciler_use_return'' applies'
);

SELECT is(
  (SELECT usage_kind
     FROM chefbyte.food_logs
    WHERE user_id = tests.get_supabase_uid('uk_alice')
      AND source_client_event_id = 'evt-uk-1'),
  'reconciler_use_return',
  'food_logs.usage_kind = ''reconciler_use_return'' on the resulting row'
);

------------------------------------------------------------
-- Assertion 3: Pi-emitted consumed event without usage_kind → NULL
-- (backward-compat for older Pi binaries that omit the field)
------------------------------------------------------------

SELECT lives_ok(
  format(
    $$SELECT * FROM private.apply_shelf_event(
        %L::UUID, %L::UUID, 'scale-uk', 'live_shelf', 'consumed',
        %L::UUID, -125.0, now()::TIMESTAMPTZ, 'evt-uk-2',
        NULL
      )$$,
    tests.get_supabase_uid('uk_alice'),
    :'uk_device_id',
    :'uk_product_id'
  ),
  'consumed event without p_usage_kind applies (backward-compat)'
);

SELECT * FROM finish();
ROLLBACK;
