BEGIN;
SELECT plan(12);

-- Setup: create two users and activate chefbyte for both
SELECT tests.create_supabase_user('prod_owner');
SELECT tests.create_supabase_user('prod_intruder');

SELECT tests.authenticate_as('prod_owner');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('prod_intruder');
SELECT hub.activate_app('chefbyte');

------------------------------------------------------------
-- User A: basic CRUD on own products
------------------------------------------------------------
SELECT tests.authenticate_as('prod_owner');

-- Test 1: User A can INSERT own product (with barcode)
SELECT lives_ok(
  $$ INSERT INTO chefbyte.products (user_id, name, barcode, calories_per_serving, protein_per_serving)
     VALUES (tests.get_supabase_uid('prod_owner'), 'Chicken Breast', '1234567890', 165, 31) $$,
  'User A can insert own product'
);

-- Test 2: User A can SELECT own product
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('prod_owner') AND name = 'Chicken Breast'),
  1,
  'User A can select own product'
);

-- Test 3: User A can UPDATE own product
UPDATE chefbyte.products SET name = 'Chicken Breast (Grilled)'
  WHERE user_id = tests.get_supabase_uid('prod_owner') AND name = 'Chicken Breast';
SELECT is(
  (SELECT name FROM chefbyte.products WHERE user_id = tests.get_supabase_uid('prod_owner')),
  'Chicken Breast (Grilled)',
  'User A can update own product'
);

------------------------------------------------------------
-- User B: cross-user isolation
------------------------------------------------------------
SELECT tests.authenticate_as('prod_intruder');

-- Test 4: User B CANNOT SELECT User A's product (RLS isolation)
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('prod_owner')),
  0,
  'User B cannot select User A products (RLS isolation)'
);

-- Test 5: User B cannot UPDATE User A's product
UPDATE chefbyte.products SET name = 'HACKED'
  WHERE user_id = tests.get_supabase_uid('prod_owner');
SELECT tests.authenticate_as('prod_owner');
SELECT is(
  (SELECT name FROM chefbyte.products WHERE user_id = tests.get_supabase_uid('prod_owner')),
  'Chicken Breast (Grilled)',
  'User B cannot update User A product (value unchanged)'
);

------------------------------------------------------------
-- Barcode uniqueness: per-user partial unique index
------------------------------------------------------------

-- Test 6: Same barcode for different users is OK
SELECT tests.authenticate_as('prod_intruder');
SELECT lives_ok(
  $$ INSERT INTO chefbyte.products (user_id, name, barcode)
     VALUES (tests.get_supabase_uid('prod_intruder'), 'Different Chicken', '1234567890') $$,
  'Same barcode for different users is allowed'
);

-- Test 7: Same barcode for same user FAILS (unique constraint)
SELECT throws_ok(
  $$ INSERT INTO chefbyte.products (user_id, name, barcode)
     VALUES (tests.get_supabase_uid('prod_intruder'), 'Duplicate Barcode', '1234567890') $$,
  '23505',
  NULL,
  'Same barcode for same user rejected (unique constraint)'
);

-- Test 8: NULL barcode does not conflict with another NULL barcode
SELECT tests.authenticate_as('prod_owner');
SELECT lives_ok(
  $$ INSERT INTO chefbyte.products (user_id, name)
     VALUES (tests.get_supabase_uid('prod_owner'), 'No Barcode Item 1') $$,
  'First NULL-barcode product succeeds'
);
SELECT lives_ok(
  $$ INSERT INTO chefbyte.products (user_id, name)
     VALUES (tests.get_supabase_uid('prod_owner'), 'No Barcode Item 2') $$,
  'Second NULL-barcode product succeeds (no conflict with NULL)'
);

------------------------------------------------------------
-- User A: DELETE own product
------------------------------------------------------------

-- Test 10: User A can DELETE own product
DELETE FROM chefbyte.products
  WHERE user_id = tests.get_supabase_uid('prod_owner') AND name = 'No Barcode Item 2';
SELECT is(
  (SELECT count(*)::integer FROM chefbyte.products
    WHERE user_id = tests.get_supabase_uid('prod_owner') AND name = 'No Barcode Item 2'),
  0,
  'User A can delete own product'
);

------------------------------------------------------------
-- INSERT requires user_id = auth.uid()
------------------------------------------------------------

-- Test 11: INSERT with wrong user_id fails (RLS WITH CHECK)
SELECT tests.authenticate_as('prod_owner');
SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.products (user_id, name) VALUES (%L, ''Stolen Product'')',
    tests.get_supabase_uid('prod_intruder')
  ),
  '42501',
  NULL,
  'INSERT with wrong user_id fails (RLS WITH CHECK)'
);

------------------------------------------------------------
-- Anon: no access
------------------------------------------------------------
SELECT tests.clear_authentication();

-- Test 12: Anon cannot access products
SELECT throws_ok(
  $$ SELECT * FROM chefbyte.products $$,
  '42501',
  NULL,
  'Anon cannot access products'
);

------------------------------------------------------------
-- Cleanup
------------------------------------------------------------
SELECT tests.authenticate_as('prod_owner');
SELECT tests.delete_supabase_user('prod_owner');
SELECT tests.delete_supabase_user('prod_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
