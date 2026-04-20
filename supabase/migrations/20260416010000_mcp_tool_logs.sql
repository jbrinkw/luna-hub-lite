-- MCP tool call logging: capture every tool invocation (success + failure)
-- so failures can be reviewed later. Service role writes; user reads own rows.

CREATE TABLE hub.mcp_tool_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_args JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('ok', 'tool_error', 'exception')),
  error_message TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the two expected read patterns:
--   1. "show me my recent failures"            -> (user_id, created_at desc)
--   2. "which tool is flaky across users"      -> (tool_name, created_at desc)
CREATE INDEX mcp_tool_logs_user_created_idx
  ON hub.mcp_tool_logs (user_id, created_at DESC);

CREATE INDEX mcp_tool_logs_tool_created_idx
  ON hub.mcp_tool_logs (tool_name, created_at DESC);

-- Partial index to quickly find failures.
CREATE INDEX mcp_tool_logs_failures_idx
  ON hub.mcp_tool_logs (user_id, created_at DESC)
  WHERE status <> 'ok';

ALTER TABLE hub.mcp_tool_logs ENABLE ROW LEVEL SECURITY;

-- Users can read their own logs. No write policy: only service_role inserts
-- (via the MCP Worker). service_role bypasses RLS, so no policy is needed
-- for it.
CREATE POLICY "Users can read own mcp tool logs"
  ON hub.mcp_tool_logs FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Explicit grants: authenticated can only SELECT. Service role gets full.
GRANT SELECT ON hub.mcp_tool_logs TO authenticated;
GRANT SELECT, INSERT ON hub.mcp_tool_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE hub.mcp_tool_logs_id_seq TO service_role;
