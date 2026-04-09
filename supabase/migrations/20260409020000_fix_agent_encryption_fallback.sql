-- Fix agent settings encryption functions to use missing_ok fallback
-- and extensions.pgp_sym_encrypt/decrypt (schema-qualified).
-- Matches the pattern from extension credentials (migration 20260304070000).

CREATE OR REPLACE FUNCTION hub.save_agent_anthropic_key(
  p_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enc_key TEXT;
  v_uid UUID;
BEGIN
  v_uid := (SELECT auth.uid());
  v_enc_key := coalesce(
    nullif(current_setting('app.settings.encryption_key', true), ''),
    'local-dev-fallback-key'
  );

  INSERT INTO hub.agent_settings (user_id, anthropic_key_encrypted)
  VALUES (v_uid, extensions.pgp_sym_encrypt(p_key, v_enc_key))
  ON CONFLICT (user_id)
  DO UPDATE SET
    anthropic_key_encrypted = extensions.pgp_sym_encrypt(p_key, v_enc_key),
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION hub.get_agent_anthropic_key_admin(
  p_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enc_key TEXT;
  v_encrypted TEXT;
BEGIN
  v_enc_key := coalesce(
    nullif(current_setting('app.settings.encryption_key', true), ''),
    'local-dev-fallback-key'
  );

  SELECT anthropic_key_encrypted INTO v_encrypted
  FROM hub.agent_settings
  WHERE user_id = p_user_id;

  IF v_encrypted IS NULL THEN RETURN NULL; END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted::bytea, v_enc_key);
END;
$$;
