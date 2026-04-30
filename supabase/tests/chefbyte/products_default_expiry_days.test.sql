-- pgTAP tests for chefbyte.products.default_expiry_days column + CHECK constraint.
--
-- Run: flock /tmp/luna-supabase.lock supabase test db supabase/tests/chefbyte/products_default_expiry_days.test.sql

BEGIN;
SELECT plan(7);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Column exists on the products table
-- ─────────────────────────────────────────────────────────────────────────

SELECT has_column(
  'chefbyte', 'products', 'default_expiry_days',
  'chefbyte.products has default_expiry_days column'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Column type is integer
-- ─────────────────────────────────────────────────────────────────────────

SELECT col_type_is(
  'chefbyte', 'products', 'default_expiry_days', 'integer',
  'default_expiry_days is integer type'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Column is NULLable (existing products must not break)
-- ─────────────────────────────────────────────────────────────────────────

SELECT col_is_null(
  'chefbyte', 'products', 'default_expiry_days',
  'default_expiry_days allows NULL'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Valid value (10) is accepted
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('expiry-valid-user-' || gen_random_uuid()::text);
BEGIN
  INSERT INTO chefbyte.products (user_id, name, default_expiry_days)
  VALUES (v_uid, 'Milk Expiry Test', 10);
END$$;

SELECT results_eq(
  $$SELECT default_expiry_days FROM chefbyte.products
    WHERE name = 'Milk Expiry Test'
    ORDER BY created_at DESC LIMIT 1$$,
  $$VALUES (10)$$,
  'default_expiry_days=10 is stored and retrieved correctly'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. CHECK constraint rejects -1 (below minimum)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('expiry-neg-user-' || gen_random_uuid()::text);
BEGIN NULL; END$$;

SELECT throws_ok(
  $$INSERT INTO chefbyte.products (user_id, name, default_expiry_days)
    SELECT id, 'Negative Expiry Product', -1
    FROM auth.users
    WHERE raw_user_meta_data->>'test_identifier' LIKE 'expiry-neg-user-%'
    LIMIT 1$$,
  23514,
  NULL,
  'default_expiry_days CHECK rejects -1 (below minimum 1)'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. CHECK constraint rejects 1000 (above maximum of 730)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('expiry-over-user-' || gen_random_uuid()::text);
BEGIN NULL; END$$;

SELECT throws_ok(
  $$INSERT INTO chefbyte.products (user_id, name, default_expiry_days)
    SELECT id, 'Over Max Expiry Product', 1000
    FROM auth.users
    WHERE raw_user_meta_data->>'test_identifier' LIKE 'expiry-over-user-%'
    LIMIT 1$$,
  23514,
  NULL,
  'default_expiry_days CHECK rejects 1000 (above maximum 730)'
);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. NULL is accepted (non-perishable / unknown)
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_uid UUID := tests.create_supabase_user('expiry-null-user-' || gen_random_uuid()::text);
BEGIN
  INSERT INTO chefbyte.products (user_id, name, default_expiry_days)
  VALUES (v_uid, 'Null Expiry Product', NULL);
END$$;

SELECT results_eq(
  $$SELECT default_expiry_days FROM chefbyte.products
    WHERE name = 'Null Expiry Product'
    ORDER BY created_at DESC LIMIT 1$$,
  $$VALUES (NULL::INT)$$,
  'default_expiry_days=NULL is accepted and stored correctly'
);

SELECT finish();
ROLLBACK;
