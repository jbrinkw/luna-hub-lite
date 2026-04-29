-- Pin the post-Vault contract for hub.extension_settings credential storage.
--
-- Migration under test:
--   20260429160000_extension_credentials_vault.sql
--
-- Coverage:
--   1. The legacy plaintext column `credentials_encrypted` is dropped.
--   2. The new column `vault_secret_id` exists and is nullable UUID.
--   3. save_extension_credentials creates a vault.secrets row and
--      stores its UUID in vault_secret_id.
--   4. get_extension_credentials returns the original payload via
--      vault.decrypted_secrets.
--   5. The vault.secrets row's `secret` column is NOT the plaintext
--      (pgsodium AEAD-encrypted; verifies vault is doing real work).
--   6. clear_extension_credentials nulls the pointer AND deletes the
--      underlying vault.secrets row (no orphaned secrets after a
--      disable-toggle).
--   7. has_extension_credentials reflects the pointer state correctly.
--   8. RLS isolation: user B's RPC call does not return user A's secret.
--
-- This file complements `encryption_credentials.test.sql` (which keeps
-- pinning the RPC roundtrip + cross-user isolation in a slightly
-- different shape) — neither is redundant: this one is specifically a
-- post-migration contract test.
BEGIN;
SELECT plan(13);

-- Setup
SELECT tests.create_supabase_user('vault_owner');
SELECT tests.create_supabase_user('vault_other');

--------------------------------------------------------------
-- 1 & 2: schema sanity (column drop + add)
--------------------------------------------------------------
SELECT hasnt_column('hub', 'extension_settings', 'credentials_encrypted',
  'Legacy credentials_encrypted column was dropped');

SELECT has_column('hub', 'extension_settings', 'vault_secret_id',
  'New vault_secret_id column exists');

SELECT col_type_is('hub', 'extension_settings', 'vault_secret_id', 'uuid',
  'vault_secret_id is UUID');

--------------------------------------------------------------
-- 3 & 4: save → row carries vault UUID; get returns plaintext
--------------------------------------------------------------
SELECT tests.authenticate_as('vault_owner');

SELECT lives_ok(
  $$ SELECT hub.save_extension_credentials('obsidian', '{"token":"my_secret_42"}') $$,
  'save_extension_credentials succeeds for authenticated user'
);

SELECT matches(
  (SELECT vault_secret_id::text FROM hub.extension_settings
   WHERE extension_name = 'obsidian'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'extension_settings row stores a vault UUID after save'
);

SELECT is(
  (SELECT hub.get_extension_credentials('obsidian')),
  '{"token":"my_secret_42"}',
  'get_extension_credentials returns the original JSON via vault.decrypted_secrets'
);

--------------------------------------------------------------
-- 5: vault.secrets `secret` column is NOT the plaintext
--------------------------------------------------------------
-- Run as service_role: vault.secrets is not exposed to authenticated
-- by default. The encrypted blob there is base64-pgsodium ciphertext
-- and must not contain the substring 'my_secret_42'.
SELECT tests.clear_authentication();
SELECT tests.get_supabase_uid('vault_owner') AS _vo \gset
SET ROLE service_role;

SELECT isnt(
  (SELECT secret FROM vault.secrets
   WHERE id = (SELECT vault_secret_id FROM hub.extension_settings
               WHERE user_id = :'_vo'::uuid AND extension_name = 'obsidian')),
  '{"token":"my_secret_42"}',
  'vault.secrets.secret is encrypted ciphertext, not the original JSON'
);

SET ROLE postgres;

--------------------------------------------------------------
-- 6: clear nulls pointer + deletes underlying secret
--------------------------------------------------------------
SELECT tests.authenticate_as('vault_owner');

-- Capture the secret id before clearing, then verify it's gone after.
SELECT vault_secret_id AS _sid FROM hub.extension_settings
  WHERE extension_name = 'obsidian' \gset

SELECT lives_ok(
  $$ SELECT hub.clear_extension_credentials('obsidian') $$,
  'clear_extension_credentials succeeds'
);

SELECT is(
  (SELECT vault_secret_id FROM hub.extension_settings
   WHERE extension_name = 'obsidian'),
  NULL,
  'vault_secret_id is NULL after clear'
);

-- Confirm the vault row is deleted (run as service_role for visibility)
SET ROLE service_role;
SELECT is(
  (SELECT count(*)::integer FROM vault.secrets WHERE id = :'_sid'::uuid),
  0,
  'underlying vault.secrets row was deleted (no orphan secret)'
);
SET ROLE postgres;

--------------------------------------------------------------
-- 7: has_extension_credentials before / after re-save
--------------------------------------------------------------
SELECT tests.authenticate_as('vault_owner');

SELECT is(
  (SELECT hub.has_extension_credentials('obsidian')),
  false,
  'has_extension_credentials = false after clear'
);

SELECT lives_ok(
  $$ SELECT hub.save_extension_credentials('obsidian', '{"token":"reissued"}') $$,
  're-saving credentials succeeds'
);

--------------------------------------------------------------
-- 8: RLS — user B cannot read user A's secret via the RPC
--------------------------------------------------------------
SELECT tests.authenticate_as('vault_other');

SELECT is(
  (SELECT hub.get_extension_credentials('obsidian')),
  NULL,
  'User B receives NULL when trying to read User A obsidian credentials via RPC'
);

-- Cleanup
SELECT tests.authenticate_as('vault_owner');
SELECT tests.delete_supabase_user('vault_owner');
SELECT tests.delete_supabase_user('vault_other');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
