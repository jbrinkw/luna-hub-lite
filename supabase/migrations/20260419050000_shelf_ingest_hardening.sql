-- Shelf-ingest hardening (round 2): deep-audit findings
--
-- Companion migration to the edge function changes in this same batch.
-- Focus: race-free idempotency inside apply_shelf_event, zero-delta guards,
-- depleted-forces-zero, NULL-safe macros, extra validation, LAN-IP regex,
-- client_event_id length cap, service_role grants, chefbyte intake columns,
-- deactivate_app cascade for live_shelf rows.
--
-- Findings addressed (numbered against the audit spec):
--   #1  apply_shelf_event now owns the idempotency check (INSERT … ON
--       CONFLICT DO NOTHING RETURNING) — closes the ~1ms race between the
--       edge function's SELECT + subsequent mutation.
--   #2  consumed/depleted branch gates food_logs INSERT on servings > 0
--       so zero-delta events don't pollute macro totals.
--   #3  added/refilled UPDATE path floors qty_containers at 0 via GREATEST.
--   #4  depleted event force-sets qty_containers = 0 (regardless of delta).
--   #5  COALESCE on all macro columns so products with NULL macros don't
--       violate food_logs NOT NULL constraints.
--   #6  p_kind validated in the function; early exception if not allowed.
--   #23 CHECK on chefbyte.live_shelf_devices.lan_ip — IPv4 or hostname shape.
--   #25 CHECK on chefbyte.shelf_event_log.client_event_id length <= 128.
--   #26 GRANT UPDATE, DELETE on shelf_event_log to service_role.
--   #9  New intake columns for fields the Pi sends (brand, variant,
--       serving_weight_g, unit_type, density_g_per_ml, certified).
--   #27 deactivate_app cascade-deletes chefbyte.live_shelf_devices so
--       scale_pairings + shelf_event_log fall out via FK CASCADE.
--
-- #24 (unique on (user_id, barcode)) is already done in
-- 20260303040000_chefbyte_tables.sql as `products_user_barcode_unique`
-- partial unique index. Verified; no change needed here.

------------------------------------------------------------
-- 1. Intake columns on chefbyte.products
------------------------------------------------------------
-- The Pi's /intake payload sends these fields; previously they were silently
-- dropped. Added as nullable columns so existing rows keep working.

ALTER TABLE chefbyte.products
  ADD COLUMN IF NOT EXISTS brand             TEXT,
  ADD COLUMN IF NOT EXISTS variant           TEXT,
  ADD COLUMN IF NOT EXISTS serving_weight_g  NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS unit_type         TEXT,
  ADD COLUMN IF NOT EXISTS density_g_per_ml  NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS certified         BOOLEAN;

------------------------------------------------------------
-- 2. LAN IP shape check on live_shelf_devices
------------------------------------------------------------
-- Matches the client validator: either IPv4 (four 1–3-digit octets) or a
-- hostname (starts with alnum, then alnum/dot/hyphen, max 253 chars).
-- NULL still permitted (lan_ip is optional until the user sets it).
-- Wrapped in a DO block so re-applying the migration is idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'live_shelf_devices_lan_ip_shape'
       AND conrelid = 'chefbyte.live_shelf_devices'::regclass
  ) THEN
    ALTER TABLE chefbyte.live_shelf_devices
      ADD CONSTRAINT live_shelf_devices_lan_ip_shape
      CHECK (
        lan_ip IS NULL
        OR lan_ip ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
        OR lan_ip ~ '^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,252}$'
      );
  END IF;
END $$;

------------------------------------------------------------
-- 3. shelf_event_log: client_event_id length cap + grants
------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shelf_event_log_client_event_id_len'
       AND conrelid = 'chefbyte.shelf_event_log'::regclass
  ) THEN
    ALTER TABLE chefbyte.shelf_event_log
      ADD CONSTRAINT shelf_event_log_client_event_id_len
      CHECK (char_length(client_event_id) <= 128);
  END IF;
END $$;

-- Service role needs UPDATE for apply_shelf_event to write back the outcome
-- after the mutation, and DELETE for future prune jobs.
GRANT UPDATE, DELETE ON chefbyte.shelf_event_log TO service_role;

------------------------------------------------------------
-- 4. apply_shelf_event — race-free idempotency + new signature
------------------------------------------------------------
-- Extended with p_client_event_id. The function now owns the idempotency
-- check so it lives inside the same transaction as the stock mutation.
-- First statement is an INSERT … ON CONFLICT DO NOTHING RETURNING into
-- shelf_event_log. If the INSERT produced 0 rows (conflict with a prior
-- apply), we replay the cached result.
--
-- The old 7-arg signature (without p_client_event_id) gets replaced; the
-- edge function + the admin wrapper pass 9 args now. Drop the wrapper first
-- to avoid the "cannot change return type" error on the recreate below.

