-- Defense: prevent empty/whitespace-only client_event_id from ever entering
-- chefbyte.shelf_event_log.
--
-- An empty client_event_id breaks idempotency — if a client misbehaves and
-- sends '', two retries collide on the same dedup key (user_id, '') and the
-- second silently no-ops, leaving the first result replayed indefinitely.
--
-- The constraint is added NOT VALID first (safe on a live table — no full
-- table scan) and then VALIDATED immediately.  If existing rows have empty
-- client_event_id values the VALIDATE will fail loudly and the migration
-- will be rolled back; a DBA must investigate before this migration can land.
--
-- private.apply_shelf_event() already checks `char_length(p_client_event_id) = 0`
-- at the application layer (migration 20260419060000_shelf_ingest_hardening_v2).
-- This DB-level CHECK is a belt-and-suspenders defense in case a future
-- SECURITY DEFINER path skips the application-layer guard.

ALTER TABLE chefbyte.shelf_event_log
  ADD CONSTRAINT shelf_event_log_client_event_id_nonempty
  CHECK (length(trim(client_event_id)) > 0)
  NOT VALID;

-- Validate against all existing rows.  If this fails, the migration aborts
-- with a clear error rather than silently activating a half-enforcing
-- constraint.  Do NOT delete rows to make this pass — that is an
-- orchestrator decision.
ALTER TABLE chefbyte.shelf_event_log
  VALIDATE CONSTRAINT shelf_event_log_client_event_id_nonempty;

COMMENT ON CONSTRAINT shelf_event_log_client_event_id_nonempty
  ON chefbyte.shelf_event_log IS
  'Belt-and-suspenders: an empty/whitespace-only client_event_id collapses '
  'the dedup key to ("", user_id) which causes silent idempotency collisions. '
  'The application layer already rejects this (apply_shelf_event hardening v2); '
  'this CHECK catches any future SECURITY DEFINER path that bypasses the guard.';
