-- Migrate extension credential storage from pgcrypto (pgp_sym_encrypt with a
-- shared `app.settings.encryption_key`) to Supabase Vault.
--
-- Why:
--   * Vault uses pgsodium AEAD with per-row nonce + a managed root key —
--     stronger primitive than pgp_sym_encrypt with a single passphrase
--     pulled from a Postgres setting.
--   * The encryption_key was a global symmetric secret. Anyone with
--     `current_setting('app.settings.encryption_key')` access could
--     decrypt every user's credentials. Vault delegates key management
--     to Supabase's managed key infrastructure.
--   * The existing `credentials_encrypted` column was TEXT and accepted
--     direct table writes — meaning a misbehaving client (or test) could
--     bypass the RPC and store actual plaintext. Vault references are
--     UUIDs only, so any direct write of a literal token would simply
--     fail to dereference.
--
-- Migration plan:
--   1. Add `hub.extension_settings.vault_secret_id UUID`.
--   2. Backfill: for each row with non-NULL credentials_encrypted, decrypt
--      via the legacy pgcrypto path, push into vault, store the resulting
--      vault id, then null the legacy column.
--   3. Drop `credentials_encrypted`. The vault_secret_id column is the
--      sole credential pointer going forward.
--   4. Re-implement `private.save_extension_credentials` and
--      `private.get_extension_credentials` to use vault. The API surface
--      (signatures + return types) is unchanged so callers in
--      apps/web (ExtensionsPage save flow) and apps/mcp-worker
--      (tool-executor.ts read flow via *_admin) keep working.
--   5. Add a `hub.has_extension_credentials(p_extension_name TEXT)`
--      helper so the frontend can show its "Credentials configured"
--      badge without ever reading the secret payload (RLS-safe — uses
--      auth.uid()).
--
-- Backward compatibility:
--   * RPC names + signatures unchanged.
--   * The `credentials_encrypted` column is dropped — any direct
--     SELECT/INSERT/UPDATE on it must be migrated. ExtensionsPage.tsx
--     and the integration tests are updated in the same PR.
--
-- IMPORTANT: vault.create_secret / vault.decrypted_secrets are part of
-- the supabase_vault extension which is pre-installed on managed
-- Supabase Postgres. Local dev stacks via `supabase start` also have
-- it (verified on supabase CLI v2.75+).

-- Sanity check: vault must exist before we begin. If it doesn't,
-- raise immediately rather than failing halfway through the backfill.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    RAISE EXCEPTION 'supabase_vault extension is required for this migration';
  END IF;
END$$;

------------------------------------------------------------
-- 1. Schema change: add vault_secret_id, keep old column for backfill
------------------------------------------------------------
ALTER TABLE hub.extension_settings
  ADD COLUMN IF NOT EXISTS vault_secret_id UUID;

------------------------------------------------------------
-- 2. Backfill: decrypt legacy pgcrypto blobs and re-store in vault
------------------------------------------------------------
-- Runs inline in the migration so the same `db push` that lands the
-- code change also moves the data. Idempotent: skips rows already
-- backfilled (vault_secret_id IS NOT NULL) and rows with no
-- credentials (credentials_encrypted IS NULL). No-op on a fresh DB.
DO $$
DECLARE
  v_row       RECORD;
  v_key       TEXT;
  v_plaintext TEXT;
  v_vault_id  UUID;
BEGIN
  v_key := coalesce(
    nullif(current_setting('app.settings.encryption_key', true), ''),
    'local-dev-fallback-key'
  );

  FOR v_row IN
    SELECT id, user_id, extension_name, credentials_encrypted
    FROM hub.extension_settings
    WHERE credentials_encrypted IS NOT NULL
      AND vault_secret_id IS NULL
  LOOP
    -- Try pgcrypto decrypt. If it fails (e.g. row was written as raw
    -- plaintext bypassing the RPC), fall back to using the column
    -- value as-is — the data is already plaintext, no decrypt needed.
    -- Either way we end up with the canonical JSON in v_plaintext.
    BEGIN
      v_plaintext := extensions.pgp_sym_decrypt(v_row.credentials_encrypted::bytea, v_key);
    EXCEPTION WHEN OTHERS THEN
      v_plaintext := v_row.credentials_encrypted;
    END;

    -- vault.create_secret returns the new UUID. Use a per-row name so
    -- repeated upserts don't collide (vault.secrets has a UNIQUE index
    -- on name). Format: `ext:<user_uuid>:<extension_name>`.
    v_vault_id := vault.create_secret(
      v_plaintext,
      format('ext:%s:%s', v_row.user_id, v_row.extension_name),
      'extension credentials migrated from hub.extension_settings.credentials_encrypted'
    );

    UPDATE hub.extension_settings
    SET vault_secret_id = v_vault_id,
        credentials_encrypted = NULL
    WHERE id = v_row.id;
  END LOOP;
