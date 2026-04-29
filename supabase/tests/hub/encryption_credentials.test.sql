BEGIN;
SELECT plan(10);

-- Post-Vault migration (20260429160000_extension_credentials_vault.sql):
-- credentials are stored via vault.create_secret / vault.update_secret
-- and read back via vault.decrypted_secrets. The legacy
-- app.settings.encryption_key (used by pgcrypto) is no longer
-- consulted. Vault keying is managed by Supabase's pgsodium root key.

-- Setup: create two test users
SELECT tests.create_supabase_user('cred_owner');
SELECT tests.create_supabase_user('cred_intruder');

--------------------------------------------------------------
-- Test 1: save + get credentials round-trip (service_role)
--------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT private.save_extension_credentials(
       tests.get_supabase_uid('cred_owner'),
       'obsidian',
       '{"vault_path":"/notes","token":"secret123"}'
     ) $$,
  'save_extension_credentials succeeds for valid user'
);

SELECT is(
  (SELECT private.get_extension_credentials(
    tests.get_supabase_uid('cred_owner'),
    'obsidian'
  )),
  '{"vault_path":"/notes","token":"secret123"}',
  'get_extension_credentials returns original JSON after decryption'
);

--------------------------------------------------------------
-- Test 2: credentials are stored as a vault pointer, not in the row
--------------------------------------------------------------
-- Post-Vault: hub.extension_settings.vault_secret_id is a UUID
-- pointer into vault.secrets. The plaintext can never appear in this
-- row by construction (the legacy credentials_encrypted column was
-- dropped in 20260429160000_extension_credentials_vault.sql).
SELECT matches(
  (SELECT vault_secret_id::text FROM hub.extension_settings
   WHERE user_id = tests.get_supabase_uid('cred_owner')
     AND extension_name = 'obsidian'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'Stored credentials reference a vault.secrets UUID, not plaintext'
);

--------------------------------------------------------------
-- Test 3: hub.save/get wrappers work for authenticated user
--------------------------------------------------------------
SELECT tests.authenticate_as('cred_owner');

SELECT lives_ok(
  $$ SELECT hub.save_extension_credentials(
       'todoist',
       '{"api_token":"td_abc123"}'
     ) $$,
  'hub.save_extension_credentials works for authenticated user'
);

SELECT is(
  (SELECT hub.get_extension_credentials('todoist')),
  '{"api_token":"td_abc123"}',
  'hub.get_extension_credentials decrypts for authenticated user'
);

--------------------------------------------------------------
-- Test 4: Cross-user isolation — user B cannot read user A creds
--------------------------------------------------------------
SELECT tests.authenticate_as('cred_intruder');

SELECT is(
  (SELECT hub.get_extension_credentials('obsidian')),
  NULL,
  'User B gets NULL when trying to read User A obsidian credentials'
);

SELECT is(
  (SELECT hub.get_extension_credentials('todoist')),
  NULL,
  'User B gets NULL when trying to read User A todoist credentials'
);

--------------------------------------------------------------
-- Test 5: get_extension_credentials_admin works (service_role)
--------------------------------------------------------------
SELECT tests.clear_authentication();

-- Capture uid before switching to service_role (which lacks tests schema access)
SELECT tests.get_supabase_uid('cred_owner') AS _owner_uid \gset

SET ROLE service_role;

SELECT is(
  (SELECT hub.get_extension_credentials_admin(
    :'_owner_uid'::uuid,
    'obsidian'
  )),
  '{"vault_path":"/notes","token":"secret123"}',
  'get_extension_credentials_admin decrypts for service_role'
);

-- Reset back to postgres for remaining tests
SET ROLE postgres;

--------------------------------------------------------------
-- Test 6: upsert overwrites existing credentials
--------------------------------------------------------------
SELECT lives_ok(
  $$ SELECT private.save_extension_credentials(
       tests.get_supabase_uid('cred_owner'),
       'obsidian',
       '{"vault_path":"/new-path","token":"updated"}'
     ) $$,
  'save_extension_credentials upserts (overwrites) existing'
);

SELECT is(
  (SELECT private.get_extension_credentials(
    tests.get_supabase_uid('cred_owner'),
    'obsidian'
  )),
  '{"vault_path":"/new-path","token":"updated"}',
  'get returns updated credentials after upsert'
);

-- Cleanup
SELECT tests.delete_supabase_user('cred_owner');
SELECT tests.delete_supabase_user('cred_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
