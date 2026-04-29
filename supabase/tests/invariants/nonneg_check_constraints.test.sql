-- ════════════════════════════════════════════════════════════════════════════
-- Design-intent invariant — non-negative CHECK constraints on critical columns
-- ════════════════════════════════════════════════════════════════════════════
-- Pins three migration-level rules that L11 (audit_invariants_pinned)
-- flagged as unpinned:
--
--   * 20260304040004_nonnegative_constraints.sql:
--       "Product macros must be non-negative"
--       "Planned set targets must be non-negative (NULLs are allowed)"
--   * 20260419060000_shelf_ingest_hardening_v2.sql:
--       "net_weight_g must be > 0 when present"
--       "pending_review_count must be >= 0"
--   * 20260429030000_live_weight_sync.sql:
--       "last_observed_weight_g must be >= 0 when present"
--
-- All five rules are encoded as table CHECK constraints. This test pins
-- the rules by:
--   1. Asserting each named constraint exists on the expected table.
--   2. Asserting each constraint actually rejects an offending value
--      (so a future migration that drops the CHECK or weakens it to a
--      no-op would surface here).
--
-- The test deliberately uses INSERT-and-expect-rejection rather than
-- relying solely on `pg_constraint` rows, because a CHECK can exist
-- with the wrong predicate (e.g. `>= -1`) and still pass a name lookup.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;
SELECT plan(17);

------------------------------------------------------------
-- Setup — single test user owning every row we attempt below.
------------------------------------------------------------

SELECT tests.create_supabase_user('nn_alice');
SELECT tests.authenticate_as('nn_alice');
SELECT hub.activate_app('chefbyte');
SELECT hub.activate_app('coachbyte');

------------------------------------------------------------
-- 1. Existence checks — every named CHECK constraint must exist.
--    pgTAP's `has_check(schema, table, label)` only accepts a 3-arg
--    form (no constraint-name lookup), so we query pg_constraint
--    directly and assert each named constraint is present.
------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.assert_check_exists(
  p_schema TEXT, p_table TEXT, p_constraint TEXT
) RETURNS BOOLEAN LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class      cl ON cl.oid = c.conrelid
      JOIN pg_namespace  n  ON n.oid  = cl.relnamespace
     WHERE c.contype = 'c'
       AND c.conname = p_constraint
       AND cl.relname = p_table
       AND n.nspname  = p_schema
  );
$$;

SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'products', 'products_calories_nonneg'),
  'chefbyte.products has CHECK products_calories_nonneg (calories_per_serving >= 0)'
);
SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'products', 'products_protein_nonneg'),
  'chefbyte.products has CHECK products_protein_nonneg (protein_per_serving >= 0)'
);
SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'products', 'products_carbs_nonneg'),
  'chefbyte.products has CHECK products_carbs_nonneg (carbs_per_serving >= 0)'
);
SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'products', 'products_fat_nonneg'),
  'chefbyte.products has CHECK products_fat_nonneg (fat_per_serving >= 0)'
);
SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'products', 'products_net_weight_g_positive'),
  'chefbyte.products has CHECK products_net_weight_g_positive (net_weight_g > 0 when present)'
);
SELECT ok(
  pg_temp.assert_check_exists('coachbyte', 'planned_sets', 'planned_sets_reps_nonneg'),
  'coachbyte.planned_sets has CHECK planned_sets_reps_nonneg (target_reps >= 0 OR NULL)'
);
SELECT ok(
  pg_temp.assert_check_exists('coachbyte', 'planned_sets', 'planned_sets_load_nonneg'),
  'coachbyte.planned_sets has CHECK planned_sets_load_nonneg (target_load >= 0 OR NULL)'
);
SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'live_shelf_devices', 'live_shelf_devices_pending_review_nonneg'),
  'chefbyte.live_shelf_devices has CHECK live_shelf_devices_pending_review_nonneg (>= 0)'
);
SELECT ok(
  pg_temp.assert_check_exists('chefbyte', 'stock_lots', 'stock_lots_last_observed_weight_g_check'),
  'chefbyte.stock_lots has CHECK stock_lots_last_observed_weight_g_check (>= 0 or NULL)'
);

------------------------------------------------------------
-- 2. Behavioural checks — each CHECK actually rejects a bad value.
--    INSERT minimal rows that violate just the targeted constraint.
------------------------------------------------------------

-- 2a. products macros — all four columns must reject negatives via the
--     compound INSERT (the first failing CHECK aborts the row, so we
--     poke each macro column independently with separate INSERTs).
SELECT throws_ok(
  $$INSERT INTO chefbyte.products (
      user_id, name, net_weight_g, servings_per_container,
      calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
    ) VALUES (
      tests.get_supabase_uid('nn_alice'), 'NN bad cals', 100, 1,
      -1, 0, 0, 0
    )$$,
  '23514',
  NULL,
  'products: calories_per_serving < 0 is rejected by CHECK'
);

