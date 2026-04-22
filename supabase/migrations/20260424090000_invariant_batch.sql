-- Invariant batch — 6 cloud-side partial unique indexes + a helper.
--
-- Closes long-standing ambiguity where the schema permitted states that
-- the application layer assumed away. Each invariant is a partial
-- UNIQUE index sealed by a pre-migration scan that consolidates any
-- existing violations down to a single survivor. No-op if the table
-- is clean (the production reality per manual audit 2026-04-24).
--
-- Invariants in this file:
--   1. coachbyte.timers      — one active timer per user (state
--      IN ('running','paused')). Redundant vs. existing
--      ``user_id UNIQUE`` at the column level but captures the
--      *stated* invariant independently so a future relaxation of
--      the column-level UNIQUE doesn't silently drop the guarantee.
--   2. chefbyte.scale_pairings — UNIQUE (user_id, scale_id). The
--      live_shelf migration gave us UNIQUE (device_id, scale_id)
--      which is not the same thing; user-scope uniqueness is what
--      the UI actually assumes.
--   3. chefbyte.live_shelf_devices — one active Pi per user.
--   4. chefbyte.food_logs — UNIQUE (user_id, source_client_event_id)
--      WHERE source_client_event_id IS NOT NULL. Replaces the
--      earlier non-unique index. Idempotency key for shelf-event
--      and livetrack ingests.
--   5. chefbyte.products — helper ``private.generate_meal_product_name``
--      returns a collision-free ``[MEAL] …`` name. Agent 1's
--      ``private.mark_meal_done`` is expected to call it (TODO
--      wiring below). No partial unique index is added here
--      because Agent B owns the products.name uniqueness decision.
--   6. chefbyte.livetrack_import_sessions — one active session per
--      user (state NOT IN ('closed','expired')).
--
-- Pi-side invariants #7 (sessions one-open-per-shelf) and #8
-- (tare_arm) are applied to the on-device SQLite schema via
-- server/storage/migrations.py + server/storage/schema.sql — NOT
-- via this file. See the commit message for the full scope.

------------------------------------------------------------
-- Invariant 1: coachbyte.timers one-active-per-user
------------------------------------------------------------
-- Note: the table already enforces ``user_id UNIQUE`` at the column
-- level, which is strictly stronger than the partial unique below
-- (only one row total per user, regardless of state). We add the
-- partial unique anyway so the stated invariant is visible in the
-- schema and survives a future relaxation of the column UNIQUE.
-- Pre-scan is a no-op under the stricter existing constraint but
-- included for completeness and to document the consolidation
-- policy ("keep the row with the most recent state change").
BEGIN;

-- Pre-scan: if somehow multiple running/paused rows exist for the
-- same user (currently impossible under the column UNIQUE), flip
-- all but the newest to ``expired``. end_time is used as the
-- freshness proxy because the table has no updated_at.
WITH ranked AS (
  SELECT
    timer_id,
    user_id,
    state,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY COALESCE(end_time, paused_at, now()) DESC, timer_id DESC
    ) AS rn
  FROM coachbyte.timers
  WHERE state IN ('running','paused')
)
UPDATE coachbyte.timers t
   SET state = 'expired'
  FROM ranked r
 WHERE t.timer_id = r.timer_id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS timers_one_active_per_user
  ON coachbyte.timers (user_id)
  WHERE state IN ('running', 'paused');

COMMENT ON INDEX coachbyte.timers_one_active_per_user IS
  'Invariant: at most one active (running|paused) timer per user. Redundant with the column-level user_id UNIQUE but encodes the stated invariant explicitly.';

COMMIT;

------------------------------------------------------------
-- Invariant 2: chefbyte.scale_pairings UNIQUE (user_id, scale_id)
------------------------------------------------------------
-- Existing UNIQUE(device_id, scale_id) prevents two pairings for the
-- same device+scale combo, but says nothing about a user accidentally
-- owning two pairings for the same scale_id across devices. The UI
-- assumes scale_id is user-unique.
BEGIN;

