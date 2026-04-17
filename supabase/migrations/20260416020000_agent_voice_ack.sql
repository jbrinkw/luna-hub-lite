-- Voice ACK settings: let users opt-in to a short filler phrase emitted during
-- long tool-execution gaps so Home Assistant Voice Preview TTS has something to
-- speak instead of dead air.

------------------------------------------------------------
-- Columns
------------------------------------------------------------
ALTER TABLE hub.agent_settings
  ADD COLUMN voice_ack_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN voice_ack_text TEXT NOT NULL DEFAULT 'Working on that…',
  ADD COLUMN voice_ack_delay_ms INTEGER NOT NULL DEFAULT 1200
    CHECK (voice_ack_delay_ms BETWEEN 0 AND 5000);

ALTER TABLE hub.agent_settings
  ADD CONSTRAINT voice_ack_text_length CHECK (char_length(voice_ack_text) <= 200);

------------------------------------------------------------
-- User-facing: save voice-ack settings
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.save_agent_voice_ack(
  p_enabled BOOLEAN,
  p_text TEXT,
  p_delay_ms INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_delay_ms < 0 OR p_delay_ms > 5000 THEN
    RAISE EXCEPTION 'voice_ack_delay_ms must be between 0 and 5000';
  END IF;

  IF p_text IS NULL OR char_length(p_text) = 0 THEN
    RAISE EXCEPTION 'voice_ack_text must not be empty';
  END IF;

  IF char_length(p_text) > 200 THEN
    RAISE EXCEPTION 'voice_ack_text must be at most 200 characters';
  END IF;

  INSERT INTO hub.agent_settings (
    user_id, voice_ack_enabled, voice_ack_text, voice_ack_delay_ms
  )
  VALUES (
    (SELECT auth.uid()), p_enabled, p_text, p_delay_ms
  )
  ON CONFLICT (user_id) DO UPDATE SET
    voice_ack_enabled = EXCLUDED.voice_ack_enabled,
    voice_ack_text = EXCLUDED.voice_ack_text,
    voice_ack_delay_ms = EXCLUDED.voice_ack_delay_ms,
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION hub.save_agent_voice_ack(BOOLEAN, TEXT, INTEGER) TO authenticated;

------------------------------------------------------------
-- Service-role: read voice-ack settings (for MCP Worker)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub.get_agent_voice_ack_admin(p_user_id UUID)
RETURNS TABLE(
  voice_ack_enabled BOOLEAN,
  voice_ack_text TEXT,
  voice_ack_delay_ms INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT voice_ack_enabled, voice_ack_text, voice_ack_delay_ms
  FROM hub.agent_settings
  WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_voice_ack_admin(UUID) TO service_role;

------------------------------------------------------------
-- Replace user-facing get_agent_settings to include voice-ack fields
-- (DROP first: Postgres refuses CREATE OR REPLACE when RETURNS TABLE
--  signature changes.)
------------------------------------------------------------
DROP FUNCTION IF EXISTS hub.get_agent_settings();

CREATE OR REPLACE FUNCTION hub.get_agent_settings()
RETURNS TABLE(
  has_key BOOLEAN,
  system_prompt TEXT,
  voice_ack_enabled BOOLEAN,
  voice_ack_text TEXT,
  voice_ack_delay_ms INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (anthropic_key_encrypted IS NOT NULL) AS has_key,
    COALESCE(system_prompt, '') AS system_prompt,
    COALESCE(voice_ack_enabled, FALSE) AS voice_ack_enabled,
    COALESCE(voice_ack_text, 'Working on that…') AS voice_ack_text,
    COALESCE(voice_ack_delay_ms, 1200) AS voice_ack_delay_ms
  FROM hub.agent_settings
  WHERE user_id = (SELECT auth.uid())
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_settings() TO authenticated;
