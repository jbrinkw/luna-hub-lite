-- Event Viewer: per-user overrides on top of Pi-emitted shelf events.
--
-- Pi rows (shelf_event_log + food_logs) stay immutable; this table stores
-- user edits that the apply_event_override RPC reconciles back into
-- stock_lots + food_logs. A soft-delete (is_voided=true) keeps the row so
-- the viewer can still show "Voided" events while backing out their
-- stock + macro transactions.
--
-- Also adds a pi_event_id column on shelf_event_log so the cloud browser
-- can stream before/after images directly from the Pi on the LAN via
-- http://<lan_ip>:8000/event/<pi_event_id>/before.jpg.

------------------------------------------------------------
-- 1. event_overrides table + RLS + publication
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chefbyte.event_overrides (
  override_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_event_id    TEXT NOT NULL,
  -- Stock side (null = keep Pi's original delta).
  stock_qty_override NUMERIC(10,3),
  -- Macro side (null = derive from product per-serving * servings).
  macros_servings_override NUMERIC(10,3),
  calories_override  NUMERIC(10,3),
  protein_override   NUMERIC(10,3),
  carbs_override     NUMERIC(10,3),
  fat_override       NUMERIC(10,3),
  -- Toggles.
  macro_logging_enabled BOOLEAN NOT NULL DEFAULT true,
  is_voided          BOOLEAN NOT NULL DEFAULT false,
  -- Bookkeeping.
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS event_overrides_user_idx
  ON chefbyte.event_overrides (user_id, updated_at DESC);

ALTER TABLE chefbyte.event_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_overrides_user_rls ON chefbyte.event_overrides;
CREATE POLICY event_overrides_user_rls ON chefbyte.event_overrides
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.event_overrides TO service_role;

-- Realtime publication so the browser sees live updates when another tab
-- or the RPC writes an override row.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname='supabase_realtime'
       AND schemaname='chefbyte'
       AND tablename='event_overrides'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.event_overrides';
  END IF;
END $$;

-- Link food_logs rows to the event / override that created them so the
-- reconciler can delete+re-apply cleanly across edits. Nullable: existing
-- rows from non-event sources keep NULL.
ALTER TABLE chefbyte.food_logs
  ADD COLUMN IF NOT EXISTS source_client_event_id TEXT;

CREATE INDEX IF NOT EXISTS food_logs_source_client_event_idx
  ON chefbyte.food_logs (user_id, source_client_event_id)
  WHERE source_client_event_id IS NOT NULL;

------------------------------------------------------------
-- 2. shelf_event_log.pi_event_id — cloud→Pi image lookup
------------------------------------------------------------
-- The Pi's scale_events PK (its internal UUID) that maps to the on-disk
-- data/events/<pi_event_id>/ folder. Browser image src is
-- http://<lan_ip>:8000/event/<pi_event_id>/before.jpg.
-- Nullable so legacy rows that predate the Pi-side change still work;
-- the viewer shows a "no image available" placeholder for those.

ALTER TABLE chefbyte.shelf_event_log
  ADD COLUMN IF NOT EXISTS pi_event_id TEXT;

CREATE INDEX IF NOT EXISTS shelf_event_log_pi_event_id_idx
  ON chefbyte.shelf_event_log (pi_event_id)
  WHERE pi_event_id IS NOT NULL;

------------------------------------------------------------
-- 3. apply_shelf_event — accept + store pi_event_id
------------------------------------------------------------
-- New optional trailing arg. Backward-compatible: older edge-function
-- deployments calling without it still work (p_pi_event_id defaults to
-- NULL). Same full-function CREATE OR REPLACE strategy as the v2
-- hardening migration.

CREATE OR REPLACE FUNCTION private.apply_shelf_event(
  p_user_id         UUID,
  p_device_id       UUID,
  p_scale_id        TEXT,
  p_kind            TEXT,
  p_event_kind      TEXT,
  p_product_id      UUID,
  p_delta_g         NUMERIC,
  p_occurred_at     TIMESTAMPTZ,
  p_client_event_id TEXT,
  p_pi_event_id     TEXT DEFAULT NULL
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
  IF p_kind IS NULL OR p_kind NOT IN ('live_shelf','live_scale','catch_all') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  END IF;

  -- Step 1 — claim this client_event_id. INCLUDES pi_event_id so the
  -- cloud viewer can deep-link back to the Pi's image for this event.
  INSERT INTO chefbyte.shelf_event_log (
    user_id, device_id, client_event_id, payload, applied, reason, pi_event_id
  ) VALUES (
    p_user_id, p_device_id, p_client_event_id,
    jsonb_build_object(
      'scale_id', p_scale_id,
      'kind', p_kind,
      'event_kind', p_event_kind,
      'product_id', p_product_id,
      'delta_g', p_delta_g,
      'occurred_at', p_occurred_at,
      'pi_event_id', p_pi_event_id
    ),
    false, 'pending', p_pi_event_id
  )
  ON CONFLICT (user_id, client_event_id) DO NOTHING
  RETURNING event_id INTO v_log_id;

  IF v_log_id IS NULL THEN
    -- Dedup replay: back-fill pi_event_id if the original row was
    -- written before this field existed.
    UPDATE chefbyte.shelf_event_log
       SET pi_event_id = p_pi_event_id
     WHERE user_id = p_user_id
       AND client_event_id = p_client_event_id
       AND pi_event_id IS NULL
       AND p_pi_event_id IS NOT NULL;

    SELECT applied, resolved_lot_id, reason
      INTO v_existing_applied, v_existing_lot, v_existing_reason
      FROM chefbyte.shelf_event_log
     WHERE user_id = p_user_id AND client_event_id = p_client_event_id;
    v_result := ROW(v_existing_lot, v_existing_applied, v_existing_reason);
    RETURN v_result;
  END IF;

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
         calories, carbs, protein, fat, source_client_event_id)
      VALUES
        (p_user_id, p_product_id, v_logical_date, v_servings, 'serving',
         v_servings * COALESCE(v_cal,     0),
         v_servings * COALESCE(v_carbs,   0),
         v_servings * COALESCE(v_protein, 0),
         v_servings * COALESCE(v_fat,     0),
         p_client_event_id);
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
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

------------------------------------------------------------
-- 4. Refresh the admin wrapper with the new arg
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
  p_client_event_id TEXT,
  p_pi_event_id     TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_shelf_event(
    p_user_id, p_device_id, p_scale_id, p_kind,
    p_event_kind, p_product_id, p_delta_g, p_occurred_at,
    p_client_event_id, p_pi_event_id
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

------------------------------------------------------------
-- 5. apply_event_override — retroactive edit + reconcile stock + macros
------------------------------------------------------------
-- Given a client_event_id that already exists in shelf_event_log for the
-- calling user, upsert an override row and reconcile cloud state:
--   (a) back out the previous override's applied effect (if any) OR the
--       original Pi-applied effect if this is the first override
--   (b) if p_is_voided=true: leave stock backed out and food_log deleted
--   (c) else: re-apply stock delta (original or stock_qty_override) +
--       insert a fresh food_logs row (derived or custom macros)
--
-- Retroactive logical_date preservation: the fresh food_logs row uses the
-- logical_date derived from the ORIGINAL event's occurred_at, not now().

CREATE OR REPLACE FUNCTION private.apply_event_override(
  p_client_event_id        TEXT,
  p_stock_qty_override     NUMERIC DEFAULT NULL,
  p_macros_servings_override NUMERIC DEFAULT NULL,
  p_calories_override      NUMERIC DEFAULT NULL,
  p_protein_override       NUMERIC DEFAULT NULL,
  p_carbs_override         NUMERIC DEFAULT NULL,
  p_fat_override           NUMERIC DEFAULT NULL,
  p_macro_logging_enabled  BOOLEAN DEFAULT TRUE,
  p_is_voided              BOOLEAN DEFAULT FALSE
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id        UUID := (select auth.uid());
  v_override_id    UUID;
  v_prior          chefbyte.event_overrides%ROWTYPE;
  v_prior_found    BOOLEAN := FALSE;
  v_event_id       UUID;
  v_payload        JSONB;
  v_resolved_lot   UUID;
  v_applied        BOOLEAN;
  v_orig_product   UUID;
  v_orig_delta_g   NUMERIC;
  v_orig_kind      TEXT;
  v_orig_ek        TEXT;
  v_orig_occurred  TIMESTAMPTZ;
  v_net_g          NUMERIC;
  v_svg_per        NUMERIC;
  v_cal            NUMERIC;
  v_carbs          NUMERIC;
  v_protein        NUMERIC;
  v_fat            NUMERIC;
  v_tz             TEXT;
  v_dsh            INTEGER;
  v_logical_date   DATE;
  -- Effective values for the RE-APPLY phase.
  v_new_delta_c    NUMERIC;      -- signed container delta to re-apply
  v_new_servings   NUMERIC;      -- servings for new food_logs row
  v_new_cal        NUMERIC;
  v_new_carbs      NUMERIC;
  v_new_protein    NUMERIC;
  v_new_fat        NUMERIC;
  v_prior_delta_c  NUMERIC;      -- signed container delta of prior applied
  v_prior_servings NUMERIC;      -- servings of prior food_logs row
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required';
  END IF;

  -- Locate the Pi event.
  SELECT event_id, payload, resolved_lot_id, applied
    INTO v_event_id, v_payload, v_resolved_lot, v_applied
    FROM chefbyte.shelf_event_log
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;

  IF v_event_id IS NULL THEN
    RAISE EXCEPTION 'event not found: %', p_client_event_id;
  END IF;

  v_orig_product  := NULLIF(v_payload->>'product_id','')::UUID;
  v_orig_delta_g  := (v_payload->>'delta_g')::NUMERIC;
  v_orig_kind     := v_payload->>'kind';
  v_orig_ek       := v_payload->>'event_kind';
  v_orig_occurred := (v_payload->>'occurred_at')::TIMESTAMPTZ;

  IF v_orig_product IS NULL THEN
    RAISE EXCEPTION 'event has no product_id — cannot reconcile';
  END IF;

  -- Pull product macro/weight.
  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = v_orig_product AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product not found for event';
  END IF;
  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    RAISE EXCEPTION 'product missing net_weight_g';
  END IF;

  -- Logical date preserved from original occurred_at.
  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = v_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(v_orig_occurred, v_tz, v_dsh);

  -- Fetch prior override (if any) BEFORE we UPSERT. Drives back-out math.
  SELECT * INTO v_prior
    FROM chefbyte.event_overrides
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;
  v_prior_found := FOUND;

  -- ---- STEP 1: back out the previously-applied effect ----
  -- If there's a prior override, "previous applied" = that override's
  --   effective values (or nothing, if prior was voided or macro-off /
  --   stock-unchanged).
  -- If no prior override, "previous applied" = Pi's original apply
  --   (but only if the event was applied=true, i.e. resolved_lot_id set).

  IF v_prior_found THEN
    -- Prior was not voided → it actually mutated cloud state.
    IF NOT v_prior.is_voided THEN
      -- Stock side of prior override.
      v_prior_delta_c := COALESCE(v_prior.stock_qty_override, v_orig_delta_g / v_net_g);
      IF v_resolved_lot IS NOT NULL AND v_prior_delta_c IS NOT NULL THEN
        UPDATE chefbyte.stock_lots
           SET qty_containers = GREATEST(qty_containers - v_prior_delta_c, 0),
               last_update_source = 'manual',
               last_update_ts = now()
         WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
      END IF;
      -- Macro side: delete all food_logs rows tagged to this event.
      -- Covers both the original Pi-written row (if it survived the
      -- first override) and any prior override-written row. Idempotent.
      DELETE FROM chefbyte.food_logs
       WHERE user_id = v_user_id
         AND source_client_event_id = p_client_event_id;
    END IF;
    -- If prior was voided, the Pi-original had ALREADY been backed out
    -- on the prior apply; nothing more to undo here.
  ELSE
    -- No prior override. Back out the Pi-original effect, but only if
    -- the event actually applied cloud state.
    IF v_applied AND v_resolved_lot IS NOT NULL THEN
      -- Original delta_c — sign convention same as apply_shelf_event.
      v_prior_delta_c := v_orig_delta_g / v_net_g;
      UPDATE chefbyte.stock_lots
         SET qty_containers = GREATEST(qty_containers - v_prior_delta_c, 0),
             last_update_source = 'manual',
             last_update_ts = now()
       WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
    END IF;
    -- Delete the original apply_shelf_event-written food_logs row
    -- (tagged with source_client_event_id = p_client_event_id).
    DELETE FROM chefbyte.food_logs
     WHERE user_id = v_user_id
       AND source_client_event_id = p_client_event_id;
  END IF;

  -- ---- STEP 2: UPSERT the override row ----
  INSERT INTO chefbyte.event_overrides (
    user_id, client_event_id,
    stock_qty_override, macros_servings_override,
    calories_override, protein_override, carbs_override, fat_override,
    macro_logging_enabled, is_voided, updated_at
  ) VALUES (
    v_user_id, p_client_event_id,
    p_stock_qty_override, p_macros_servings_override,
    p_calories_override, p_protein_override, p_carbs_override, p_fat_override,
    COALESCE(p_macro_logging_enabled, TRUE), COALESCE(p_is_voided, FALSE), now()
  )
  ON CONFLICT (user_id, client_event_id) DO UPDATE SET
    stock_qty_override       = EXCLUDED.stock_qty_override,
    macros_servings_override = EXCLUDED.macros_servings_override,
    calories_override        = EXCLUDED.calories_override,
    protein_override         = EXCLUDED.protein_override,
    carbs_override           = EXCLUDED.carbs_override,
    fat_override             = EXCLUDED.fat_override,
    macro_logging_enabled    = EXCLUDED.macro_logging_enabled,
    is_voided                = EXCLUDED.is_voided,
    updated_at               = now()
  RETURNING override_id INTO v_override_id;

  -- ---- STEP 3: if voided, stop (stock+macros already backed out) ----
  IF COALESCE(p_is_voided, FALSE) THEN
    RETURN v_override_id;
  END IF;

  -- ---- STEP 4: re-apply effective stock delta ----
  v_new_delta_c := COALESCE(p_stock_qty_override, v_orig_delta_g / v_net_g);
  IF v_resolved_lot IS NOT NULL AND v_new_delta_c IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers = GREATEST(qty_containers + v_new_delta_c, 0),
           last_update_source = 'manual',
           last_update_ts = now()
     WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
  END IF;

  -- ---- STEP 5: re-insert food_logs row (if macro logging on and consumption) ----
  IF COALESCE(p_macro_logging_enabled, TRUE)
     AND v_orig_ek IN ('consumed','depleted') THEN
    -- Servings: override wins, else derive from effective delta_c.
    v_new_servings := COALESCE(
      p_macros_servings_override,
      ABS(v_new_delta_c) * COALESCE(v_svg_per, 0)
    );
    IF v_new_servings > 0 THEN
      -- kcal/C/P/F: override wins per-field, else derived from servings.
      v_new_cal     := COALESCE(p_calories_override, v_new_servings * COALESCE(v_cal,     0));
      v_new_carbs   := COALESCE(p_carbs_override,    v_new_servings * COALESCE(v_carbs,   0));
      v_new_protein := COALESCE(p_protein_override,  v_new_servings * COALESCE(v_protein, 0));
      v_new_fat     := COALESCE(p_fat_override,      v_new_servings * COALESCE(v_fat,     0));

      -- Tag with source_client_event_id so the next edit can delete
      -- this row cleanly (see back-out branch above).
      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit,
         calories, carbs, protein, fat, source_client_event_id)
      VALUES
        (v_user_id, v_orig_product, v_logical_date, v_new_servings, 'serving',
         v_new_cal, v_new_carbs, v_new_protein, v_new_fat, p_client_event_id);
    END IF;
  END IF;

  RETURN v_override_id;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
) FROM PUBLIC;

-- Public wrapper in chefbyte schema. Schema `private` isn't granted to
-- authenticated (see 20260302014004), so callers need a wrapper in an
-- exposed schema. The function is SECURITY DEFINER inside private; the
-- wrapper is SECURITY INVOKER and just forwards (auth.uid() still
-- resolves correctly because the wrapper runs as the caller).

CREATE OR REPLACE FUNCTION chefbyte.apply_event_override(
  p_client_event_id        TEXT,
  p_stock_qty_override     NUMERIC DEFAULT NULL,
  p_macros_servings_override NUMERIC DEFAULT NULL,
  p_calories_override      NUMERIC DEFAULT NULL,
  p_protein_override       NUMERIC DEFAULT NULL,
  p_carbs_override         NUMERIC DEFAULT NULL,
  p_fat_override           NUMERIC DEFAULT NULL,
  p_macro_logging_enabled  BOOLEAN DEFAULT TRUE,
  p_is_voided              BOOLEAN DEFAULT FALSE
) RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.apply_event_override(
    p_client_event_id,
    p_stock_qty_override,
    p_macros_servings_override,
    p_calories_override,
    p_protein_override,
    p_carbs_override,
    p_fat_override,
    p_macro_logging_enabled,
    p_is_voided
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN
) TO authenticated;
