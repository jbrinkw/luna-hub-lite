-- Add updated_at + deleted_at to chefbyte.stock_lots for cloud → Pi lot-snapshot
-- reconciliation.
--
-- Motivation: the Pi already mirrors chefbyte.products via a 30s delta poller
-- (GET /shelf-ingest/catalog?updated_since=<iso>). But the Pi has no
-- counterpart for lot state — a scale-event race, a cloud-side manual edit
-- via the chef UI, or a dropped shelf_event_log POST can leave Pi's local
-- view of `stock_lots` out of sync with cloud indefinitely.
--
-- Fix: mirror the products pattern on stock_lots.
--   * ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now() — per-row mtime
--     so the Pi's lot-snapshot poller can send updated_since=<watermark> and
--     receive only changed rows.
--   * ADD COLUMN deleted_at TIMESTAMPTZ NULL — soft-delete tombstone so a
--     cloud-side lot purge propagates to the Pi (hard-delete would make the
--     row invisible to the delta query and the Pi would keep a ghost entry).
--   * BEFORE UPDATE trigger bumps updated_at on every UPDATE so any path that
--     mutates a lot (apply_shelf_event, apply_event_override, manual consume,
--     soft-delete flip) automatically advances the watermark.
--   * Composite index (user_id, updated_at) for the delta query.
--
-- The trigger function lives in the `private` schema per project convention,
-- with SET search_path = '' for privilege-escalation immunity. It's NOT
-- SECURITY DEFINER — we only want the timestamp to move, not to bypass RLS.

ALTER TABLE chefbyte.stock_lots
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE chefbyte.stock_lots
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- Backfill updated_at to created_at on pre-migration rows so the initial
-- delta watermark falls on creation time, not the migration moment. Any row
-- touched after the migration will get now() via the trigger below.
UPDATE chefbyte.stock_lots
   SET updated_at = created_at
 WHERE updated_at > created_at;

-- Trigger function — bumps updated_at on every UPDATE. Mirrors
-- private.set_products_updated_at 1:1.
CREATE OR REPLACE FUNCTION private.set_stock_lots_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_lots_set_updated_at ON chefbyte.stock_lots;
CREATE TRIGGER stock_lots_set_updated_at
  BEFORE UPDATE ON chefbyte.stock_lots
  FOR EACH ROW
  EXECUTE FUNCTION private.set_stock_lots_updated_at();

-- Delta-query index. Composite: user_id equality predicate first, updated_at
-- range second. Matches the access pattern the Pi's lot-snapshot poller
-- uses (WHERE user_id = $1 AND updated_at > $2).
CREATE INDEX IF NOT EXISTS stock_lots_user_updated_at_idx
  ON chefbyte.stock_lots (user_id, updated_at);
