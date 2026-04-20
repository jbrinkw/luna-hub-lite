-- Live Shelf cloud integration (architecture v3: pull-per-event, no images)
--
-- Adds the minimum surface for a Raspberry Pi running the `live-shelf` stack
-- to register as a device, pull the user's product catalog + stock on demand,
-- and post back scale events that mutate stock + food_logs atomically.
--
-- One device (the Pi) per user account. Multiple scales *under* a device are
-- distinguished by a scale_id string on each event, not as separate cloud
-- rows. Scale kinds: 'live_shelf' (multi-item CV shelf), 'live_scale'
-- (single-item LiquidTrack-style), 'catch_all' (countertop CV scale).

------------------------------------------------------------
-- 1. Extend chefbyte.products with weight + container fields
------------------------------------------------------------
-- Needed so apply_shelf_event can convert delta_g → delta_containers.
-- Nullable on purpose: existing products without weights still work;
-- they just can't participate in shelf events until filled in.

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS net_weight_g NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS gross_weight_g NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS tare_weight_g NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS container_type TEXT;

------------------------------------------------------------
-- 2. Tag stock_lots rows with who/what last touched them
------------------------------------------------------------
-- Tag is overwritten on every mutation. Manual ChefByte edits set 'manual';
-- scale events stamp the scale kind. Always reflects the most recent source.

ALTER TABLE chefbyte.stock_lots
  ADD COLUMN IF NOT EXISTS last_update_source TEXT
    CHECK (last_update_source IS NULL
           OR last_update_source IN ('manual','live_shelf','live_scale','catch_all')),
  ADD COLUMN IF NOT EXISTS last_update_ts TIMESTAMPTZ;

------------------------------------------------------------
-- 3. Device registry: one row per Pi
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chefbyte.live_shelf_devices (
  device_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name          TEXT NOT NULL,
  import_key_hash      TEXT NOT NULL UNIQUE,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  last_heartbeat_ts    TIMESTAMPTZ,
  pending_review_count INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX live_shelf_devices_user_idx
  ON chefbyte.live_shelf_devices (user_id);

------------------------------------------------------------
-- 4. Scale-under-device registry + single-item pairing
------------------------------------------------------------
-- One row per physical scale reported by the Pi. Populated on first-sight
-- (handler auto-inserts on first heartbeat), updated on every heartbeat.
-- product_id is NULL except for `live_scale` kind, where the user must pair
-- the scale to a product before its events apply.

CREATE TABLE IF NOT EXISTS chefbyte.scale_pairings (
  pairing_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id          UUID NOT NULL REFERENCES chefbyte.live_shelf_devices(device_id) ON DELETE CASCADE,
  scale_id           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('live_shelf','live_scale','catch_all')),
  product_id         UUID REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_ts  TIMESTAMPTZ,
  UNIQUE (device_id, scale_id)
);

CREATE INDEX scale_pairings_user_idx
  ON chefbyte.scale_pairings (user_id);

------------------------------------------------------------
-- 5. RLS
------------------------------------------------------------

ALTER TABLE chefbyte.live_shelf_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE chefbyte.scale_pairings     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_shelf_devices_rls ON chefbyte.live_shelf_devices;
CREATE POLICY live_shelf_devices_rls ON chefbyte.live_shelf_devices
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS scale_pairings_rls ON chefbyte.scale_pairings;
CREATE POLICY scale_pairings_rls ON chefbyte.scale_pairings
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

