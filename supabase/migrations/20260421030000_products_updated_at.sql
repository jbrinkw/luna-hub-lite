-- Add updated_at to chefbyte.products for cloud → Pi delta-sync polling.
--
-- The Pi's cloud-sync poller (hardware/live-shelf/server/cloud/product_sync_poller.py)
-- calls GET /shelf-ingest/catalog?updated_since=<iso8601> every 30s and upserts
-- only the rows that changed. Without a per-row mtime column on the cloud side
-- the Pi would have to re-pull the entire catalog every tick, which doesn't
-- scale past a few dozen products and wastes edge-function bandwidth.
--
-- Backfill strategy: seed all existing rows with their created_at value. Any
-- freshly-imported LiveTrack wizard row is already going to carry a current
-- timestamp from the trigger below, so the backfill only matters for
-- pre-migration products (all of which the Pi has already synced at least
-- once via the initial full pull).
--
-- The trigger uses SET search_path = '' per project convention so it's
-- immune to search_path-based privilege escalation.

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One-shot backfill — NOT NULL DEFAULT now() already stamped existing rows
-- with the time of this migration. Explicitly set them to created_at so the
-- Pi's first delta sync after upgrade sees the original creation moment as
-- the high-watermark, which is harmless (delta still includes anything
-- newer than the prior high-watermark).
UPDATE chefbyte.products
   SET updated_at = created_at
 WHERE updated_at > created_at;

-- Trigger: bump updated_at on any UPDATE. The ``private`` schema already
-- hosts SECURITY DEFINER helpers for chefbyte; adding the trigger function
-- there keeps it off the public-schema surface. The trigger itself fires
-- under the row owner's identity (not SECURITY DEFINER) — we only want the
-- timestamp to move, not to bypass RLS.
CREATE OR REPLACE FUNCTION private.set_products_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_set_updated_at ON chefbyte.products;
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON chefbyte.products
  FOR EACH ROW
  EXECUTE FUNCTION private.set_products_updated_at();

-- Index to make the Pi's delta query (user_id + updated_at > ?) fast.
-- Composite order matters: user_id first because that's the equality
-- predicate, updated_at second for the range scan.
CREATE INDEX IF NOT EXISTS products_user_updated_at_idx
  ON chefbyte.products (user_id, updated_at);