DROP FUNCTION IF EXISTS chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ
);
DROP FUNCTION IF EXISTS private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION private.apply_shelf_event(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_event_kind      TEXT,
  p_product_id      UUID,
  p_delta_g         NUMERIC,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_applied BOOLEAN;
  v_existing_lot     UUID;
  v_existing_reason  TEXT;
  v_log_id           UUID;
  v_net_g            NUMERIC;
  v_svg_per          NUMERIC;
  v_cal              NUMERIC;
  v_carbs            NUMERIC;
  v_protein          NUMERIC;
  v_fat              NUMERIC;
  v_delta_c          NUMERIC;         -- delta in containers
  v_lot_id           UUID;
  v_loc_id           UUID;
  v_tz               TEXT;
  v_dsh              INTEGER;
  v_logical_date     DATE;
  v_new_qty          NUMERIC;
  v_servings         NUMERIC;
  v_insert_qty       NUMERIC;
  v_result           chefbyte.shelf_event_result;
BEGIN
  -- Validate kind up front so the stock_lots CHECK constraint can't fire
  -- mid-transaction with a confusing message.
  IF p_kind IS NULL OR p_kind NOT IN ('manual','live_shelf','live_scale','catch_all') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  END IF;

  -- Step 1: attempt to claim this client_event_id. If a prior apply already
  -- wrote a row, the INSERT returns no rows and we replay its result. This
  -- is atomic with the downstream stock mutation, so concurrent retries
  -- cannot both pass the check.
  INSERT INTO chefbyte.shelf_event_log (
    user_id, device_id, client_event_id, payload, applied, reason
  ) VALUES (
    p_user_id, p_device_id, p_client_event_id,
    jsonb_build_object(
      'scale_id', p_scale_id,
      'kind', p_kind,
      'event_kind', p_event_kind,
      'product_id', p_product_id,
      'delta_g', p_delta_g,
      'occurred_at', p_occurred_at
    ),
    false,     -- placeholder; updated at the end
    'pending'  -- placeholder; updated at the end
  )
  ON CONFLICT (user_id, client_event_id) DO NOTHING
  RETURNING event_id INTO v_log_id;

  IF v_log_id IS NULL THEN
    -- Duplicate: fetch the winner's cached result.
    SELECT applied, resolved_lot_id, reason
      INTO v_existing_applied, v_existing_lot, v_existing_reason
      FROM chefbyte.shelf_event_log
     WHERE user_id = p_user_id AND client_event_id = p_client_event_id;
    v_result := ROW(v_existing_lot, false, 'duplicate');
    RETURN v_result;
  END IF;

  -- Resolve product weight + macros. FOUND distinguishes "no such product"
  -- from "product exists but weight not set".
  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = p_product_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    v_result := ROW(NULL::UUID, false, 'product not found');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    v_result := ROW(NULL::UUID, false, 'product missing net_weight_g');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  v_delta_c := p_delta_g / v_net_g;

  -- Logical-date resolution via the user's profile.
  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = p_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(p_occurred_at, v_tz, v_dsh);

  IF p_event_kind IN ('consumed','depleted') THEN
    -- Pick the nearest-expiration lot with stock.
    SELECT lot_id INTO v_lot_id
      FROM chefbyte.stock_lots
     WHERE user_id = p_user_id AND product_id = p_product_id
       AND qty_containers > 0
     ORDER BY expires_on ASC NULLS LAST
     LIMIT 1;

    IF v_lot_id IS NULL THEN
      v_result := ROW(NULL::UUID, false, 'no lot with stock to decrement');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- #4 — `depleted` forces qty to zero regardless of delta magnitude;
    -- small or miscalibrated deltas from the Pi shouldn't leave residual
    -- stock that the physical shelf considers gone.
    IF p_event_kind = 'depleted' THEN
      UPDATE chefbyte.stock_lots
         SET qty_containers     = 0,
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id
       RETURNING qty_containers INTO v_new_qty;
    ELSE
      UPDATE chefbyte.stock_lots
         SET qty_containers     = GREATEST(qty_containers + v_delta_c, 0),
             last_update_source = p_kind,
             last_update_ts     = p_occurred_at
       WHERE lot_id = v_lot_id
       RETURNING qty_containers INTO v_new_qty;
    END IF;

    -- Macros are based on the actual physical delta the Pi reported, not
    -- the qty-change to stock. COALESCE guards for products with NULL
    -- macros (food_logs columns are NOT NULL).
    v_servings := ABS(v_delta_c) * COALESCE(v_svg_per, 0);

    -- #2 — skip the food_logs write if the event reported zero movement.
    -- A zero-macro row pollutes daily totals without adding information.
    IF v_servings > 0 THEN
      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit,
         calories, carbs, protein, fat)
      VALUES
        (p_user_id, p_product_id, v_logical_date, v_servings, 'serving',
         v_servings * COALESCE(v_cal,     0),
         v_servings * COALESCE(v_carbs,   0),
         v_servings * COALESCE(v_protein, 0),
         v_servings * COALESCE(v_fat,     0));
    END IF;

    v_result := ROW(v_lot_id, true,
                    CASE WHEN p_event_kind = 'depleted' THEN 'depleted'
                         ELSE 'decremented' END);
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;

  ELSIF p_event_kind IN ('added','refilled') THEN
    -- Pick an active lot (qty > 0). If all lots are empty, create a fresh
    -- lot in the user's first location.
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
        UPDATE chefbyte.shelf_event_log
           SET applied = v_result.applied,
               resolved_lot_id = v_result.resolved_lot_id,
               reason = v_result.reason
         WHERE event_id = v_log_id;
        RETURN v_result;
      END IF;

      v_insert_qty := GREATEST(v_delta_c, 0);

      INSERT INTO chefbyte.stock_lots
        (user_id, product_id, location_id, qty_containers,
         last_update_source, last_update_ts)
      VALUES
        (p_user_id, p_product_id, v_loc_id, v_insert_qty, p_kind, p_occurred_at)
      RETURNING lot_id INTO v_lot_id;

      v_result := ROW(v_lot_id, true, 'new lot created');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

    -- #3 — floor qty at 0 on the existing-lot UPDATE path too.
    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers + v_delta_c, 0),
           last_update_source = p_kind,
           last_update_ts     = p_occurred_at
     WHERE lot_id = v_lot_id
     RETURNING qty_containers INTO v_new_qty;

    v_result := ROW(v_lot_id, true, 'incremented');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;

  ELSE
    v_result := ROW(NULL::UUID, false, 'unknown event_kind');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT
) TO service_role;

