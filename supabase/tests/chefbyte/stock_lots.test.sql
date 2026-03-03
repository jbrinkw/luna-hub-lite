BEGIN;
SELECT plan(12);

-- Setup: create users, activate chefbyte, create product + get a location
SELECT tests.create_supabase_user('lot_owner');
SELECT tests.create_supabase_user('lot_intruder');

SELECT tests.authenticate_as('lot_owner');
SELECT hub.activate_app('chefbyte');

SELECT tests.authenticate_as('lot_intruder');
SELECT hub.activate_app('chefbyte');

-- Create a product for lot_owner
SELECT tests.authenticate_as('lot_owner');
INSERT INTO chefbyte.products (user_id, name)
VALUES (tests.get_supabase_uid('lot_owner'), 'Test Milk');

-- Grab IDs for use in tests
SELECT product_id FROM chefbyte.products
  WHERE user_id = tests.get_supabase_uid('lot_owner') AND name = 'Test Milk' \gset

SELECT location_id AS fridge_id FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('lot_owner') AND name = 'Fridge' \gset

SELECT location_id AS pantry_id FROM chefbyte.locations
  WHERE user_id = tests.get_supabase_uid('lot_owner') AND name = 'Pantry' \gset

------------------------------------------------------------
-- Basic lot CRUD
------------------------------------------------------------

-- Test 1: User can insert lot with location + product + expiry
SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
     VALUES (%L, %L, %L, 2, ''2026-04-15'')',
    tests.get_supabase_uid('lot_owner'), :'product_id', :'fridge_id'
  ),
  'User can insert stock lot with product, location, and expiry'
);

-- Test 2: Lot merge key violation — same (product, location, expiry) fails
SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
     VALUES (%L, %L, %L, 1, ''2026-04-15'')',
    tests.get_supabase_uid('lot_owner'), :'product_id', :'fridge_id'
  ),
  '23505',
  NULL,
  'Duplicate merge key (same product+location+expiry) rejected'
);

-- Test 3: Different expiry creates separate lot — succeeds
SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
     VALUES (%L, %L, %L, 1, ''2026-05-01'')',
    tests.get_supabase_uid('lot_owner'), :'product_id', :'fridge_id'
  ),
  'Different expiry creates separate lot'
);

-- Test 4: Different location creates separate lot — succeeds
SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers, expires_on)
     VALUES (%L, %L, %L, 3, ''2026-04-15'')',
    tests.get_supabase_uid('lot_owner'), :'product_id', :'pantry_id'
  ),
  'Different location creates separate lot'
);

------------------------------------------------------------
-- NULL expiry merge key behavior
------------------------------------------------------------

-- Test 5: NULL expiry lot allowed
SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
     VALUES (%L, %L, %L, 5)',
    tests.get_supabase_uid('lot_owner'), :'product_id', :'fridge_id'
  ),
  'NULL expiry lot allowed (COALESCE sentinel bucket)'
);

-- Test 6: Two lots with NULL expiry for same product+location → unique violation
SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
     VALUES (%L, %L, %L, 2)',
    tests.get_supabase_uid('lot_owner'), :'product_id', :'fridge_id'
  ),
  '23505',
  NULL,
  'Two NULL-expiry lots for same product+location rejected (COALESCE sentinel)'
);

------------------------------------------------------------
-- RLS isolation
------------------------------------------------------------

-- Test 7: User B cannot see User A's lots
SELECT tests.authenticate_as('lot_intruder');
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lot_owner')),
  0,
  'User B cannot see User A stock lots (RLS isolation)'
);

-- Test 8: User B cannot update User A's lots
UPDATE chefbyte.stock_lots SET qty_containers = 999
  WHERE user_id = tests.get_supabase_uid('lot_owner');
SELECT tests.authenticate_as('lot_owner');
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM chefbyte.stock_lots
      WHERE user_id = tests.get_supabase_uid('lot_owner') AND qty_containers = 999
  ),
  'User B cannot update User A stock lots (no rows changed)'
);

------------------------------------------------------------
-- User A: update + delete own lot
------------------------------------------------------------

-- Test 9: User can update own lot qty_containers
UPDATE chefbyte.stock_lots SET qty_containers = 10
  WHERE user_id = tests.get_supabase_uid('lot_owner')
    AND product_id = :'product_id'
    AND location_id = :'fridge_id'
    AND expires_on = '2026-04-15';
SELECT is(
  (SELECT qty_containers FROM chefbyte.stock_lots
    WHERE user_id = tests.get_supabase_uid('lot_owner')
      AND product_id = :'product_id'
      AND location_id = :'fridge_id'
      AND expires_on = '2026-04-15'),
  10::numeric,
  'User can update own lot qty_containers'
);

-- Test 10: User can delete own lot
DELETE FROM chefbyte.stock_lots
  WHERE user_id = tests.get_supabase_uid('lot_owner')
    AND product_id = :'product_id'
    AND location_id = :'fridge_id'
    AND expires_on = '2026-05-01';
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM chefbyte.stock_lots
      WHERE user_id = tests.get_supabase_uid('lot_owner')
        AND product_id = :'product_id'
        AND location_id = :'fridge_id'
        AND expires_on = '2026-05-01'
  ),
  'User can delete own lot'
);

------------------------------------------------------------
-- INSERT requires user_id = auth.uid()
------------------------------------------------------------

-- Test 11: INSERT with wrong user_id fails (RLS)
SELECT tests.authenticate_as('lot_owner');
SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.stock_lots (user_id, product_id, location_id, qty_containers)
     VALUES (%L, %L, %L, 1)',
    tests.get_supabase_uid('lot_intruder'), :'product_id', :'fridge_id'
  ),
  '42501',
  NULL,
  'INSERT with wrong user_id fails (RLS WITH CHECK)'
);

------------------------------------------------------------
-- Anon: no access
------------------------------------------------------------
SELECT tests.clear_authentication();

-- Test 12: Anon cannot access stock_lots
SELECT throws_ok(
  $$ SELECT * FROM chefbyte.stock_lots $$,
  '42501',
  NULL,
  'Anon cannot access stock lots'
);

------------------------------------------------------------
-- Cleanup
------------------------------------------------------------
SELECT tests.authenticate_as('lot_owner');
SELECT tests.delete_supabase_user('lot_owner');
SELECT tests.delete_supabase_user('lot_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
