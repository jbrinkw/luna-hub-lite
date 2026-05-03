-- Catch-all LiveTrack auto-import (2026-05-02): one new column on
-- chefbyte.products carries the "measured full" stamp. Set-once: programmatic
-- writes only fire when currently NULL; user's manual checkbox in the event
-- viewer can also stamp it. Combined with tare_weight_g IS NULL/NOT NULL,
-- this drives the 3-state inventory tag color (red / blue / normal).
ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS measured_full_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN chefbyte.products.measured_full_at IS
  'When the product was confirmed at full mass (tare + net_weight_g within 5%). NULL = not yet confirmed; combined with tare_weight_g, drives the 3-state inventory tag (red/blue/normal). Set-once: never overwritten programmatically.';
