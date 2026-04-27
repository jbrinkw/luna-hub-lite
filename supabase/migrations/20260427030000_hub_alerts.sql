-- Phase 4 — Production invariant monitor: hub.alerts table + admin gating.
--
-- Companion to docs/test-system-fix-plan.md §Phase 4. The
-- `invariant-monitor` edge function (run every 30 min via Supabase
-- scheduled functions / pg_cron) writes one row per detected violation
-- here. Jeremy reviews unacknowledged alerts on /hub/alerts.
--
-- DESIGN NOTES
--   * `is_admin` lives on `hub.profiles` (NOT a separate `user_profile`
--     table — `hub.profiles` is the existing per-user row). Boolean flag
--     is set in this migration for jdb1024@gmail.com only.
--   * Reads + acks are gated by `is_admin = true`. INSERT is monitor-only
--     (service_role bypasses RLS — no INSERT policy is necessary or
--     desirable; clients must NEVER write).
--   * Idempotency uses a partial unique index on `dedup_key` over
--     unacknowledged rows. The monitor performs an UPSERT-style write
--     that bumps `details.last_seen_at` on persistent violations rather
--     than spamming new rows.

------------------------------------------------------------
-- 1. is_admin flag on hub.profiles
------------------------------------------------------------

ALTER TABLE hub.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Seed: flip Jeremy's account on. Lookup-by-email avoids hardcoding a
-- UUID (more portable across local + production stacks). The DO block
-- guards against the email not existing yet (e.g. fresh local stack
-- before signup) — `UPDATE ... WHERE FALSE` is a no-op, not an error.
DO $$
DECLARE
  v_admin_id UUID;
BEGIN
  SELECT id INTO v_admin_id
    FROM auth.users
   WHERE email = 'jdb1024@gmail.com'
   LIMIT 1;

  IF v_admin_id IS NOT NULL THEN
    UPDATE hub.profiles
       SET is_admin = true
     WHERE user_id = v_admin_id;
  END IF;
END $$;

------------------------------------------------------------
-- 2. hub.alerts table
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hub.alerts (
  alert_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  invariant_name    TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  subject_type      TEXT NOT NULL,
  subject_id        TEXT,
  user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  details           JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_note TEXT,
  -- Deterministic dedup key. md5 over (invariant + subject pair) keeps
  -- the same logical violation from inserting a new row on every
  -- 30-min cron tick — the monitor instead bumps details.last_seen_at.
  -- Once acknowledged, a future identical violation reopens by
  -- inserting a fresh row (the partial unique index excludes acked rows).
  dedup_key         TEXT GENERATED ALWAYS AS (
                      md5(invariant_name || coalesce(subject_type, '') || coalesce(subject_id, ''))
                    ) STORED
);

-- "Show me unacknowledged critical alerts newest first" — the primary
-- read pattern from the admin UI. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS alerts_unacked_idx
  ON hub.alerts (severity, created_at DESC)
  WHERE acknowledged_at IS NULL;

-- Partial unique on dedup_key over unacknowledged rows — enforces the
-- idempotency contract without preventing reopens after ack.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedup_unacked_idx
  ON hub.alerts (dedup_key)
  WHERE acknowledged_at IS NULL;

-- Per-user read filter (when an admin scrolls a specific user's history).
CREATE INDEX IF NOT EXISTS alerts_user_idx
  ON hub.alerts (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

------------------------------------------------------------
-- 3. RLS — admins only, read + acknowledge (UPDATE)
------------------------------------------------------------

ALTER TABLE hub.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerts_admin_select ON hub.alerts;
CREATE POLICY alerts_admin_select
  ON hub.alerts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM hub.profiles
       WHERE user_id = (select auth.uid())
         AND is_admin = true
    )
  );

DROP POLICY IF EXISTS alerts_admin_update ON hub.alerts;
CREATE POLICY alerts_admin_update
  ON hub.alerts FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM hub.profiles
       WHERE user_id = (select auth.uid())
         AND is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM hub.profiles
       WHERE user_id = (select auth.uid())
         AND is_admin = true
    )
  );

