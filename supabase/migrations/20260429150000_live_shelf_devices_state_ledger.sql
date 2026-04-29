-- Live-shelf devices: ledger-ize the ``is_active`` flag.
--
-- Drains the "Live-shelf devices: ledger-ize is_active flag" entry from
-- ``ignore.md`` (originally a documented NON-GOAL of the 2026-04-25
-- safer-invariant migration). User asked us to take it on.
--
-- WHY:
--   The current world has a single mutable boolean
--   ``chefbyte.live_shelf_devices.is_active``. Three independent paths
--   can flip it (manual Revoke, the consolidation-on-migrate sweep, the
--   self-heal trigger) and at-the-table observability is "current
--   value, no history." The 2026-04-24 silent-revoke incident took an
--   hour of grepping pg_log to root-cause because there was nowhere
--   to look up "when did this device last go inactive, and what
--   triggered it?"
--
-- WHAT:
--   1. A new ledger table ``chefbyte.live_shelf_device_state_changes``
--      that records every is_active flip. PK is its own UUID — the
--      ledger is append-only history, not a current-state mirror.
--   2. A BEFORE-UPDATE trigger ``live_shelf_devices_state_ledger`` that
--      inserts a ledger row whenever ``is_active`` actually changes
--      between OLD and NEW. The trigger fires AFTER the existing
--      ``live_shelf_devices_heartbeat_self_heal`` and
--      ``live_shelf_devices_guard_deactivation`` BEFORE-UPDATE triggers
--      because those mutate NEW.is_active and we want the FINAL
--      observed transition logged (NOT the operator's intent).
--   3. A read view ``chefbyte.live_shelf_device_history`` joining the
--      current-state row to its ordered ledger.
--   4. A backfill — for every existing row, INSERT a single ledger row
--      representing the device's initial state (was_active = false /
--      became_active = current is_active, change_reason = 'backfill').
--      This gives every device a non-empty history starting from when
--      this migration ran.
--   5. RLS — per-user, mirrors live_shelf_devices.
--
-- ORDERING NOTE:
--   The 20260425060000 migration created two BEFORE-UPDATE triggers on
--   live_shelf_devices. PostgreSQL fires BEFORE-UPDATE triggers in
--   alphabetical order by trigger name. The new ledger trigger name
--   (``live_shelf_devices_state_ledger_trigger``) sorts AFTER both the
--   self-heal and guard triggers (``..._heartbeat_self_heal_trigger``,
--   ``..._guard_deactivation_trigger``) so we observe the FINAL value
--   of NEW.is_active. Verified with ``information_schema.triggers``
--   ORDER BY ``action_order``.
--
-- DEFENSIVE CHOICES:
--   * Ledger writes are SECURITY DEFINER so the trigger can write into
--     a table the caller's RLS doesn't necessarily allow them to
--     INSERT into directly (clients write live_shelf_devices via their
--     own user-scoped RLS policy; we want them to NOT be able to
--     forge ledger rows by hand, only to cause them via the trigger).
--   * change_reason is free-form TEXT defaulting NULL — operators can
--     set it via SET LOCAL "ledger.reason = 'manual revoke'" before an
--     UPDATE if they want richer context. The trigger reads
--     current_setting() with missing_ok=true so missing settings
--     don't break ordinary writes.
--   * changed_by is also pulled from a session GUC for the same
--     reason; defaults NULL.

BEGIN;