------------------------------------------------------------
-- 6. apply_shelf_event — atomic scale event application
------------------------------------------------------------
-- Called by the shelf-ingest edge function once per event (after the
-- function has authenticated the device and resolved user_id + kind).
--
-- Contract:
--   p_user_id     — owner of the product + stock + food_logs
--   p_device_id   — which Pi
--   p_scale_id    — which scale on that Pi
--   p_kind        — scale kind ('live_shelf' | 'live_scale' | 'catch_all')
--   p_event_kind  — 'consumed' | 'added' | 'refilled' | 'depleted'
--   p_product_id  — required for camera scales (classifier result);
--                   for live_scale resolved via scale_pairings
--   p_delta_g     — positive for additions, negative for consumption
--   p_occurred_at — client timestamp (used for logical_date)
--
-- Returns a row describing what happened:
--   resolved_lot_id — the stock_lots row that was mutated (NULL if none)
--   applied         — true if stock mutated, false if skipped (missing weight)
--   reason          — short human-readable outcome

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typname = 'shelf_event_result' AND n.nspname = 'chefbyte'
  ) THEN
    CREATE TYPE chefbyte.shelf_event_result AS (
      resolved_lot_id UUID,
      applied BOOLEAN,
      reason TEXT
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private.apply_shelf_event(
  p_user_id      UUID,
  p_device_id    UUID,
  p_scale_id     TEXT,
  p_kind         TEXT,
  p_event_kind   TEXT,
  p_product_id   UUID,
  p_delta_g      NUMERIC,
  p_occurred_at  TIMESTAMPTZ
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_net_g          NUMERIC;
  v_svg_per        NUMERIC;
  v_cal            NUMERIC;
  v_carbs          NUMERIC;
  v_protein        NUMERIC;
  v_fat            NUMERIC;
  v_delta_c        NUMERIC;         -- delta in containers
  v_lot_id         UUID;
  v_loc_id         UUID;
  v_tz             TEXT;
  v_dsh            INTEGER;
  v_logical_date   DATE;
  v_new_qty        NUMERIC;
  v_servings       NUMERIC;
  v_result         chefbyte.shelf_event_result;
BEGIN
  -- Resolve product weight + macros
  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
    RETURN v_result;
  END IF;

  v_delta_c := p_delta_g / v_net_g;

  -- Resolve logical_date via user's profile
  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = p_user_id;
  IF v_tz IS NULL THEN v_tz := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;    END IF;
  v_logical_date := private.get_logical_date(p_occurred_at, v_tz, v_dsh);

  IF p_event_kind IN ('consumed','depleted') THEN
    -- Decrement nearest-expiration lot (FIFO-by-expiration, floor at 0).
    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY expires_on ASC NULLS LAST
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, false, 'no lot with stock to decrement');
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers = GREATEST(qty_containers + v_delta_c, 0),
           last_update_source = p_kind,
           last_update_ts = p_occurred_at
     WHERE lot_id = v_lot_id
     RETURNING qty_containers INTO v_new_qty;

    -- Log consumption macros
    v_servings := ABS(v_delta_c) * v_svg_per;
    INSERT INTO chefbyte.food_logs
      (user_id, product_id, logical_date, qty_consumed, unit,
       calories, carbs, protein, fat)
    VALUES
      (p_user_id, p_product_id, v_logical_date, v_servings, 'serving',
       v_servings * v_cal, v_servings * v_carbs,
       v_servings * v_protein, v_servings * v_fat);

    v_result := ROW(v_lot_id, true, 'decremented');
    RETURN v_result;

  ELSIF p_event_kind IN ('added','refilled') THEN
    -- Increment existing lot; if none found, create one in the first
    -- location. NULL expiration = "unknown" (merges via stock_lots_merge_key).
    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id AND product_id = p_product_id
     ORDER BY created_at ASC
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      SELECT location_id INTO v_loc_id
        FROM chefbyte.locations
       WHERE user_id = p_user_id
       ORDER BY created_at ASC
       LIMIT 1;

      IF v_loc_id IS NULL THEN
        v_result := ROW(NULL::UUID, false, 'user has no locations');
        RETURN v_result;
      END IF;

      INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         last_update_source, last_update_ts)
      VALUES
        (p_user_id, p_product_id, v_loc_id, v_delta_c, p_kind, p_occurred_at)
      RETURNING lot_id INTO v_lot_id;

      v_result := ROW(v_lot_id, true, 'new lot created');
      RETURN v_result;
    END IF;

    UPDATE chefbyte.stock_lots
       SET qty_containers = qty_containers + v_delta_c,
           last_update_source = p_kind,
           last_update_ts = p_occurred_at
     WHERE lot_id = v_lot_id
     RETURNING qty_containers INTO v_new_qty;

    v_result := ROW(v_lot_id, true, 'incremented');
    RETURN v_result;

  ELSE
    v_result := ROW(NULL::UUID, false, 'unknown event_kind');
    RETURN v_result;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_shelf_event FROM PUBLIC;

------------------------------------------------------------
-- 7. Grants for service-role (used by shelf-ingest edge function)
------------------------------------------------------------
-- The edge function uses the service-role key (bypasses RLS). These
-- grants aren't strictly required since service-role is superuser-like,
-- but explicit is better for future tightening.

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.live_shelf_devices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.scale_pairings     TO service_role;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event                 TO service_role;
