-- Agent settings: Anthropic API key (encrypted) + custom system prompt
-- Reuses the same pgcrypto vault pattern as extension credentials

CREATE TABLE hub.agent_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  anthropic_key_encrypted TEXT,
  system_prompt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hub.agent_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own agent settings"
  ON hub.agent_settings FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own agent settings"
  ON hub.agent_settings FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own agent settings"
  ON hub.agent_settings FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

------------------------------------------------------------
-- Save Anthropic key (encrypted)
------------------------------------------------------------
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
  v_enc_key := current_setting('app.settings.encryption_key');

  INSERT INTO hub.agent_settings (user_id, anthropic_key_encrypted)
  VALUES (v_uid, pgp_sym_encrypt(p_key, v_enc_key))
  ON CONFLICT (user_id)
  DO UPDATE SET
    anthropic_key_encrypted = pgp_sym_encrypt(p_key, v_enc_key),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION hub.save_agent_anthropic_key(TEXT) TO authenticated;

------------------------------------------------------------
-- Save system prompt (plain text, no encryption needed)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.save_agent_system_prompt(
  p_prompt TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO hub.agent_settings (user_id, system_prompt)
  VALUES ((SELECT auth.uid()), p_prompt)
  ON CONFLICT (user_id)
  DO UPDATE SET system_prompt = p_prompt, updated_at = now();
$$;

GRANT EXECUTE ON FUNCTION hub.save_agent_system_prompt(TEXT) TO authenticated;

------------------------------------------------------------
-- Service-role: get decrypted Anthropic key (for MCP Worker)
------------------------------------------------------------
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
  v_enc_key := current_setting('app.settings.encryption_key');

  SELECT anthropic_key_encrypted INTO v_encrypted
  FROM hub.agent_settings
  WHERE user_id = p_user_id;

  IF v_encrypted IS NULL THEN RETURN NULL; END IF;

  RETURN pgp_sym_decrypt(v_encrypted::bytea, v_enc_key);
END;
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_anthropic_key_admin(UUID) TO service_role;

------------------------------------------------------------
-- Service-role: get system prompt (for MCP Worker)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.get_agent_system_prompt_admin(
  p_user_id UUID
)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT system_prompt FROM hub.agent_settings WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_system_prompt_admin(UUID) TO service_role;

------------------------------------------------------------
-- Clear Anthropic key
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.clear_agent_anthropic_key()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE hub.agent_settings
  SET anthropic_key_encrypted = NULL, updated_at = now()
  WHERE user_id = (SELECT auth.uid());
$$;

GRANT EXECUTE ON FUNCTION hub.clear_agent_anthropic_key() TO authenticated;
