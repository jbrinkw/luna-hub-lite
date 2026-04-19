-- Shelf-ingest edge function audit fixes
--
-- Companion migration to the edge function changes in
-- supabase/functions/shelf-ingest/index.ts. Wire-level idempotency,
-- safer `added` branch, and clearer reasons for product lookup failures.
--
-- Findings addressed (see audit spec):
--   #1 — idempotency via chefbyte.shelf_event_log (client_event_id UNIQUE)
--   #2 — `added` branch now filters qty_containers > 0 when picking the
--        lot to increment; zero-qty lots no longer get silently refilled
--   #5 — product-not-found vs product-missing-weight distinct reasons
--   #9 — `added` branch guards against negative qty on the INSERT fallback

------------------------------------------------------------
-- 1. Idempotency log
------------------------------------------------------------
-- One row per (device, client_event_id). Unique-on-client_event_id makes
-- concurrent duplicate INSERTs safe via ON CONFLICT DO NOTHING. The edge
-- function checks for an existing row before calling apply_shelf_event and
-- replays the cached result if it finds one.
--
-- Retention is intentionally unbounded for the MVP — volume is tiny
-- (a few events per day per shelf). A future migration can add a
-- scheduled prune.

CREATE TABLE IF NOT EXISTS chefbyte.shelf_event_log (
  event_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id        UUID NOT NULL REFERENCES chefbyte.live_shelf_devices(device_id) ON DELETE CASCADE,
  client_event_id  TEXT NOT NULL,
  payload          JSONB NOT NULL,
  applied          BOOLEAN NOT NULL,
  resolved_lot_id  UUID,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS shelf_event_log_device_idx
  ON chefbyte.shelf_event_log (device_id, created_at DESC);

ALTER TABLE chefbyte.shelf_event_log ENABLE ROW LEVEL SECURITY;

-- Users can read their own event log rows (useful for debugging from the UI
-- if we ever expose it). Writes are service_role only (edge function).
CREATE POLICY shelf_event_log_rls ON chefbyte.shelf_event_log
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

GRANT SELECT, INSERT ON chefbyte.shelf_event_log TO service_role;

------------------------------------------------------------
-- 2. apply_shelf_event — fixed branches
------------------------------------------------------------

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
  v_insert_qty     NUMERIC;
  v_result         chefbyte.shelf_event_result;
BEGIN
  -- Resolve product weight + macros. Use FOUND (set by SELECT INTO) to
  -- distinguish "no such product" from "product exists but has no
  -- weight set". Can't rely on a pre-initialized boolean flag because
  -- SELECT INTO with zero rows overwrites all target variables to NULL.
  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    v_result := ROW(NULL::UUID, false, 'product not found');
    RETURN v_result;
  END IF;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
    RETURN v_result;
  END IF;

  v_delta_c := p_delta_g / v_net_g;

  -- Resolve logical_date via user's profile. Note the table is
  -- `hub.profiles` (plural); the original migration referenced the
  -- wrong name, which would have failed at runtime in production the
  -- first time any user hit a /event. Fixed here as part of the audit.
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
    -- Increment an existing ACTIVE lot (qty > 0). If no active lot exists
    -- (product fully depleted, or brand-new on this shelf), create a fresh
    -- lot in the first location. This prevents the "refill into zero-qty
    -- lot" bug where the UI treats a lot as gone but it silently gets
    -- incremented.
    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id AND product_id = p_product_id
       AND qty_containers > 0
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

      -- Guard against negative qty on brand-new lots. A caller sending
      -- a negative delta with no active lot is nonsensical — we create
      -- an empty lot rather than a negative one.
      v_insert_qty := GREATEST(v_delta_c, 0);

      INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         last_update_source, last_update_ts)
      VALUES
        (p_user_id, p_product_id, v_loc_id, v_insert_qty, p_kind, p_occurred_at)
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
GRANT EXECUTE ON FUNCTION private.apply_shelf_event TO service_role;