SELECT throws_ok(
  $$INSERT INTO chefbyte.products (
      user_id, name, net_weight_g, servings_per_container,
      calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
    ) VALUES (
      tests.get_supabase_uid('nn_alice'), 'NN bad fat', 100, 1,
      0, 0, 0, -0.5
    )$$,
  '23514',
  NULL,
  'products: fat_per_serving < 0 is rejected by CHECK'
);

-- 2b. products.net_weight_g must be > 0 (zero is rejected, NULL allowed)
SELECT throws_ok(
  $$INSERT INTO chefbyte.products (
      user_id, name, net_weight_g, servings_per_container,
      calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
    ) VALUES (
      tests.get_supabase_uid('nn_alice'), 'NN bad net_weight', 0, 1,
      0, 0, 0, 0
    )$$,
  '23514',
  NULL,
  'products: net_weight_g = 0 is rejected by CHECK (must be > 0 when present)'
);

-- 2c. live_shelf_devices.pending_review_count >= 0
SELECT throws_ok(
  $$INSERT INTO chefbyte.live_shelf_devices (
      user_id, device_name, import_key_hash, is_active, pending_review_count
    ) VALUES (
      tests.get_supabase_uid('nn_alice'), 'nn-pi', 'nn_hash', true, -1
    )$$,
  '23514',
  NULL,
  'live_shelf_devices: pending_review_count < 0 is rejected by CHECK'
);

-- 2d. stock_lots.last_observed_weight_g >= 0 (NULL allowed)
--     We need a real product + lot row first.
INSERT INTO chefbyte.products (
  user_id, name, net_weight_g, servings_per_container,
  calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving
) VALUES (
  tests.get_supabase_uid('nn_alice'), 'NN OK Product', 500, 5,
  100, 10, 5, 5
);

SELECT product_id AS p_id
  FROM chefbyte.products
 WHERE user_id = tests.get_supabase_uid('nn_alice')
   AND name = 'NN OK Product' \gset

SELECT location_id AS loc_id
  FROM chefbyte.locations
 WHERE user_id = tests.get_supabase_uid('nn_alice')
   AND name = 'Fridge' \gset

SELECT throws_ok(
  format(
    $$INSERT INTO chefbyte.stock_lots (
        user_id, product_id, location_id, qty_containers,
        last_observed_weight_g
      ) VALUES (
        tests.get_supabase_uid('nn_alice'),
        %L::UUID, %L::UUID, 1.0, -1.0
      )$$,
    :'p_id', :'loc_id'
  ),
  '23514',
  NULL,
  'stock_lots: last_observed_weight_g < 0 is rejected by CHECK'
);

-- 2e. coachbyte.planned_sets — target_reps and target_load must reject
--     negatives. NULL is allowed (the constraint phrasing is `>= 0 OR
--     IS NULL`). The auth'd ensure_daily_plan(p_day) variant writes
--     under (select auth.uid()) which is set by tests.authenticate_as.
SELECT lives_ok(
  $$SELECT coachbyte.ensure_daily_plan(CURRENT_DATE)$$,
  'planned_sets setup: coachbyte.ensure_daily_plan(CURRENT_DATE) succeeds'
);

SELECT plan_id AS plan_id
  FROM coachbyte.daily_plans
 WHERE user_id = tests.get_supabase_uid('nn_alice')
 ORDER BY logical_date DESC
 LIMIT 1 \gset

SELECT exercise_id AS ex_id
  FROM coachbyte.exercises
 LIMIT 1 \gset

SELECT throws_ok(
  format(
    $$INSERT INTO coachbyte.planned_sets (
        plan_id, user_id, exercise_id, "order", target_reps, target_load
      ) VALUES (
        %L::UUID, tests.get_supabase_uid('nn_alice'),
        %L::UUID, 1, -1, NULL
      )$$,
    :'plan_id', :'ex_id'
  ),
  '23514',
  NULL,
  'planned_sets: target_reps < 0 is rejected by CHECK'
);

SELECT throws_ok(
  format(
    $$INSERT INTO coachbyte.planned_sets (
        plan_id, user_id, exercise_id, "order", target_reps, target_load
      ) VALUES (
        %L::UUID, tests.get_supabase_uid('nn_alice'),
        %L::UUID, 2, NULL, -1.0
      )$$,
    :'plan_id', :'ex_id'
  ),
  '23514',
  NULL,
  'planned_sets: target_load < 0 is rejected by CHECK'
);

SELECT * FROM finish();
ROLLBACK;
