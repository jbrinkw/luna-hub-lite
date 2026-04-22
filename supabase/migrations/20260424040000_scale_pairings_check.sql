-- chefbyte.scale_pairings — invariant CHECK between kind and product_id
--
-- Scale pairings are auto-created by shelf-ingest on first-heartbeat from
-- the Pi (product_id=NULL for all kinds). The user pairs a live_scale to
-- a product via the Scales tab after the row exists.
--
-- Invariant the UI depends on:
--   • live_shelf / catch_all kinds: product_id should ALWAYS stay NULL
--     (these kinds are camera-classified per-event, never pre-paired).
--   • live_scale kind: product_id is nullable at create time, but gets
--     set once the user pairs.
--
-- Guard: a CHECK constraint that prevents product_id from being set on
-- non-live_scale rows. Closes a footgun where a buggy migration or
-- manual admin op could set a product_id on a catch_all row and confuse
-- apply_shelf_event.
--
-- Not enforced: live_scale with product_id=NULL. That is the legitimate
-- pre-pair state. The UI surfaces a warning for this case (ScalesTab
-- unpaired-scale-warning) and the edge function returns 409 "scale
-- paired but product unset" for any event hitting this row.

BEGIN;

ALTER TABLE chefbyte.scale_pairings
  DROP CONSTRAINT IF EXISTS scale_pairings_product_id_kind_chk;

ALTER TABLE chefbyte.scale_pairings
  ADD CONSTRAINT scale_pairings_product_id_kind_chk
  CHECK (product_id IS NULL OR kind = 'live_scale');

COMMIT;
