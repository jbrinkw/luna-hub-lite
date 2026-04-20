-- Live shelf — persist Pi-side outbox metrics on the device row.
--
-- Scenario 7: heartbeat_provider on the Pi already emits
-- ``outbox_pending_count`` + ``outbox_permanent_failures`` in every
-- heartbeat payload (see server/app.py::_heartbeat_provider). Before
-- this migration those fields were silently dropped by the edge
-- function because the target columns didn't exist. This migration:
--
--   1. Adds two integer columns (default 0, NOT NULL, non-negative
--      CHECKs matching ``pending_review_count``'s convention) to
--      ``chefbyte.live_shelf_devices``.
--   2. Backfills existing rows (none for a fresh env; explicit for
--      every other env) to 0 so the NOT NULL add is safe.
--
-- The companion edge-function change (handleHeartbeat in
-- supabase/functions/shelf-ingest/index.ts) reads the new keys from
-- the body and writes them alongside last_heartbeat_ts /
-- pending_review_count in the same UPDATE.
--
-- Web UI picks the fields up via the existing
-- ``select('*', ...)`` over ``chefbyte.live_shelf_devices`` — no
-- schema read is exposed in addition.

ALTER TABLE chefbyte.live_shelf_devices
  ADD COLUMN IF NOT EXISTS outbox_pending_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outbox_permanent_failures INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'live_shelf_devices_outbox_pending_nonneg'
       AND conrelid = 'chefbyte.live_shelf_devices'::regclass
  ) THEN
    ALTER TABLE chefbyte.live_shelf_devices
      ADD CONSTRAINT live_shelf_devices_outbox_pending_nonneg
      CHECK (outbox_pending_count >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'live_shelf_devices_outbox_permanent_nonneg'
       AND conrelid = 'chefbyte.live_shelf_devices'::regclass
  ) THEN
    ALTER TABLE chefbyte.live_shelf_devices
      ADD CONSTRAINT live_shelf_devices_outbox_permanent_nonneg
      CHECK (outbox_permanent_failures >= 0);
  END IF;
END $$;
