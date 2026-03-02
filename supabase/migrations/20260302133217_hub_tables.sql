-- Hub module tables: app activations, API keys, tool config, extension settings

-- App activations (which sub-apps a user has enabled)
CREATE TABLE hub.app_activations (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, app_name)
);

ALTER TABLE hub.app_activations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own activations"
  ON hub.app_activations FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own activations"
  ON hub.app_activations FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own activations"
  ON hub.app_activations FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- API keys (MCP authentication, SHA-256 hashed)
CREATE TABLE hub.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  api_key_hash TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

ALTER TABLE hub.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own api keys"
  ON hub.api_keys FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own api keys"
  ON hub.api_keys FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own api keys"
  ON hub.api_keys FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own api keys"
  ON hub.api_keys FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- User tool configuration (per-tool enable/disable)
CREATE TABLE hub.user_tool_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (user_id, tool_name)
);

ALTER TABLE hub.user_tool_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own tool config"
  ON hub.user_tool_config FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own tool config"
  ON hub.user_tool_config FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own tool config"
  ON hub.user_tool_config FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own tool config"
  ON hub.user_tool_config FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- Extension settings (Obsidian, Todoist, Home Assistant)
CREATE TABLE hub.extension_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  extension_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  credentials_encrypted TEXT,
  UNIQUE (user_id, extension_name)
);

ALTER TABLE hub.extension_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own extension settings"
  ON hub.extension_settings FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own extension settings"
  ON hub.extension_settings FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own extension settings"
  ON hub.extension_settings FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own extension settings"
  ON hub.extension_settings FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- Activate app function (private implementation)
CREATE OR REPLACE FUNCTION private.activate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO hub.app_activations (user_id, app_name)
  VALUES (p_user_id, p_app_name)
  ON CONFLICT (user_id, app_name) DO NOTHING;
END;
$$;

-- Deactivate app function (private implementation)
CREATE OR REPLACE FUNCTION private.deactivate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM hub.app_activations
  WHERE user_id = p_user_id AND app_name = p_app_name;
END;
$$;

-- Public RPC wrappers (callable from frontend via supabase.schema('hub').rpc())
CREATE OR REPLACE FUNCTION hub.activate_app(p_app_name TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.activate_app((SELECT auth.uid()), p_app_name);
$$;

CREATE OR REPLACE FUNCTION hub.deactivate_app(p_app_name TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.deactivate_app((SELECT auth.uid()), p_app_name);
$$;

-- Grant EXECUTE on hub wrappers to authenticated
GRANT EXECUTE ON FUNCTION hub.activate_app(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION hub.deactivate_app(TEXT) TO authenticated;