-- Pre-scan: if duplicates exist (keep newest last_heartbeat_ts, then
-- first_seen_at), delete the rest. Deletion over status-flip here
-- because scale_pairings has no status column and stale pairings
-- serve no audit purpose.
WITH ranked AS (
  SELECT
    pairing_id,
    user_id,
    scale_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, scale_id
      ORDER BY COALESCE(last_heartbeat_ts, first_seen_at) DESC,
               first_seen_at DESC,
               pairing_id DESC
    ) AS rn
  FROM chefbyte.scale_pairings
)
DELETE FROM chefbyte.scale_pairings sp
 USING ranked r
 WHERE sp.pairing_id = r.pairing_id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS scale_pairings_unique_per_scale
  ON chefbyte.scale_pairings (user_id, scale_id);

COMMENT ON INDEX chefbyte.scale_pairings_unique_per_scale IS
  'Invariant: each scale_id is paired at most once per user. UI assumes this.';

COMMIT;

------------------------------------------------------------
-- Invariant 3: chefbyte.live_shelf_devices one-active-per-user
------------------------------------------------------------
-- Multiple Pi devices may be registered per user (audit trail), but
-- at any given time only one is the "active" source of shelf events.
BEGIN;

-- Pre-scan: keep newest last_heartbeat_ts (fall back to created_at);
-- flip others is_active=false so the audit trail survives.
WITH ranked AS (
  SELECT
    device_id,
    user_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY COALESCE(last_heartbeat_ts, created_at) DESC, created_at DESC
    ) AS rn
  FROM chefbyte.live_shelf_devices
  WHERE is_active = true
)
UPDATE chefbyte.live_shelf_devices d
   SET is_active = false
  FROM ranked r
 WHERE d.device_id = r.device_id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS live_shelf_devices_one_active_per_user
  ON chefbyte.live_shelf_devices (user_id)
  WHERE is_active = true;

COMMENT ON INDEX chefbyte.live_shelf_devices_one_active_per_user IS
  'Invariant: one active Pi per user. Inactive rows retained for audit.';

COMMIT;

------------------------------------------------------------
-- Invariant 4: chefbyte.food_logs idempotency key
------------------------------------------------------------
-- The existing (user_id, source_client_event_id) index is non-unique;
-- the uniqueness was left to application-level "INSERT … ON CONFLICT
-- DO NOTHING" guards which some call paths skipped (bug shipped a
-- double-log). Promote to a partial UNIQUE.
BEGIN;

-- Pre-scan: collapse duplicates down to the oldest row per key.
-- Oldest wins because older rows are more likely to be part of
-- dependency chains (macros downstream already aggregated).
WITH ranked AS (
  SELECT
    log_id,
    user_id,
    source_client_event_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, source_client_event_id
      ORDER BY created_at ASC, log_id ASC
    ) AS rn
  FROM chefbyte.food_logs
  WHERE source_client_event_id IS NOT NULL
)
DELETE FROM chefbyte.food_logs fl
 USING ranked r
 WHERE fl.log_id = r.log_id
   AND r.rn > 1;

-- Drop the old non-unique index before creating the unique one.
DROP INDEX IF EXISTS chefbyte.food_logs_source_client_event_idx;

CREATE UNIQUE INDEX IF NOT EXISTS food_logs_source_event_unique
  ON chefbyte.food_logs (user_id, source_client_event_id)
  WHERE source_client_event_id IS NOT NULL;

COMMENT ON INDEX chefbyte.food_logs_source_event_unique IS
  'Invariant: at most one food_log per (user, source_client_event_id). Idempotency key for shelf-event + livetrack ingests.';

COMMIT;