-- No INSERT or DELETE policies — only service_role (the monitor) writes.

GRANT SELECT, UPDATE ON hub.alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON hub.alerts TO service_role;

------------------------------------------------------------
-- 4. Acknowledge helper (used by the admin UI)
------------------------------------------------------------
-- A SECURITY DEFINER wrapper that bundles the three-column ack write
-- + admin check in one round-trip. Clients call:
--   supabase.schema('hub').rpc('acknowledge_alert', { p_alert_id, p_note })
-- The function still respects the admin gate because it queries
-- hub.profiles.is_admin on the caller's auth.uid() before writing.

CREATE OR REPLACE FUNCTION hub.acknowledge_alert(
  p_alert_id UUID,
  p_note     TEXT DEFAULT NULL
) RETURNS hub.alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    UUID := (SELECT auth.uid());
  v_admin  BOOLEAN;
  v_row    hub.alerts;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT is_admin INTO v_admin
    FROM hub.profiles
   WHERE user_id = v_uid;

  IF NOT COALESCE(v_admin, false) THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;

  UPDATE hub.alerts
     SET acknowledged_at   = now(),
         acknowledged_by   = v_uid,
         acknowledged_note = p_note
   WHERE alert_id = p_alert_id
   RETURNING * INTO v_row;

  IF v_row.alert_id IS NULL THEN
    RAISE EXCEPTION 'alert not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION hub.acknowledge_alert(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub.acknowledge_alert(UUID, TEXT) TO authenticated;

------------------------------------------------------------
-- 5. Realtime publication so the admin UI reacts to new alerts
------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'hub'
       AND tablename = 'alerts'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE hub.alerts';
  END IF;
END $$;

------------------------------------------------------------
-- 6. Service-role helper used by the invariant-monitor edge function
------------------------------------------------------------
-- INSERT-or-bump-last-seen-at semantics. Returns the resulting row.
-- The partial unique index on dedup_key over unacked rows is what
-- enables ON CONFLICT (dedup_key) WHERE acknowledged_at IS NULL — but
-- Postgres requires a non-partial unique constraint or index for ON
-- CONFLICT. We work around this with a manual upsert pattern.

CREATE OR REPLACE FUNCTION private.upsert_alert(
  p_invariant_name TEXT,
  p_severity       TEXT,
  p_subject_type   TEXT,
  p_subject_id     TEXT,
  p_user_id        UUID,
  p_details        JSONB
) RETURNS hub.alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dedup TEXT := md5(p_invariant_name || coalesce(p_subject_type, '') || coalesce(p_subject_id, ''));
  v_row   hub.alerts;
BEGIN
  -- Try to bump an existing unacked row first. If found, append last_seen_at
  -- + bump count. If not, fall through to the insert path.
  UPDATE hub.alerts
     SET details = details
                   || jsonb_build_object('last_seen_at', now())
                   || jsonb_build_object(
                        'seen_count',
                        COALESCE((details->>'seen_count')::int, 1) + 1
                      )
                   || COALESCE(p_details, '{}'::jsonb)
   WHERE dedup_key = v_dedup
     AND acknowledged_at IS NULL
   RETURNING * INTO v_row;

  IF v_row.alert_id IS NOT NULL THEN
    RETURN v_row;
  END IF;

  INSERT INTO hub.alerts (
    invariant_name, severity, subject_type, subject_id, user_id, details
  ) VALUES (
    p_invariant_name,
    p_severity,
    p_subject_type,
    p_subject_id,
    p_user_id,
    COALESCE(p_details, '{}'::jsonb)
      || jsonb_build_object('last_seen_at', now(), 'seen_count', 1)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_alert(TEXT, TEXT, TEXT, TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.upsert_alert(TEXT, TEXT, TEXT, TEXT, UUID, JSONB) TO service_role;
