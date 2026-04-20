-- Shelf-ingest hardening v2 — pass-2 deep-audit findings
--
-- Companion migration to edge function changes in the same batch. Focus:
--   #2  — dedup replay returns the CACHED applied/reason/resolved_lot_id
--         instead of dropping them on the floor with a generic 'duplicate'.
--   #3  — manual-edit staleness fence: if a lot was last touched by a
--         manual edit AFTER this event's occurred_at, skip the mutation.
--   #4  — heartbeat_upsert_pairings_admin: atomic bulk UPSERT that never
--         overwrites product_id on existing rows.
--   #6  — plpgsql drops 'manual' from the allowed-kind list (sentinel for
--         UI edits; never sent by the Pi).
--   #8  — tighter IPv4 regex: per-octet 0–255 bound replaces
--         `[0-9]{1,3}` which allowed 999.999.999.999.
--   #9  — CHECK (net_weight_g IS NULL OR net_weight_g > 0) on products.
--   #10 — CHECK (pending_review_count >= 0) on live_shelf_devices.

------------------------------------------------------------
-- 1. apply_shelf_event — dedup replay cache + staleness fence + kind list
------------------------------------------------------------
-- Full-function CREATE OR REPLACE. Two behavioural changes vs 050000:
--   (a) On duplicate (shelf_event_log already has a row for this
--       client_event_id): return ROW(resolved_lot_id, applied, reason)
--       from the cached row as-is. The Pi can now tell "successfully
--       re-applied replay" from "never applied in the first place".
--   (b) After locating the target lot (consumed/depleted/added/refilled
--       existing-lot branch) we check last_update_source='manual' AND
--       last_update_ts > p_occurred_at; if so, skip the mutation and
--       record 'stale: manual edit is newer' in the event log. This
--       protects user edits from being clobbered by offline replay.
-- #6: drop 'manual' from the valid p_kind list — 'manual' is a sentinel
-- written directly by the UI, never passed through the edge function.

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
  v_delta_c          NUMERIC;
  v_lot_id           UUID;
  v_loc_id           UUID;
  v_tz               TEXT;
  v_dsh              INTEGER;
  v_logical_date     DATE;
  v_new_qty          NUMERIC;
  v_servings         NUMERIC;
  v_insert_qty       NUMERIC;
  v_lot_src          TEXT;
  v_lot_ts           TIMESTAMPTZ;
  v_result           chefbyte.shelf_event_result;
BEGIN
  -- #6: 'manual' is a UI sentinel — reject it at the RPC boundary. The
  -- edge function already rejects it earlier (VALID_KINDS) so this is
  -- defense in depth.
  IF p_kind IS NULL OR p_kind NOT IN ('live_shelf','live_scale','catch_all') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  END IF;

  -- Step 1 — claim this client_event_id. On conflict, replay the cached
  -- outcome as-is so the Pi can distinguish "already succeeded, here's
  -- the lot id" from "never applied / new dedup hit".
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
    false, 'pending'
  )
  ON CONFLICT (user_id, client_event_id) DO NOTHING
  RETURNING event_id INTO v_log_id;

  IF v_log_id IS NULL THEN
    -- #2 — replay the cached outcome instead of returning
    --     ROW(..., false, 'duplicate'). The Pi needs the real outcome to
    --     reconcile its retry queue.
    SELECT applied, resolved_lot_id, reason
      INTO v_existing_applied, v_existing_lot, v_existing_reason
      FROM chefbyte.shelf_event_log
     WHERE user_id = p_user_id AND client_event_id = p_client_event_id;
    v_result := ROW(v_existing_lot, v_existing_applied, v_existing_reason);
    RETURN v_result;
  END IF;

  -- Resolve product weight + macros.
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

  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = p_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(p_occurred_at, v_tz, v_dsh);

  IF p_event_kind IN ('consumed','depleted') THEN
    SELECT lot_id, last_update_source, last_update_ts
      INTO v_lot_id, v_lot_src, v_lot_ts
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

    -- #3 — staleness fence: manual edit wins if it's newer than the event.
    IF v_lot_src = 'manual' AND v_lot_ts IS NOT NULL
       AND v_lot_ts > p_occurred_at THEN
      v_result := ROW(v_lot_id, false, 'stale: manual edit is newer');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

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

    v_servings := ABS(v_delta_c) * COALESCE(v_svg_per, 0);

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
    SELECT lot_id, last_update_source, last_update_ts
      INTO v_lot_id, v_lot_src, v_lot_ts
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

    -- #3 — staleness fence on the existing-lot increment path too.
    IF v_lot_src = 'manual' AND v_lot_ts IS NOT NULL
       AND v_lot_ts > p_occurred_at THEN
      v_result := ROW(v_lot_id, false, 'stale: manual edit is newer');
      UPDATE chefbyte.shelf_event_log
         SET applied = v_result.applied,
             resolved_lot_id = v_result.resolved_lot_id,
             reason = v_result.reason
       WHERE event_id = v_log_id;
      RETURN v_result;
    END IF;

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
-- 2. heartbeat_upsert_pairings_admin — atomic bulk UPSERT
------------------------------------------------------------
-- Replaces N select-then-insert-or-update round-trips in the edge function
-- with one call that upserts all reported scales in a single SQL statement.
-- Crucially the ON CONFLICT DO UPDATE does NOT mention product_id, so
-- product_id on existing rows is preserved across heartbeats.
--
-- p_scales shape:  [{ "scale_id": "...", "kind": "live_shelf" }, ...]
-- Validation of scale_id / kind happens in the edge function before this
-- is called; we still guard inside as defense in depth.

