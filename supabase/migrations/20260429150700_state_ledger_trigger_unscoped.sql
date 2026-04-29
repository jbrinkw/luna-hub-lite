-- Patch: state-ledger BEFORE-UPDATE trigger fires on EVERY column
-- update, not just ``is_active``.
--
-- Rationale: the heartbeat self-heal trigger
-- (private.live_shelf_devices_heartbeat_self_heal) mutates NEW.is_active
-- inside a BEFORE-UPDATE-OF-last_heartbeat_ts trigger. PG fires BEFORE
-- triggers alphabetically, but only for triggers whose OF column-list
-- intersects the SET list of the originating UPDATE. A heartbeat write
-- (``SET last_heartbeat_ts = ...``) has only ``last_heartbeat_ts`` in
-- its SET list — so a BEFORE-UPDATE-OF-is_active trigger never fires
-- on that path, even though self-heal flipped is_active inside the
-- triggered chain.
--
-- The ledger trigger therefore needs to fire on every UPDATE row and
-- decide internally (IS DISTINCT FROM check) whether to write a
-- ledger row. This catches the self-heal case while still keeping
-- pure non-is_active updates (like a rename) as a no-op via the
-- IS DISTINCT FROM short-circuit.

BEGIN;

DROP TRIGGER IF EXISTS live_shelf_devices_state_ledger_trigger
  ON chefbyte.live_shelf_devices;

CREATE TRIGGER live_shelf_devices_state_ledger_trigger
  BEFORE UPDATE
  ON chefbyte.live_shelf_devices
  FOR EACH ROW
  EXECUTE FUNCTION private.live_shelf_devices_state_ledger();

COMMENT ON TRIGGER live_shelf_devices_state_ledger_trigger
  ON chefbyte.live_shelf_devices IS
  'Append-only audit ledger for is_active flips. Fires on EVERY UPDATE '
  '(not BEFORE UPDATE OF is_active) so it observes self-heal-triggered '
  'is_active mutations that happen on a heartbeat-only SET clause. '
  'Internal IS DISTINCT FROM check makes non-is_active updates a no-op.';

COMMIT;
