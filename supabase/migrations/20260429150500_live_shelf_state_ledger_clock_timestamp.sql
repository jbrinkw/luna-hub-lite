-- Patch: state-ledger trigger functions now stamp ``changed_at`` with
-- clock_timestamp() rather than the row default of ``now()``. Same-
-- transaction successive ledger writes (e.g. seed + self-heal in
-- the test harness, or a guard-deactivation immediately followed by
-- a manual reactivation in a future admin tool) need strictly
-- monotonic timestamps so the live_shelf_device_history view's
-- ROW_NUMBER() ORDER BY changed_at,change_id stays deterministic.
--
-- This is a pure CREATE OR REPLACE patch on the two trigger functions
-- introduced by 20260429150000. Idempotent on re-run.

BEGIN;

CREATE OR REPLACE FUNCTION private.live_shelf_devices_state_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason TEXT;
  v_changed_by UUID;
BEGIN
  IF OLD.is_active IS NOT DISTINCT FROM NEW.is_active THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_reason := current_setting('ledger.reason', true);
    IF v_reason = '' THEN
      v_reason := NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_reason := NULL;
  END;

  BEGIN
    v_changed_by := NULLIF(current_setting('ledger.changed_by', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_changed_by := NULL;
  END;

  INSERT INTO chefbyte.live_shelf_device_state_changes (
    device_id, user_id, was_active, became_active,
    changed_at, change_reason, changed_by
  ) VALUES (
    NEW.device_id, NEW.user_id, OLD.is_active, NEW.is_active,
    clock_timestamp(), v_reason, v_changed_by
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.live_shelf_devices_state_ledger_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_changed_by UUID;
BEGIN
  BEGIN
    v_changed_by := NULLIF(current_setting('ledger.changed_by', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_changed_by := NULL;
  END;

  INSERT INTO chefbyte.live_shelf_device_state_changes (
    device_id, user_id, was_active, became_active,
    changed_at, change_reason, changed_by
  ) VALUES (
    NEW.device_id, NEW.user_id, NEW.is_active, NEW.is_active,
    clock_timestamp(), 'backfill', v_changed_by
  );

  RETURN NEW;
END;
$$;

COMMIT;
