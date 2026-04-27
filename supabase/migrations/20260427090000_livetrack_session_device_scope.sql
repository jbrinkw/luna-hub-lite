-- Scope LiveTrack import sessions to (device_id, scale_id).
--
-- Pre-fix smell #8: the Pi's wizard-suppression gate checks "is ANY
-- non-terminal livetrack_import_sessions row active for this user?".
-- That kills throughput on every other scale this user owns the moment
-- they open the wizard for one — calibrating scale-03 freezes scale-01
-- (live_shelf) events for 10 minutes.
--
-- Fix: track which physical scale on the device the session is targeting.
-- The Pi gate becomes "is there an active session for THIS (device_id,
-- scale_id)?", so unrelated scales keep flowing events.
--
-- ``device_id`` was already on the table from the original migration
-- (20260421020000_livetrack_import_sessions.sql); only ``scale_id`` is
-- net new. Both kept nullable for backfill — existing rows are usually
-- closed/expired by now and don't need scoping. The edge function will
-- enforce NOT NULL on /create going forward.

ALTER TABLE chefbyte.livetrack_import_sessions
  ADD COLUMN IF NOT EXISTS scale_id TEXT;

-- Comment for grep-archaeology by future readers.
COMMENT ON COLUMN chefbyte.livetrack_import_sessions.scale_id IS
  'Physical scale being calibrated (e.g. scale-01, scale-02, scale-03). '
  'Pi suppresses events scoped to this (device_id, scale_id) tuple only — '
  'unrelated scales on the same device keep flowing events. '
  'Nullable for backfill; required by the edge function /create route.';

-- Active-session-by-(device,scale) lookup used by the Pi's /active poll.
-- Partial index on hot rows so closed/expired pile-up stays out of the
-- planner's way. Includes scale_id so the new scoped lookup is a single
-- index probe.
CREATE INDEX IF NOT EXISTS lti_active_device_scale_idx
  ON chefbyte.livetrack_import_sessions (device_id, scale_id, state)
  WHERE state NOT IN ('closed','expired');

-- Relax the legacy "one active session per user" invariant
-- (livetrack_sessions_one_active_per_user from migration 20260424090000)
-- to "one active per (user, scale_id)". Multi-scale wizards on the same
-- device are now legal — calibrating scale-03 must not block a session
-- against scale-01 from existing concurrently.
--
-- We drop the old constraint and replace with a scale-scoped one.
-- Sessions with NULL scale_id (legacy backfill rows) bypass uniqueness
-- because Postgres partial-unique indexes treat NULL as distinct —
-- desired here so pre-fix rows during the cutover window cannot collide
-- with new scoped rows.
DROP INDEX IF EXISTS chefbyte.livetrack_sessions_one_active_per_user;

CREATE UNIQUE INDEX IF NOT EXISTS livetrack_sessions_one_active_per_user_scale
  ON chefbyte.livetrack_import_sessions (user_id, scale_id)
  WHERE state NOT IN ('closed','expired');

COMMENT ON INDEX chefbyte.livetrack_sessions_one_active_per_user_scale IS
  'Invariant: one active livetrack import session per (user, scale_id). '
  'Replaces the prior livetrack_sessions_one_active_per_user (per-user) '
  'index from 20260424090000 — multi-scale wizards on the same device '
  'must coexist (smell #8 fix, 2026-04-27). NULL scale_id bypasses '
  'uniqueness so legacy rows during cutover do not collide with new ones.';
