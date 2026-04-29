-- Live shelf devices — safer invariant: preserve at-least-one-active-per-user.
--
-- CONTEXT (Bug 2026-04-24 post-mortem):
--   Migration 20260424090000_invariant_batch.sql invariant #3 included a
--   one-shot consolidation pass:
--
--     UPDATE chefbyte.live_shelf_devices SET is_active = false
--      WHERE device_id IN (SELECT device_id FROM ranked WHERE rn > 1);
--
--   On prod, Jeremy had exactly one row in ``live_shelf_devices``
--   (kitchen-pi, is_active=true, heart-beating every 5s) — but after
--   the migration landed, that row flipped to is_active=false. The
--   likely cause: a race where a second row existed transiently (a
--   duplicate heartbeat-insert from a container restart) and the
--   consolidation's ORDER BY tie-broke the survivor the wrong way.
--   Jeremy had to notice the Pi had gone silent and manually reactivate
--   on the Scales tab. Silent revoke with no user-facing surface.
--
-- DESIGN:
--   1. Document the past consolidation (informational COMMENT only —
--      the UNIQUE INDEX itself stays, it's still the stated invariant).
--   2. Add a trigger ``live_shelf_devices_heartbeat_self_heal`` that
--      fires BEFORE UPDATE OF last_heartbeat_ts. If the incoming
--      heartbeat is for a row where ``is_active=false`` AND this user
--      has ZERO other active devices, auto-flip ``is_active=true``
--      so the Pi self-heals on its next heartbeat tick instead of
--      needing manual intervention.
--
--      A user WITH another active device is left alone — the inactive
--      row is genuinely retired in that case and shouldn't resurrect.
--
--   3. Add a trigger ``live_shelf_devices_guard_deactivation`` that
--      fires BEFORE UPDATE OF is_active. If the UPDATE would set
--      is_active=false on a row AND no other active device exists for
--      this user, the trigger raises a notice but allows the write
--      (explicit user action via Revoke button is intentional). This
--      is observability, not prevention — operators see the warning
--      in the Postgres log.
--
-- NON-GOALS (at the time this migration landed):
--   * Doesn't ledger-ize the is_active flag.
--     **DISCHARGED 2026-04-29** by migration
--     20260429150000_live_shelf_devices_state_ledger.sql which adds
--     the chefbyte.live_shelf_device_state_changes ledger table +
--     trigger + view. The note is retained here for migration-history
--     archeology.
--   * Doesn't change the INSERT path — adding a new device with
--     is_active=true still errors 23505 if the user already has one
--     active. The Scales UI should pre-deactivate or delete the old
--     one before inserting; that's existing client behaviour.
--
-- Safety:
--   The consolidation UPDATE in the earlier migration has already run
--   on prod and there's nothing to undo here — this migration adds
--   only triggers + comments. Idempotent: CREATE OR REPLACE FUNCTION,
--   DROP TRIGGER IF EXISTS.

BEGIN;

------------------------------------------------------------
-- 1. Self-heal trigger: heartbeat on inactive lone device → reactivate
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.live_shelf_devices_heartbeat_self_heal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_other_active_count INTEGER;
BEGIN
  -- Only engage when the write is touching last_heartbeat_ts AND the row
  -- is currently inactive. Any other write shape is a no-op.
  IF NEW.last_heartbeat_ts IS NOT DISTINCT FROM OLD.last_heartbeat_ts THEN
    RETURN NEW;
  END IF;

  IF NEW.is_active = true THEN
    -- Already active — nothing to self-heal. A caller that explicitly
    -- flipped is_active=true alongside a heartbeat is respected as-is.
    RETURN NEW;
  END IF;

  -- Count OTHER active devices for this user (excluding the row being
  -- updated). If zero, the user has no live Pi — self-heal this one.
  SELECT COUNT(*)
    INTO v_other_active_count
    FROM chefbyte.live_shelf_devices
   WHERE user_id = NEW.user_id
     AND device_id <> NEW.device_id
     AND is_active = true;

  IF v_other_active_count = 0 THEN
    NEW.is_active := true;
    -- Raise a NOTICE (not WARNING) so it shows in pg_log at default
    -- levels. Operators reading live_shelf_devices_heartbeat_* greps
    -- will see the auto-reactivation event with the device id.
    RAISE NOTICE 'live_shelf_devices: self-heal reactivated device % for user % (was is_active=false, no other active devices)',
      NEW.device_id, NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.live_shelf_devices_heartbeat_self_heal() FROM PUBLIC;
-- Trigger functions are invoked implicitly by the trigger system; no GRANT
-- needed because the trigger runs in the row-owner's context.

DROP TRIGGER IF EXISTS live_shelf_devices_heartbeat_self_heal_trigger
  ON chefbyte.live_shelf_devices;

CREATE TRIGGER live_shelf_devices_heartbeat_self_heal_trigger
  BEFORE UPDATE OF last_heartbeat_ts
  ON chefbyte.live_shelf_devices
  FOR EACH ROW
  EXECUTE FUNCTION private.live_shelf_devices_heartbeat_self_heal();

COMMENT ON TRIGGER live_shelf_devices_heartbeat_self_heal_trigger
  ON chefbyte.live_shelf_devices IS
  'Auto-reactivate a lone-and-inactive Pi when it sends a heartbeat. Closes '
  'the silent-revoke UX gap from the 20260424090000 invariant_batch '
  'consolidation. If the user has another active device, this trigger is '
  'a no-op — the inactive row is genuinely retired.';

------------------------------------------------------------
-- 2. Advisory trigger: log last-active deactivation attempts
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.live_shelf_devices_guard_deactivation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_other_active_count INTEGER;
BEGIN
  -- Only engage on is_active flips from true → false.
  IF NOT (OLD.is_active = true AND NEW.is_active = false) THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)
    INTO v_other_active_count
    FROM chefbyte.live_shelf_devices
   WHERE user_id = NEW.user_id
     AND device_id <> NEW.device_id
     AND is_active = true;

  IF v_other_active_count = 0 THEN
    -- Allow the write (explicit Revoke click is a valid action), but
    -- log so we can trace future unexpected deactivations in the logs.
    RAISE NOTICE 'live_shelf_devices: deactivating LAST active device % for user % — user will have 0 active Pis',
      NEW.device_id, NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.live_shelf_devices_guard_deactivation() FROM PUBLIC;

