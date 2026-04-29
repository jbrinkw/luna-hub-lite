-- Add hub.mcp_tool_logs to the supabase_realtime publication so the
-- ExtensionCard "Last 5 MCP calls" tail updates live as Claude invokes
-- tools. Without publication membership, postgres_changes channels
-- filtered on this table return `status: error` and the React side
-- silently fails to receive events (see commentary in
-- 20260428040000_realtime_publication_backfill.sql).
--
-- This is the read side only — the MCP Worker writes logs via the
-- service_role (bypasses RLS), and authenticated users SELECT their own
-- rows under the existing RLS policy. Adding a table to the publication
-- does NOT relax security; RLS still gates the SELECT path.
--
-- Idempotent: skipped on re-run because the membership check matches
-- the prior insert.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'hub'
       AND tablename = 'mcp_tool_logs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE hub.mcp_tool_logs';
  END IF;
END $$;
