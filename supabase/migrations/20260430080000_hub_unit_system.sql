-- hub_unit_system: user preference between metric (grams) and imperial (ounces).
--
-- Affects only the display layer. When chefbyte.products.display_by_weight = true,
-- the UI converts net_weight_g-derived quantities to grams (metric) or ounces
-- (imperial) per this preference. Default 'imperial' matches the typical US
-- demo account region.
--
-- Stored on hub.profiles alongside timezone + day_start_hour because it's a
-- per-user UI preference, not module-specific. CoachByte / Hub UIs may also
-- consume it later (e.g. body-weight tracking in CoachByte PRs).

ALTER TABLE hub.profiles
  ADD COLUMN unit_system TEXT NOT NULL DEFAULT 'imperial'
    CHECK (unit_system IN ('metric', 'imperial'));

COMMENT ON COLUMN hub.profiles.unit_system IS
  'User-facing weight/volume unit preference. ''metric'' renders weights in '
  'grams; ''imperial'' renders in ounces. Display-only; canonical storage is '
  'always SI in chefbyte.products.net_weight_g.';
