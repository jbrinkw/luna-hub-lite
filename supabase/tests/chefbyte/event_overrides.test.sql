BEGIN;
SELECT plan(10);

-- Table-level tests for chefbyte.event_overrides: RLS isolation, unique
-- (user_id, client_event_id), default column values.

SELECT tests.create_supabase_user('eo_owner');
SELECT tests.create_supabase_user('eo_intruder');

SELECT tests.authenticate_as('eo_owner');
SELECT hub.activate_app('chefbyte');
SELECT tests.authenticate_as('eo_intruder');
SELECT hub.activate_app('chefbyte');

------------------------------------------------------------
-- Test 1: owner can insert override row
------------------------------------------------------------

SELECT tests.authenticate_as('eo_owner');

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.event_overrides (user_id, client_event_id)
     VALUES (%L, ''evt-owner-1'')',
    tests.get_supabase_uid('eo_owner')
  ),
  'owner can insert override row for themselves'
);

------------------------------------------------------------
-- Test 2: default macro_logging_enabled=true, is_voided=false
------------------------------------------------------------

SELECT is(
  (SELECT macro_logging_enabled FROM chefbyte.event_overrides
    WHERE user_id = tests.get_supabase_uid('eo_owner')
      AND client_event_id = 'evt-owner-1'),
  TRUE,
  'macro_logging_enabled defaults to TRUE'
);

SELECT is(
  (SELECT is_voided FROM chefbyte.event_overrides
    WHERE user_id = tests.get_supabase_uid('eo_owner')
      AND client_event_id = 'evt-owner-1'),
  FALSE,
  'is_voided defaults to FALSE'
);

------------------------------------------------------------
-- Test 3: unique (user_id, client_event_id) constraint
------------------------------------------------------------

SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.event_overrides (user_id, client_event_id)
     VALUES (%L, ''evt-owner-1'')',
    tests.get_supabase_uid('eo_owner')
  ),
  '23505',
  NULL,
  'duplicate (user_id, client_event_id) rejected'
);

------------------------------------------------------------
-- Test 4: owner cannot insert override for another user (RLS)
------------------------------------------------------------

SELECT throws_ok(
  format(
    'INSERT INTO chefbyte.event_overrides (user_id, client_event_id)
     VALUES (%L, ''evt-intruder-1'')',
    tests.get_supabase_uid('eo_intruder')
  ),
  '42501',
  NULL,
  'RLS blocks insert with another user_id'
);

------------------------------------------------------------
-- Test 5: intruder cannot see owner's override (RLS select)
------------------------------------------------------------

SELECT tests.authenticate_as('eo_intruder');

SELECT is(
  (SELECT COUNT(*)::int FROM chefbyte.event_overrides
    WHERE client_event_id = 'evt-owner-1'),
  0,
  'RLS blocks intruder from selecting owner override'
);

------------------------------------------------------------
-- Test 6: intruder cannot update owner's override (RLS update)
------------------------------------------------------------

-- UPDATE doesn't raise when RLS filters out all rows — it reports 0
-- rows affected. Assert that via a re-select as the owner.
UPDATE chefbyte.event_overrides
   SET is_voided = TRUE
 WHERE client_event_id = 'evt-owner-1';

SELECT tests.authenticate_as('eo_owner');

SELECT is(
  (SELECT is_voided FROM chefbyte.event_overrides
    WHERE user_id = tests.get_supabase_uid('eo_owner')
      AND client_event_id = 'evt-owner-1'),
  FALSE,
  'RLS blocks intruder UPDATE of owner override (is_voided still FALSE)'
);

------------------------------------------------------------
-- Test 7: owner can update their own override
------------------------------------------------------------

UPDATE chefbyte.event_overrides
   SET macro_logging_enabled = FALSE, is_voided = TRUE
 WHERE user_id = tests.get_supabase_uid('eo_owner')
   AND client_event_id = 'evt-owner-1';

SELECT is(
  (SELECT is_voided FROM chefbyte.event_overrides
    WHERE user_id = tests.get_supabase_uid('eo_owner')
      AND client_event_id = 'evt-owner-1'),
  TRUE,
  'owner can update own override row'
);

------------------------------------------------------------
-- Test 8: pi_event_id column exists on shelf_event_log and is nullable
------------------------------------------------------------

SELECT col_is_null(
  'chefbyte'::name, 'shelf_event_log'::name, 'pi_event_id'::name,
  'pi_event_id column is nullable'
);

------------------------------------------------------------
-- Test 9: same client_event_id across different users is allowed
------------------------------------------------------------

SELECT tests.authenticate_as('eo_intruder');

SELECT lives_ok(
  format(
    'INSERT INTO chefbyte.event_overrides (user_id, client_event_id)
     VALUES (%L, ''evt-owner-1'')',
    tests.get_supabase_uid('eo_intruder')
  ),
  'different users can reuse same client_event_id'
);

SELECT finish();
ROLLBACK;
