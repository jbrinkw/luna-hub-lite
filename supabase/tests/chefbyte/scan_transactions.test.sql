BEGIN;
SELECT plan(8);

SELECT has_table('chefbyte', 'scan_transactions', 'scan_transactions exists');
SELECT col_is_pk('chefbyte', 'scan_transactions', 'transaction_id', 'transaction_id is PK');
SELECT col_not_null('chefbyte', 'scan_transactions', 'barcode', 'barcode NOT NULL');
SELECT col_not_null('chefbyte', 'scan_transactions', 'mode', 'mode NOT NULL');
SELECT col_not_null('chefbyte', 'scan_transactions', 'status', 'status NOT NULL');
SELECT col_not_null('chefbyte', 'scan_transactions', 'source', 'source NOT NULL');
SELECT has_index(
    'chefbyte', 'scan_transactions', 'scan_transactions_pi_event_id_unique',
    'unique partial index on (user_id, pi_event_id) exists'
);
SELECT policies_are(
    'chefbyte', 'scan_transactions', ARRAY['scan_transactions_self'],
    'scan_transactions has the self-RLS policy'
);

SELECT * FROM finish();
ROLLBACK;