------------------------------------------------------------
-- 5. Refresh the admin wrapper to forward the new arg
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.apply_shelf_event_admin(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_event_kind      TEXT,
  p_product_id      UUID,
  p_delta_g         NUMERIC,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_shelf_event(
    p_user_id, p_device_id, p_scale_id, p_kind,
    p_event_kind, p_product_id, p_delta_g, p_occurred_at,
    p_client_event_id
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT
) TO service_role;

------------------------------------------------------------
-- 6. deactivate_app cascade for live_shelf
------------------------------------------------------------
-- Existing deactivate_app tears down ChefByte data but was written before
-- the live_shelf tables existed. Add the live_shelf_devices delete; the
-- FK CASCADE on scale_pairings + shelf_event_log removes those rows in turn.
-- Redefining the whole function rather than patching via ALTER FUNCTION —
-- plpgsql doesn't support inserting lines into an existing body.

CREATE OR REPLACE FUNCTION private.deactivate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM hub.app_activations
  WHERE user_id = p_user_id AND app_name = p_app_name;

  IF p_app_name = 'coachbyte' THEN
    DELETE FROM coachbyte.timers WHERE user_id = p_user_id;
    DELETE FROM coachbyte.splits WHERE user_id = p_user_id;
    DELETE FROM coachbyte.daily_plans WHERE user_id = p_user_id;
    DELETE FROM coachbyte.user_settings WHERE user_id = p_user_id;
  END IF;

  IF p_app_name = 'chefbyte' THEN
    -- live_shelf: device row cascades to scale_pairings + shelf_event_log
    -- via FK ON DELETE CASCADE, so one DELETE covers all three tables.
    DELETE FROM chefbyte.live_shelf_devices WHERE user_id = p_user_id;
    DELETE FROM chefbyte.liquidtrack_events WHERE user_id = p_user_id;
    DELETE FROM chefbyte.liquidtrack_devices WHERE user_id = p_user_id;
    DELETE FROM chefbyte.food_logs WHERE user_id = p_user_id;
    DELETE FROM chefbyte.temp_items WHERE user_id = p_user_id;
    DELETE FROM chefbyte.shopping_list WHERE user_id = p_user_id;
    DELETE FROM chefbyte.meal_plan_entries WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipe_ingredients WHERE user_id = p_user_id;
    DELETE FROM chefbyte.recipes WHERE user_id = p_user_id;
    DELETE FROM chefbyte.stock_lots WHERE user_id = p_user_id;
    DELETE FROM chefbyte.products WHERE user_id = p_user_id;
    DELETE FROM chefbyte.locations WHERE user_id = p_user_id;
    DELETE FROM chefbyte.user_config WHERE user_id = p_user_id;
  END IF;
END;
$$;