CREATE OR REPLACE FUNCTION chefbyte.heartbeat_upsert_pairings_admin(
  p_device_id UUID,
  p_user_id   UUID,
  p_scales    JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec     JSONB;
  v_scale   TEXT;
  v_kind    TEXT;
  v_now     TIMESTAMPTZ := now();
BEGIN
  IF p_scales IS NULL OR jsonb_typeof(p_scales) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_rec IN SELECT jsonb_array_elements(p_scales) LOOP
    v_scale := v_rec->>'scale_id';
    v_kind  := v_rec->>'kind';
    IF v_scale IS NULL OR char_length(v_scale) = 0 THEN
      RAISE EXCEPTION 'invalid scale_id in heartbeat' USING ERRCODE = '22023';
    END IF;
    IF v_kind NOT IN ('live_shelf','live_scale','catch_all') THEN
      RAISE EXCEPTION 'invalid kind % in heartbeat', v_kind USING ERRCODE = '22023';
    END IF;

    -- product_id is intentionally omitted from both the INSERT column list
    -- and the UPDATE SET clause: new rows get NULL (correct default), and
    -- existing rows keep whatever product_id the user paired.
    INSERT INTO chefbyte.scale_pairings
      (user_id, device_id, scale_id, kind, last_heartbeat_ts)
    VALUES
      (p_user_id, p_device_id, v_scale, v_kind, v_now)
    ON CONFLICT (device_id, scale_id) DO UPDATE
      SET kind              = EXCLUDED.kind,
          last_heartbeat_ts = EXCLUDED.last_heartbeat_ts;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.heartbeat_upsert_pairings_admin(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.heartbeat_upsert_pairings_admin(UUID, UUID, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.heartbeat_upsert_pairings_admin(UUID, UUID, JSONB) TO service_role;

------------------------------------------------------------
-- 3. #8 — tighten lan_ip IPv4 regex (0–255 per octet)
------------------------------------------------------------
-- The 050000 constraint allowed any 1–3-digit octet so strings like
-- '999.999.999.999' slipped through. Drop + re-add with the strict octet
-- pattern. Hostname branch is unchanged.

ALTER TABLE chefbyte.live_shelf_devices
  DROP CONSTRAINT IF EXISTS live_shelf_devices_lan_ip_shape;

ALTER TABLE chefbyte.live_shelf_devices
  ADD CONSTRAINT live_shelf_devices_lan_ip_shape
  CHECK (
    lan_ip IS NULL
    OR lan_ip ~ '^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'
    OR lan_ip ~ '^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,252}$'
  );

------------------------------------------------------------
-- 4. #9 — net_weight_g must be > 0 when present
------------------------------------------------------------
-- Prevents direct DB writes that would cause a divide-by-zero in
-- apply_shelf_event. The function already guards at runtime; the table
-- check adds belt-and-suspenders.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'products_net_weight_g_positive'
       AND conrelid = 'chefbyte.products'::regclass
  ) THEN
    ALTER TABLE chefbyte.products
      ADD CONSTRAINT products_net_weight_g_positive
      CHECK (net_weight_g IS NULL OR net_weight_g > 0);
  END IF;
END $$;

------------------------------------------------------------
-- 5. #10 — pending_review_count must be >= 0
------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'live_shelf_devices_pending_review_nonneg'
       AND conrelid = 'chefbyte.live_shelf_devices'::regclass
  ) THEN
    ALTER TABLE chefbyte.live_shelf_devices
      ADD CONSTRAINT live_shelf_devices_pending_review_nonneg
      CHECK (pending_review_count >= 0);
  END IF;
END $$;
