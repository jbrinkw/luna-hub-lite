-- Return agent settings without exposing the encrypted key blob
CREATE OR REPLACE FUNCTION hub.get_agent_settings()
RETURNS TABLE(has_key BOOLEAN, system_prompt TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    (anthropic_key_encrypted IS NOT NULL) AS has_key,
    COALESCE(system_prompt, '') AS system_prompt
  FROM hub.agent_settings
  WHERE user_id = (SELECT auth.uid())
$$;

GRANT EXECUTE ON FUNCTION hub.get_agent_settings() TO authenticated;
