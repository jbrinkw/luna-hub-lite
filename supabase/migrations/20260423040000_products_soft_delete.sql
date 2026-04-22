-- Soft-delete on chefbyte.products for cloud → Pi propagation.
--
-- Motivation: the Pi's local `products` SQLite cache is populated from a
-- 30s delta-sync poller that pulls rows whose updated_at > last_watermark
-- from GET /shelf-ingest/catalog. A HARD DELETE on cloud leaves no row for
-- the poller to see, so the Pi keeps a ghost entry indefinitely —
-- classifier can propose a product_id that no longer exists on cloud, and
-- the next apply_shelf_event silently fails with "product not found".
--
-- Fix: convert delete operations (Settings UI "delete", MCP
-- CHEFBYTE_delete_product) into UPDATE … SET deleted_at = now(). The
-- cloud's /catalog endpoint then includes soft-deleted rows in the
-- updated_since window (they still have a bumped updated_at), and the Pi
-- poller applies them as local hard deletes.
--
-- Design choices:
--   • Column on products (not a separate tombstone table) — keeps the
--     existing /catalog payload shape, delta-sync still works with no
--     new endpoint.
--   • NULL deleted_at = live, non-NULL = tombstoned. All existing cloud
--     queries (Settings product list, Inventory, Recipe editor, etc.)
--     already filter via RLS; we add an explicit `deleted_at IS NULL`
--     filter to the UI layer in a follow-up (callers below still see
--     soft-deleted rows until they update — no functional change on
--     their side because current handlers do hard deletes).
--   • Partial index on (user_id, updated_at) WHERE deleted_at IS NULL
--     keeps the live-product query hot without bloating on tombstones.
--   • The existing `products_set_updated_at` trigger bumps updated_at on
--     every UPDATE, so a soft-delete automatically advances the delta
--     watermark. No extra work needed.

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- Hot-path index: live rows queried by user. Partial WHERE clause keeps
-- it tiny — only alive products participate in the user's inventory /
-- product-list reads. Tombstones sit off-index.
CREATE INDEX IF NOT EXISTS products_user_alive_updated_idx
  ON chefbyte.products (user_id, updated_at)
  WHERE deleted_at IS NULL;

-- Separate index for the Pi poller's delta query: it needs BOTH live +
-- tombstoned rows in the updated_since window. Same (user_id, updated_at)
-- shape without the partial filter so a sequential scan isn't needed.
-- products_user_updated_at_idx already exists (from 20260421030000) so
-- this is a no-op — reaffirming for clarity.
-- (No new index added here.)
