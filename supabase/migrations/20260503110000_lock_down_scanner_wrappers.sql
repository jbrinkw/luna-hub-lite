-- no-test: REVOKE-only DDL — the negative behavioral contract
-- (authenticated/anon callers hit 42501 insufficient_privilege when
-- RPC'ing the wrappers directly) is pinned by
-- supabase/tests/chefbyte/scanner_wrappers_security.test.sql.
--
-- Critical security fix (audit 2026-05-03): the chefbyte-schema wrappers
-- around the new private scanner functions were granted EXECUTE to
-- authenticated, but they accept caller-controlled user_id / transaction_id
-- without ownership checks. PostgREST exposes the chefbyte schema, so
-- any logged-in user could RPC them directly and bypass the edge
-- function's ownership gate.
--
-- Match the precedent set by apply_shelf_event_admin / consume_product_admin /
-- upsert_pi_lot_snapshots_admin: service_role ONLY. The shelf-ingest edge
-- function uses a service-role client so it continues to work; direct
-- PostgREST calls from authenticated users are blocked.

REVOKE EXECUTE ON FUNCTION chefbyte.execute_scan_action(UUID, UUID, TEXT, NUMERIC, TEXT, JSONB) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION chefbyte.void_scan_transaction(UUID) FROM authenticated, anon;
-- service_role grant is preserved (edge function path).

COMMENT ON FUNCTION chefbyte.execute_scan_action(UUID, UUID, TEXT, NUMERIC, TEXT, JSONB) IS
  'PostgREST-exposed wrapper around private.execute_scan_action. service_role only — edge function call site verifies ownership via x-api-key device lookup or JWT auth.uid() before invoking.';
COMMENT ON FUNCTION chefbyte.void_scan_transaction(UUID) IS
  'PostgREST-exposed wrapper around private.void_scan_transaction. service_role only — edge function call site verifies user_id ownership before invoking.';
