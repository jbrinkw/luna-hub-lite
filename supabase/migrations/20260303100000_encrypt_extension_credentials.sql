-- Encrypt extension credentials at rest using pgcrypto
-- Adds private.save_extension_credentials and private.get_extension_credentials RPCs
-- Plus hub-schema wrappers for frontend and service-role access

-- Enable pgcrypto (idempotent)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

------------------------------------------------------------
-- PRIVATE: save_extension_credentials
------------------------------------------------------------
-- Encrypts credentials JSON with pgp_sym_encrypt and upserts into
-- hub.extension_settings. The encryption key is read from the
-- database-level setting app.settings.encryption_key (set via
-- ALTER DATABASE ... SET app.settings.encryption_key = '...').

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
  v_key TEXT;
BEGIN
  v_key := current_setting('app.settings.encryption_key');

  INSERT INTO hub.extension_settings (user_id, extension_name, credentials_encrypted, enabled)
  VALUES (
    p_user_id,
    p_extension_name,
    pgp_sym_encrypt(p_credentials_json, v_key),
    false
  )
  ON CONFLICT (user_id, extension_name)
  DO UPDATE SET credentials_encrypted = pgp_sym_encrypt(p_credentials_json, v_key);
END;
$$;

------------------------------------------------------------
-- PRIVATE: get_extension_credentials
------------------------------------------------------------
-- Decrypts and returns the credentials JSON for a given extension.
-- Returns NULL if no credentials are stored.

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
  v_key TEXT;
  v_encrypted TEXT;
BEGIN
  v_key := current_setting('app.settings.encryption_key');

  SELECT credentials_encrypted INTO v_encrypted
  FROM hub.extension_settings
  WHERE user_id = p_user_id
    AND extension_name = p_extension_name;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN pgp_sym_decrypt(v_encrypted::bytea, v_key);
END;
$$;

------------------------------------------------------------
-- Hub-schema wrapper for authenticated frontend users
------------------------------------------------------------
-- These use auth.uid() so the frontend can call them directly.

CREATE OR REPLACE FUNCTION hub.save_extension_credentials(
  p_extension_name TEXT,
  p_credentials_json TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.save_extension_credentials(
    (SELECT auth.uid()),
    p_extension_name,
    p_credentials_json
  );
$$;

GRANT EXECUTE ON FUNCTION hub.save_extension_credentials(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION hub.get_extension_credentials(
  p_extension_name TEXT
)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.get_extension_credentials(
    (SELECT auth.uid()),
    p_extension_name
  );
$$;

GRANT EXECUTE ON FUNCTION hub.get_extension_credentials(TEXT) TO authenticated;

------------------------------------------------------------
-- Service-role wrapper for MCP Worker
------------------------------------------------------------
-- The MCP Worker uses service_role key so auth.uid() is NULL.
-- It passes the user_id explicitly.

CREATE OR REPLACE FUNCTION hub.get_extension_credentials_admin(
  p_user_id UUID,
  p_extension_name TEXT
)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.get_extension_credentials(p_user_id, p_extension_name);
$$;

GRANT EXECUTE ON FUNCTION hub.get_extension_credentials_admin(UUID, TEXT) TO service_role;