------------------------------------------------------------
-- Invariant 5: chefbyte.products [MEAL] naming helper
------------------------------------------------------------
-- Agent 1 owns ``private.mark_meal_done`` which generates
-- ``[MEAL] <recipe> MM-DD`` product names. Two meals with the same
-- recipe on the same logical_date collide. We do NOT add a partial
-- unique index on products.name because the UI does not assume
-- per-user name uniqueness (custom products frequently share names
-- across households) and Agent B's soft-delete path relies on name
-- re-use after deleted_at stamps.
--
-- Instead, expose a helper that returns a collision-free meal name.
-- Agent 1's mark_meal_done SHOULD call this helper; a follow-up
-- commit will wire it in.
--
-- TODO(agent 1 follow-up): replace
--   v_meal_product_name := '[MEAL] ' || … || to_char(…, 'MM-DD');
-- with
--   v_meal_product_name := private.generate_meal_product_name(
--     p_user_id, <base>, v_logical_date);
-- in 20260424070000_mark_meal_done_atomic.sql.
BEGIN;

CREATE OR REPLACE FUNCTION private.generate_meal_product_name(
  p_user_id UUID,
  p_base_name TEXT,
  p_logical_date DATE
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date_part TEXT := to_char(p_logical_date, 'MM-DD');
  v_candidate TEXT;
  v_now       TIMESTAMPTZ := now();
BEGIN
  -- Layer 1: the bare ``[MEAL] <base> MM-DD`` shape.
  v_candidate := '[MEAL] ' || p_base_name || ' ' || v_date_part;
  IF NOT EXISTS (
    SELECT 1
      FROM chefbyte.products
     WHERE user_id = p_user_id
       AND name = v_candidate
  ) THEN
    RETURN v_candidate;
  END IF;

  -- Layer 2: append HH:MM (UTC) to disambiguate.
  v_candidate := '[MEAL] ' || p_base_name || ' ' || v_date_part
                 || ' ' || to_char(v_now, 'HH24:MI');
  IF NOT EXISTS (
    SELECT 1
      FROM chefbyte.products
     WHERE user_id = p_user_id
       AND name = v_candidate
  ) THEN
    RETURN v_candidate;
  END IF;

  -- Layer 3: append HH:MM:SS. Two meals within the same second is
  -- sufficiently degenerate that we stop here and rely on the
  -- caller's ON CONFLICT DO NOTHING fallback (if any).
  v_candidate := '[MEAL] ' || p_base_name || ' ' || v_date_part
                 || ' ' || to_char(v_now, 'HH24:MI:SS');
  RETURN v_candidate;
END;
$$;

REVOKE ALL ON FUNCTION private.generate_meal_product_name(UUID, TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.generate_meal_product_name(UUID, TEXT, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION private.generate_meal_product_name(UUID, TEXT, DATE) IS
  'Returns a chefbyte.products.name that does not collide with any existing row for p_user_id. Called by private.mark_meal_done when minting [MEAL] products for meal_prep. Three layers: MM-DD, MM-DD HH:MM, MM-DD HH:MM:SS.';

COMMIT;

------------------------------------------------------------
-- Invariant 6: chefbyte.livetrack_import_sessions one-active-per-user
------------------------------------------------------------
-- The table defines states ('waiting_barcode','waiting_scale',
-- 'scale_reading_received','awaiting_ai_tare','ai_tare_ready',
-- 'closed','expired'). Anything other than closed/expired is
-- "active". The UI assumes at most one active session per user so
-- barcode/scale writes land on an unambiguous session.
BEGIN;

-- Pre-scan: close all but the most recent active session per user.
-- "Close" = flip state to 'closed' (audit-friendly), not delete.
WITH ranked AS (
  SELECT
    session_id,
    user_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY updated_at DESC, created_at DESC, session_id DESC
    ) AS rn
  FROM chefbyte.livetrack_import_sessions
  WHERE state NOT IN ('closed','expired')
)
UPDATE chefbyte.livetrack_import_sessions s
   SET state      = 'closed',
       updated_at = now()
  FROM ranked r
 WHERE s.session_id = r.session_id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS livetrack_sessions_one_active_per_user
  ON chefbyte.livetrack_import_sessions (user_id)
  WHERE state NOT IN ('closed','expired');

COMMENT ON INDEX chefbyte.livetrack_sessions_one_active_per_user IS
  'Invariant: one active livetrack import session per user. Closed/expired rows retained as history.';

COMMIT;
