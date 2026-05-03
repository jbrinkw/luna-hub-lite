BEGIN;
SELECT plan(6);

SELECT has_table('chefbyte', 'scanner_state', 'scanner_state table exists');
SELECT col_is_pk('chefbyte', 'scanner_state', 'user_id', 'user_id is PK');
SELECT col_not_null('chefbyte', 'scanner_state', 'last_active_mode', 'last_active_mode is NOT NULL');
SELECT col_default_is(
    'chefbyte', 'scanner_state', 'last_active_mode', 'purchase'::text,
    'last_active_mode default = purchase'
);
SELECT col_is_null('chefbyte', 'scanner_state', 'locked_mode', 'locked_mode nullable');
SELECT policies_are(
    'chefbyte', 'scanner_state', ARRAY['scanner_state_self'],
    'scanner_state has the self-RLS policy'
);

SELECT * FROM finish();
ROLLBACK;
