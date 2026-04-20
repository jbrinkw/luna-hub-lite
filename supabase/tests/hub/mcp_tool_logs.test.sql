BEGIN;
SELECT plan(10);

-- Setup: two users. logs_owner is the log subject; logs_other probes RLS.
SELECT tests.create_supabase_user('logs_owner', 'logsowner@test.com');
SELECT tests.create_supabase_user('logs_other', 'logsother@test.com');

-- Capture UIDs for use under service_role (which lacks `tests` schema access).
SELECT tests.get_supabase_uid('logs_owner') AS _owner_uid \gset
SELECT tests.get_supabase_uid('logs_other') AS _other_uid \gset

-- ─── Structure / constraints ─────────────────────────────────────────
SELECT has_table('hub', 'mcp_tool_logs', 'hub.mcp_tool_logs exists');

SELECT columns_are(
  'hub', 'mcp_tool_logs',
  ARRAY['id', 'user_id', 'tool_name', 'tool_args', 'status', 'error_message', 'duration_ms', 'created_at'],
  'hub.mcp_tool_logs has the expected columns'
);

-- ─── Insert via service_role (no RLS) ────────────────────────────────
-- Writes happen from the MCP Worker using the service role. Seed three
-- rows for logs_owner covering the three status values + one for logs_other.
SET ROLE service_role;

INSERT INTO hub.mcp_tool_logs (user_id, tool_name, tool_args, status, error_message, duration_ms)
VALUES
  (:'_owner_uid'::uuid, 'COACHBYTE_log_set', '{"weight": 100}'::jsonb, 'ok', NULL, 42),
  (:'_owner_uid'::uuid, 'CHEFBYTE_consume', '{"product_id": "abc"}'::jsonb, 'tool_error', 'Insufficient stock', 17),
  (:'_owner_uid'::uuid, 'OBSIDIAN_get_project_text', '{}'::jsonb, 'exception', 'network died', 1234);

INSERT INTO hub.mcp_tool_logs (user_id, tool_name, tool_args, status, duration_ms)
VALUES (:'_other_uid'::uuid, 'CHEFBYTE_get_inventory', '{}'::jsonb, 'ok', 5);

-- ─── CHECK constraint on status ──────────────────────────────────────
SELECT throws_ok(
  format(
    'INSERT INTO hub.mcp_tool_logs (user_id, tool_name, status, duration_ms) VALUES (%L, ''x'', ''invalid_status'', 0)',
    :'_owner_uid'
  ),
  '23514',  -- check_violation
  NULL,
  'status must be one of (ok, tool_error, exception)'
);

SELECT throws_ok(
  format(
    'INSERT INTO hub.mcp_tool_logs (user_id, tool_name, status, duration_ms) VALUES (%L, ''x'', ''ok'', -1)',
    :'_owner_uid'
  ),
  '23514',
  NULL,
  'duration_ms must be >= 0'
);

SET ROLE postgres;

-- ─── RLS: user can read own logs ─────────────────────────────────────
SELECT tests.authenticate_as('logs_owner');

SELECT is(
  (SELECT count(*)::integer FROM hub.mcp_tool_logs),
  3,
  'User sees own 3 logs'
);

SELECT is(
  (SELECT count(*)::integer FROM hub.mcp_tool_logs WHERE status <> 'ok'),
  2,
  'Failure query returns the 2 non-ok rows'
);

-- ─── RLS: user cannot read other user''s logs ────────────────────────
SELECT tests.authenticate_as('logs_other');

SELECT is(
  (SELECT count(*)::integer FROM hub.mcp_tool_logs WHERE user_id = :'_owner_uid'::uuid),
  0,
  'logs_other cannot see logs_owner rows'
);

SELECT is(
  (SELECT count(*)::integer FROM hub.mcp_tool_logs),
  1,
  'logs_other sees only own row'
);

-- ─── RLS: authenticated users cannot INSERT (no INSERT grant) ────────
SELECT throws_ok(
  format(
    'INSERT INTO hub.mcp_tool_logs (user_id, tool_name, status, duration_ms) VALUES (%L, ''hack'', ''ok'', 0)',
    :'_other_uid'
  ),
  '42501',  -- insufficient_privilege (GRANT denial)
  NULL,
  'Authenticated users cannot INSERT into mcp_tool_logs directly'
);

-- ─── FK cascade: deleting a user removes their logs ──────────────────
SELECT tests.clear_authentication();
SELECT tests.delete_supabase_user('logs_owner');

SET ROLE service_role;
SELECT is(
  (SELECT count(*)::integer FROM hub.mcp_tool_logs WHERE user_id = :'_owner_uid'::uuid),
  0,
  'Deleting user cascades: logs_owner rows removed'
);
SET ROLE postgres;

-- Cleanup
SELECT tests.delete_supabase_user('logs_other');

SELECT * FROM finish();
ROLLBACK;