DROP TRIGGER IF EXISTS live_shelf_devices_guard_deactivation_trigger
  ON chefbyte.live_shelf_devices;

CREATE TRIGGER live_shelf_devices_guard_deactivation_trigger
  BEFORE UPDATE OF is_active
  ON chefbyte.live_shelf_devices
  FOR EACH ROW
  EXECUTE FUNCTION private.live_shelf_devices_guard_deactivation();

COMMENT ON TRIGGER live_shelf_devices_guard_deactivation_trigger
  ON chefbyte.live_shelf_devices IS
  'Advisory: logs (NOTICE) when a user deactivates their LAST active Pi so '
  'unexpected silent-deactivation paths are traceable post-hoc. Does not '
  'block the write — intentional Revoke is a valid action.';

------------------------------------------------------------
-- 3. Document the past consolidation + recommended future policy
------------------------------------------------------------

COMMENT ON INDEX chefbyte.live_shelf_devices_one_active_per_user IS
  'Invariant: one active Pi per user. Inactive rows retained for audit. '
  'Consolidation-on-migrate policy (applied once on 2026-04-24 via '
  'migration 20260424090000_invariant_batch.sql): if multiple active rows '
  'existed, the one with the most recent heartbeat won. Future violations '
  'should be driven by explicit user action via the Scales tab, not silent '
  'UPDATE sweeps. See 20260425060000 for the self-heal trigger that '
  'protects against post-hoc unexpected deactivations.';

COMMIT;