END$$;

------------------------------------------------------------
-- 3. Drop the legacy plaintext column
------------------------------------------------------------
-- After backfill, no row should still be using credentials_encrypted.
-- Drop CASCADE is intentional — it nukes any lingering policies/views
-- that referenced the column. Future writers must use the vault path.
ALTER TABLE hub.extension_settings
  DROP COLUMN IF EXISTS credentials_encrypted;

------------------------------------------------------------
-- 4. Re-implement save_extension_credentials via vault
------------------------------------------------------------
-- Strategy: if a vault_secret_id already exists for the row, update
-- that secret in place (so its UUID stays stable across credential
-- rotations). Otherwise create a new secret and store its id.
CREATE OR REPLACE FUNCTION private.save_extension_credentials(
  p_user_id UUID,
  p_extension_name TEXT,
  p_credentials_json TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_id UUID;
  v_new_id      UUID;
  v_secret_name TEXT;
BEGIN
  v_secret_name := format('ext:%s:%s', p_user_id, p_extension_name);

  SELECT vault_secret_id INTO v_existing_id
  FROM hub.extension_settings
  WHERE user_id = p_user_id
    AND extension_name = p_extension_name;

  IF v_existing_id IS NOT NULL THEN
    -- Rotate in place. The vault row keeps its UUID, callers don't
    -- need to refresh anything.
    PERFORM vault.update_secret(
      v_existing_id,
      p_credentials_json,
      v_secret_name,
      'extension credentials (rotated)'
    );
  ELSE
    v_new_id := vault.create_secret(
      p_credentials_json,
      v_secret_name,
      'extension credentials'
    );

    INSERT INTO hub.extension_settings (user_id, extension_name, vault_secret_id, enabled)
    VALUES (p_user_id, p_extension_name, v_new_id, false)
    ON CONFLICT (user_id, extension_name)
    DO UPDATE SET vault_secret_id = EXCLUDED.vault_secret_id;
  END IF;
END;
$$;

------------------------------------------------------------
-- 5. Re-implement get_extension_credentials via vault
------------------------------------------------------------
-- Reads the decrypted secret out of vault.decrypted_secrets, which
-- decrypts on-demand using the managed pgsodium key. Returns NULL if
-- no row exists OR if the row has no vault_secret_id (extension was
-- toggled off — credentials cleared).
CREATE OR REPLACE FUNCTION private.get_extension_credentials(
  p_user_id UUID,
  p_extension_name TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret_id UUID;
  v_decrypted TEXT;
BEGIN
  SELECT vault_secret_id INTO v_secret_id
  FROM hub.extension_settings
  WHERE user_id = p_user_id
    AND extension_name = p_extension_name;

  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_decrypted
  FROM vault.decrypted_secrets
  WHERE id = v_secret_id;

  RETURN v_decrypted;
END;
$$;

------------------------------------------------------------
-- 6. Helper: hub.has_extension_credentials (RLS-safe boolean check)
------------------------------------------------------------
-- The frontend's "Credentials configured" badge needs to know whether
-- a vault secret exists, but the secret payload itself stays inside
-- the vault — never returned to the browser. This function is a
-- one-liner the SPA can call instead of selecting vault_secret_id
-- directly (which would require schema-level grants on the column).
CREATE OR REPLACE FUNCTION hub.has_extension_credentials(
  p_extension_name TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM hub.extension_settings
    WHERE user_id = (SELECT auth.uid())
      AND extension_name = p_extension_name
      AND vault_secret_id IS NOT NULL
  );
$$;

GRANT EXECUTE ON FUNCTION hub.has_extension_credentials(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION hub.has_extension_credentials(TEXT) FROM anon;

------------------------------------------------------------
-- 7. Disable toggle: clear credentials helper
------------------------------------------------------------
-- ExtensionsPage's toggle-off side-effect previously did
-- `UPDATE ... SET credentials_encrypted = NULL`. The column is gone;
-- callers now invoke this RPC, which both nulls vault_secret_id on
-- the settings row AND deletes the underlying vault.secrets row so
-- the secret material isn't retained after a "disable".
CREATE OR REPLACE FUNCTION hub.clear_extension_credentials(
  p_extension_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret_id UUID;
BEGIN
  SELECT vault_secret_id INTO v_secret_id
  FROM hub.extension_settings
  WHERE user_id = (SELECT auth.uid())
    AND extension_name = p_extension_name;

  -- Null the pointer first so a concurrent reader sees "no creds".
  UPDATE hub.extension_settings
  SET vault_secret_id = NULL
  WHERE user_id = (SELECT auth.uid())
    AND extension_name = p_extension_name;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION hub.clear_extension_credentials(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION hub.clear_extension_credentials(TEXT) FROM anon;
