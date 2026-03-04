-- Fix encryption functions to use current_setting with missing_ok = true
-- and fall back to a default dev key when app.settings.encryption_key is not set.
-- In production, the encryption key should be set via:
--   ALTER DATABASE postgres SET app.settings.encryption_key = 'your-secret-key';

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
  v_key := coalesce(
    nullif(current_setting('app.settings.encryption_key', true), ''),
    'local-dev-fallback-key'
  );

  INSERT INTO hub.extension_settings (user_id, extension_name, credentials_encrypted, enabled)
  VALUES (
    p_user_id,
    p_extension_name,
    extensions.pgp_sym_encrypt(p_credentials_json, v_key),
    false
  )
  ON CONFLICT (user_id, extension_name)
  DO UPDATE SET credentials_encrypted = extensions.pgp_sym_encrypt(p_credentials_json, v_key);
END;
$$;

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
  v_key := coalesce(
    nullif(current_setting('app.settings.encryption_key', true), ''),
    'local-dev-fallback-key'
  );

  SELECT credentials_encrypted INTO v_encrypted
  FROM hub.extension_settings
  WHERE user_id = p_user_id
    AND extension_name = p_extension_name;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted::bytea, v_key);
END;
$$;