------------------------------------------------------------
-- 1. Ledger table
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chefbyte.live_shelf_device_state_changes (
  change_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       UUID NOT NULL REFERENCES chefbyte.live_shelf_devices(device_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  was_active      BOOLEAN NOT NULL,
  became_active   BOOLEAN NOT NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_reason   TEXT,
  changed_by      UUID,
  -- Sanity guard: a ledger row that doesn't represent an actual flip
  -- would dilute the log. Backfill rows are exempt because they're
  -- documenting "row pre-existed, here's its first observed state"
  -- with was_active = became_active intentionally for completeness.
  CHECK (change_reason = 'backfill' OR was_active <> became_active)
);

CREATE INDEX IF NOT EXISTS live_shelf_device_state_changes_device_idx
  ON chefbyte.live_shelf_device_state_changes (device_id, changed_at);

CREATE INDEX IF NOT EXISTS live_shelf_device_state_changes_user_idx
  ON chefbyte.live_shelf_device_state_changes (user_id, changed_at);

COMMENT ON TABLE chefbyte.live_shelf_device_state_changes IS
  'Append-only ledger of every is_active flip on live_shelf_devices. '
  'Populated by trigger live_shelf_devices_state_ledger_trigger. The '
  'companion view live_shelf_device_history joins current state + '
  'ordered history for operator queries.';

------------------------------------------------------------
-- 2. RLS — per-user, mirrors live_shelf_devices
------------------------------------------------------------

ALTER TABLE chefbyte.live_shelf_device_state_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_shelf_device_state_changes_select_rls
  ON chefbyte.live_shelf_device_state_changes;
CREATE POLICY live_shelf_device_state_changes_select_rls
  ON chefbyte.live_shelf_device_state_changes
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- Direct INSERT/UPDATE/DELETE from clients is intentionally absent.
-- The ledger is trigger-driven only; service_role bypasses RLS for
-- backfill / future admin tooling.

------------------------------------------------------------
-- 3. Trigger function — record every is_active flip
------------------------------------------------------------

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
  -- Only act on actual is_active flips. A no-op write (heartbeat that
  -- doesn't touch is_active, rename of device_name) shouldn't pollute
  -- the ledger.
  IF OLD.is_active IS NOT DISTINCT FROM NEW.is_active THEN
    RETURN NEW;
  END IF;

  -- Best-effort context pulled from session GUCs. Operators can set
  -- ledger.reason / ledger.changed_by before an UPDATE for richer
  -- attribution; the defaults (NULL) are fine.
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

  -- clock_timestamp() rather than now() so two transitions inside the
  -- same transaction (e.g. seed + heal in the test harness) get
  -- distinct ledger timestamps and history_seq orders deterministically.
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

REVOKE ALL ON FUNCTION private.live_shelf_devices_state_ledger() FROM PUBLIC;

DROP TRIGGER IF EXISTS live_shelf_devices_state_ledger_trigger
  ON chefbyte.live_shelf_devices;

-- Trigger name deliberately sorts AFTER the existing
-- ``live_shelf_devices_guard_deactivation_trigger`` and
-- ``live_shelf_devices_heartbeat_self_heal_trigger`` so the ledger
-- observes the FINAL is_active value (post-self-heal). PG fires
-- BEFORE-UPDATE triggers in alphabetical order by trigger name.
--
-- IMPORTANT: scope is BEFORE UPDATE (no OF column list). The heartbeat
-- self-heal trigger fires on UPDATE OF last_heartbeat_ts and mutates
-- NEW.is_active inside the triggered chain. A scoped ``OF is_active``
-- ledger trigger would NOT fire on that path because the originating
-- UPDATE's SET list doesn't include is_active. Internal IS DISTINCT
-- FROM check makes pure non-is_active writes a no-op.
CREATE TRIGGER live_shelf_devices_state_ledger_trigger
  BEFORE UPDATE
  ON chefbyte.live_shelf_devices
  FOR EACH ROW
  EXECUTE FUNCTION private.live_shelf_devices_state_ledger();

COMMENT ON TRIGGER live_shelf_devices_state_ledger_trigger
  ON chefbyte.live_shelf_devices IS
  'Append-only audit ledger for is_active flips. Fires on EVERY UPDATE '
  'so it observes self-heal-triggered is_active mutations that happen '
  'on a heartbeat-only SET clause. Internal IS DISTINCT FROM check '
  'makes non-is_active updates a no-op.';

------------------------------------------------------------
-- 4. INSERT-path ledger — record initial state on device creation
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.live_shelf_devices_state_ledger_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason TEXT;
  v_changed_by UUID;
BEGIN
  BEGIN
    v_reason := current_setting('ledger.reason', true);
    IF v_reason IS NULL OR v_reason = '' THEN
      v_reason := 'initial';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_reason := 'initial';
  END;

  BEGIN
    v_changed_by := NULLIF(current_setting('ledger.changed_by', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_changed_by := NULL;
  END;

  -- Initial-state row uses was_active = NEW.is_active so the CHECK
  -- constraint allows this insert via the 'backfill' / 'initial'
  -- reason exemption. We treat 'initial' the same as 'backfill' for
  -- this purpose: was = became is OK on the first ledger row.
  -- changed_at uses clock_timestamp() so that subsequent same-txn
  -- updates land with strictly later timestamps (history_seq stays
  -- deterministic).
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

REVOKE ALL ON FUNCTION private.live_shelf_devices_state_ledger_on_insert() FROM PUBLIC;

DROP TRIGGER IF EXISTS live_shelf_devices_state_ledger_insert_trigger
  ON chefbyte.live_shelf_devices;

CREATE TRIGGER live_shelf_devices_state_ledger_insert_trigger
  AFTER INSERT
  ON chefbyte.live_shelf_devices
  FOR EACH ROW
  EXECUTE FUNCTION private.live_shelf_devices_state_ledger_on_insert();

COMMENT ON TRIGGER live_shelf_devices_state_ledger_insert_trigger
  ON chefbyte.live_shelf_devices IS
  'Seeds the ledger with an "initial state" row each time a device is '
  'inserted. Marker reason is "backfill" to satisfy the CHECK '
  'exemption (was_active = became_active on a creation row).';

------------------------------------------------------------
-- 5. View — joined current-state + ordered history
------------------------------------------------------------

DROP VIEW IF EXISTS chefbyte.live_shelf_device_history;

CREATE VIEW chefbyte.live_shelf_device_history AS
SELECT
  d.device_id,
  d.user_id,
  d.device_name,
  d.is_active            AS current_is_active,
  d.last_heartbeat_ts,
  c.change_id,
  c.was_active,
  c.became_active,
  c.changed_at,
  c.change_reason,
  c.changed_by,
  -- 1 = oldest. Operators consume "give me oldest-first history"
  -- without having to re-derive it on the read side.
  ROW_NUMBER() OVER (PARTITION BY d.device_id ORDER BY c.changed_at, c.change_id) AS history_seq
FROM chefbyte.live_shelf_devices d
LEFT JOIN chefbyte.live_shelf_device_state_changes c
  ON c.device_id = d.device_id;

-- View security: views run with the privileges of the QUERYING role
-- (security_invoker is the default in PG15+). RLS on the underlying
-- live_shelf_device_state_changes table enforces per-user scoping.
ALTER VIEW chefbyte.live_shelf_device_history SET (security_invoker = on);

COMMENT ON VIEW chefbyte.live_shelf_device_history IS
  'Per-device current state joined to the full ordered ledger of '
  'is_active changes. Use ORDER BY history_seq for oldest-first; '
  'history_seq=1 is the initial backfill row.';

GRANT SELECT ON chefbyte.live_shelf_device_history TO authenticated;
GRANT SELECT ON chefbyte.live_shelf_device_state_changes TO authenticated;

------------------------------------------------------------
-- 6. Backfill — one ledger row per pre-existing device
------------------------------------------------------------
--
-- Tagged change_reason = 'backfill' so the CHECK constraint allows
-- was_active = became_active. The backfill row records each device's
-- state AT THE MOMENT THIS MIGRATION RAN — operators can grep for
-- 'backfill' to find devices whose history pre-dates the ledger.

INSERT INTO chefbyte.live_shelf_device_state_changes (
  device_id, user_id, was_active, became_active,
  changed_at, change_reason, changed_by
)
SELECT
  d.device_id,
  d.user_id,
  d.is_active,
  d.is_active,
  COALESCE(d.last_heartbeat_ts, d.created_at, now()),
  'backfill',
  NULL
FROM chefbyte.live_shelf_devices d
WHERE NOT EXISTS (
  -- Idempotent re-run: skip devices that already have at least one
  -- ledger row. Won't fire in normal forward migration but a manual
  -- replay during recovery shouldn't double-seed.
  SELECT 1 FROM chefbyte.live_shelf_device_state_changes c
   WHERE c.device_id = d.device_id
);

COMMIT;
