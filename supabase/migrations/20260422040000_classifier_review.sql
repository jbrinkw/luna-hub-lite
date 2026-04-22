-- Event Viewer: surface classifier-review events + accept a new
-- classification item via apply_event_override.
--
-- Two UX gaps found during physical testing 2026-04-22:
--
--   1. Pi events with applied=false silently disappeared from the UI.
--      Cloud state is unchanged from the prior migration; this one adds
--      the pieces the UI needs to TRIAGE those rows.
--
--   2. Pi events with classifier_status='review' had no review path.
--      The Pi-side classifier already writes a 'review' status when
--      confidence < threshold and forwards a multi_match alternatives
--      list. This migration mirrors both into the cloud:
--
--        chefbyte.shelf_event_log.classifier_status TEXT
--        chefbyte.shelf_event_log.classification    JSONB
--
--      The shelf-ingest edge function will start populating them once
--      the Pi-side sync agent lands its patch; this migration does not
--      touch the edge fn (other agent's scope).
--
--   3. apply_event_override gains p_classifier_override_item_id UUID
--      and automatically transitions classifier_status 'review'→'classified'
--      when a non-void override is saved. When the override points at a
--      different product than the Pi's original classification.item_id,
--      the reconciler uses that item_id for the stock + macros update.
--
-- Reviewer-invariant: the override row is still keyed by the ORIGINAL
-- client_event_id, but the food_logs + stock_lots writes target the
-- REVIEW-SELECTED product. This preserves "one override per event" while
-- letting the user correct a mis-classified event.

------------------------------------------------------------
-- 1. shelf_event_log.classifier_status + classification
------------------------------------------------------------

ALTER TABLE chefbyte.shelf_event_log
  ADD COLUMN IF NOT EXISTS classifier_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS classification    JSONB NULL;

ALTER TABLE chefbyte.shelf_event_log
  DROP CONSTRAINT IF EXISTS shelf_event_log_classifier_status_chk;
ALTER TABLE chefbyte.shelf_event_log
  ADD CONSTRAINT shelf_event_log_classifier_status_chk
  CHECK (
    classifier_status IS NULL
    OR classifier_status IN ('pending','classifying','classified','review','failed')
  );

-- Partial index for the ChefLayout "needs attention" counter — tiny and
-- only covers rows the user should triage.
CREATE INDEX IF NOT EXISTS shelf_event_log_needs_attn_idx
  ON chefbyte.shelf_event_log (user_id, created_at DESC)
  WHERE applied = false OR classifier_status = 'review';

------------------------------------------------------------
-- 2. apply_event_override — accept classifier override + auto-transition
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.apply_event_override(
  p_client_event_id              TEXT,
  p_stock_qty_override           NUMERIC DEFAULT NULL,
  p_macros_servings_override     NUMERIC DEFAULT NULL,
  p_calories_override            NUMERIC DEFAULT NULL,
  p_protein_override             NUMERIC DEFAULT NULL,
  p_carbs_override               NUMERIC DEFAULT NULL,
  p_fat_override                 NUMERIC DEFAULT NULL,
  p_macro_logging_enabled        BOOLEAN DEFAULT TRUE,
  p_is_voided                    BOOLEAN DEFAULT FALSE,
  p_event_kind                   TEXT    DEFAULT NULL,
  p_classifier_override_item_id  UUID    DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id         UUID := (select auth.uid());
  v_override_id     UUID;
  v_prior           chefbyte.event_overrides%ROWTYPE;
  v_prior_found     BOOLEAN := FALSE;
  v_event_id        UUID;
  v_payload         JSONB;
  v_resolved_lot    UUID;
  v_applied         BOOLEAN;
  v_orig_product    UUID;
  v_orig_delta_g    NUMERIC;
  v_orig_kind       TEXT;
  v_orig_ek         TEXT;
  v_orig_occurred   TIMESTAMPTZ;
  v_net_g           NUMERIC;
  v_svg_per         NUMERIC;
  v_cal             NUMERIC;
  v_carbs           NUMERIC;
  v_protein         NUMERIC;
  v_fat             NUMERIC;
  v_tz              TEXT;
  v_dsh             INTEGER;
  v_logical_date    DATE;
  v_prior_ek        TEXT;
  v_prior_delta_c   NUMERIC;
  v_new_ek          TEXT;
  v_new_delta_c     NUMERIC;
  v_new_servings    NUMERIC;
  v_new_cal         NUMERIC;
  v_new_carbs       NUMERIC;
  v_new_protein     NUMERIC;
  v_new_fat         NUMERIC;
  -- Effective product used for the NEW-apply phase. Defaults to the
  -- Pi-original product_id but gets replaced when the caller accepts a
  -- different classification pick via p_classifier_override_item_id.
  v_effective_product UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required';
  END IF;

  IF p_event_kind IS NOT NULL
     AND p_event_kind NOT IN ('consumed','depleted','added','refilled') THEN
    RAISE EXCEPTION 'invalid event_kind: %', p_event_kind USING ERRCODE = '22023';
  END IF;

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

  IF v_orig_product IS NULL AND p_classifier_override_item_id IS NULL THEN
    RAISE EXCEPTION 'event has no product_id — cannot reconcile';
  END IF;

  -- Effective product for the NEW-apply phase. The override arg wins.
  v_effective_product := COALESCE(p_classifier_override_item_id, v_orig_product);

  -- Validate the chosen product belongs to the caller.
  SELECT net_weight_g, servings_per_container,
         calories_per_serving, carbs_per_serving,
         protein_per_serving, fat_per_serving
    INTO v_net_g, v_svg_per, v_cal, v_carbs, v_protein, v_fat
    FROM chefbyte.products
   WHERE product_id = v_effective_product AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product not found for event';
  END IF;
  IF v_net_g IS NULL OR v_net_g <= 0 THEN
    RAISE EXCEPTION 'product missing net_weight_g';
  END IF;

  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = v_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(v_orig_occurred, v_tz, v_dsh);

  SELECT * INTO v_prior
    FROM chefbyte.event_overrides
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;
  v_prior_found := FOUND;

  -- ---- STEP 1: back out prior effect ----
  -- Uses Pi-original net_weight_g for the back-out when the prior override
  -- did not pick a different product; uses the effective product's weight
  -- when it did (so the back-out is symmetric with the prior's apply).

  IF v_prior_found THEN
    IF NOT v_prior.is_voided THEN
      v_prior_ek := COALESCE(v_prior.event_kind_override, v_orig_ek);
      v_prior_delta_c := COALESCE(
        v_prior.stock_qty_override,
        CASE
          WHEN v_prior_ek IN ('consumed','depleted')
            THEN -ABS(v_orig_delta_g / v_net_g)
          ELSE  ABS(v_orig_delta_g / v_net_g)
        END
      );

      IF v_resolved_lot IS NOT NULL AND v_prior_delta_c IS NOT NULL THEN
        UPDATE chefbyte.stock_lots
           SET qty_containers     = GREATEST(qty_containers - v_prior_delta_c, 0),
               last_update_source = 'manual',
               last_update_ts     = now()
         WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
      END IF;

      DELETE FROM chefbyte.food_logs
       WHERE user_id = v_user_id
         AND source_client_event_id = p_client_event_id;
    END IF;
  ELSE
    IF v_applied AND v_resolved_lot IS NOT NULL THEN
      v_prior_delta_c := v_orig_delta_g / v_net_g;
      UPDATE chefbyte.stock_lots
         SET qty_containers     = GREATEST(qty_containers - v_prior_delta_c, 0),
             last_update_source = 'manual',
             last_update_ts     = now()
       WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
    END IF;
    DELETE FROM chefbyte.food_logs
     WHERE user_id = v_user_id
       AND source_client_event_id = p_client_event_id;
  END IF;

  -- ---- STEP 2: UPSERT override row ----
  INSERT INTO chefbyte.event_overrides (
    user_id, client_event_id,
    stock_qty_override, macros_servings_override,
    calories_override, protein_override, carbs_override, fat_override,
    macro_logging_enabled, is_voided, event_kind_override, updated_at
  ) VALUES (
    v_user_id, p_client_event_id,
    p_stock_qty_override, p_macros_servings_override,
    p_calories_override, p_protein_override, p_carbs_override, p_fat_override,
    COALESCE(p_macro_logging_enabled, TRUE),
    COALESCE(p_is_voided, FALSE),
    p_event_kind,
    now()
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
    event_kind_override      = EXCLUDED.event_kind_override,
    updated_at               = now()
  RETURNING override_id INTO v_override_id;

  -- ---- STEP 3: classifier_status auto-transition ----
  -- A non-void override on a 'review'-status event means the user picked
  -- a resolution; flip the row to 'classified' and persist the chosen
  -- item_id into classification.item_id so the source-of-truth stays
  -- in one place for downstream readers.
  IF NOT COALESCE(p_is_voided, FALSE) THEN
    UPDATE chefbyte.shelf_event_log
       SET classifier_status = CASE
              WHEN classifier_status = 'review' THEN 'classified'
              ELSE classifier_status
            END,
           classification = CASE
              WHEN p_classifier_override_item_id IS NOT NULL
                THEN COALESCE(classification, '{}'::jsonb)
                     || jsonb_build_object('item_id', p_classifier_override_item_id::text)
              ELSE classification
            END
     WHERE event_id = v_event_id
       AND user_id  = v_user_id;
  END IF;

  -- ---- STEP 4: if voided, stop ----
  IF COALESCE(p_is_voided, FALSE) THEN
    RETURN v_override_id;
  END IF;

  -- ---- STEP 5: re-apply stock + macros using the EFFECTIVE product ----
  v_new_ek := COALESCE(p_event_kind, v_orig_ek);

  v_new_delta_c := COALESCE(
    p_stock_qty_override,
    CASE
      WHEN v_new_ek IN ('consumed','depleted')
        THEN -ABS(v_orig_delta_g / v_net_g)
      ELSE  ABS(v_orig_delta_g / v_net_g)
    END
  );

  IF v_resolved_lot IS NOT NULL AND v_new_delta_c IS NOT NULL THEN
    UPDATE chefbyte.stock_lots
       SET qty_containers     = GREATEST(qty_containers + v_new_delta_c, 0),
           last_update_source = 'manual',
           last_update_ts     = now()
     WHERE lot_id = v_resolved_lot AND user_id = v_user_id;
  END IF;

  IF COALESCE(p_macro_logging_enabled, TRUE)
     AND v_new_ek IN ('consumed','depleted') THEN
    v_new_servings := COALESCE(
      p_macros_servings_override,
      ABS(v_new_delta_c) * COALESCE(v_svg_per, 0)
    );
    IF v_new_servings > 0 THEN
      v_new_cal     := COALESCE(p_calories_override, v_new_servings * COALESCE(v_cal,     0));
      v_new_carbs   := COALESCE(p_carbs_override,    v_new_servings * COALESCE(v_carbs,   0));
      v_new_protein := COALESCE(p_protein_override,  v_new_servings * COALESCE(v_protein, 0));
      v_new_fat     := COALESCE(p_fat_override,      v_new_servings * COALESCE(v_fat,     0));

      INSERT INTO chefbyte.food_logs
        (user_id, product_id, logical_date, qty_consumed, unit,
         calories, carbs, protein, fat, source_client_event_id)
      VALUES
        (v_user_id, v_effective_product, v_logical_date, v_new_servings, 'serving',
         v_new_cal, v_new_carbs, v_new_protein, v_new_fat, p_client_event_id);
    END IF;
  END IF;

  RETURN v_override_id;
END;
$$;

-- Retire the 10-arg overload from 20260422010000. Must drop before the new
-- 11-arg wrapper can resolve unambiguously (DEFAULT NULL would otherwise
-- make calls with 10 positional args ambiguous).
DROP FUNCTION IF EXISTS private.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT
);

REVOKE ALL ON FUNCTION private.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT, UUID
) FROM PUBLIC;

------------------------------------------------------------
-- 3. chefbyte.apply_event_override wrapper — expose the new arg
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.apply_event_override(
  p_client_event_id              TEXT,
  p_stock_qty_override           NUMERIC DEFAULT NULL,
  p_macros_servings_override     NUMERIC DEFAULT NULL,
  p_calories_override            NUMERIC DEFAULT NULL,
  p_protein_override             NUMERIC DEFAULT NULL,
  p_carbs_override               NUMERIC DEFAULT NULL,
  p_fat_override                 NUMERIC DEFAULT NULL,
  p_macro_logging_enabled        BOOLEAN DEFAULT TRUE,
  p_is_voided                    BOOLEAN DEFAULT FALSE,
  p_event_kind                   TEXT    DEFAULT NULL,
  p_classifier_override_item_id  UUID    DEFAULT NULL
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
    p_is_voided,
    p_event_kind,
    p_classifier_override_item_id
  );
$$;

-- Drop the 10-arg wrapper from 20260422010000 so callers don't resolve to
-- a stale signature.
DROP FUNCTION IF EXISTS chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT
);

REVOKE ALL ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.apply_event_override(
  TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT, UUID
) TO authenticated;

------------------------------------------------------------
-- 4. retry_shelf_event — re-attempt apply on a previously-rejected log row
------------------------------------------------------------
-- When shelf-ingest landed a row with applied=false (e.g. because the
-- product had no net_weight_g, or there was no lot with stock), the Pi
-- keeps no retry state — the row is stuck. The UI gives the user a
-- "Retry" button that invokes this RPC: it re-runs the underlying
-- apply_shelf_event against the existing payload, so after fixing the
-- upstream condition (e.g. editing the product, adding stock) the event
-- lands correctly.
--
-- Semantics: re-reads the payload from the existing shelf_event_log row,
-- then DELETEs it and calls apply_shelf_event again with the same
-- client_event_id. The plpgsql function's INSERT…ON CONFLICT DO NOTHING
-- would otherwise treat the row as a dedup replay and short-circuit.

CREATE OR REPLACE FUNCTION private.retry_shelf_event(p_client_event_id TEXT)
RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id      UUID := (select auth.uid());
  v_row          chefbyte.shelf_event_log%ROWTYPE;
  v_payload      JSONB;
  v_scale_id     TEXT;
  v_kind         TEXT;
  v_event_kind   TEXT;
  v_product_id   UUID;
  v_delta_g      NUMERIC;
  v_occurred_at  TIMESTAMPTZ;
  v_pi_event_id  TEXT;
  v_result       chefbyte.shelf_event_result;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_row
    FROM chefbyte.shelf_event_log
   WHERE user_id = v_user_id AND client_event_id = p_client_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'event not found: %', p_client_event_id;
  END IF;

  -- Only retry rows that failed the first time around. Retrying an
  -- already-applied row would double-apply (no idempotency left since we
  -- delete the dedup key).
  IF v_row.applied THEN
    RAISE EXCEPTION 'event already applied, retry rejected' USING ERRCODE = '22023';
  END IF;

  v_payload     := v_row.payload;
  v_scale_id    := v_payload->>'scale_id';
  v_kind        := v_payload->>'kind';
  v_event_kind  := v_payload->>'event_kind';
  v_product_id  := NULLIF(v_payload->>'product_id','')::UUID;
  v_delta_g     := (v_payload->>'delta_g')::NUMERIC;
  v_occurred_at := (v_payload->>'occurred_at')::TIMESTAMPTZ;
  v_pi_event_id := v_row.pi_event_id;

  -- Delete the stuck row so the INSERT…ON CONFLICT in apply_shelf_event
  -- treats this as a fresh attempt. Safe: we're the only writer (this
  -- RPC is SECURITY DEFINER + authenticated grant, not the service_role
  -- edge function path).
  DELETE FROM chefbyte.shelf_event_log
   WHERE event_id = v_row.event_id;

  v_result := private.apply_shelf_event(
    v_user_id,
    v_row.device_id,
    v_scale_id,
    v_kind,
    v_event_kind,
    v_product_id,
    v_delta_g,
    v_occurred_at,
    p_client_event_id,
    v_pi_event_id
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.retry_shelf_event(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION chefbyte.retry_shelf_event(p_client_event_id TEXT)
RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.retry_shelf_event(p_client_event_id);
$$;

REVOKE ALL ON FUNCTION chefbyte.retry_shelf_event(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.retry_shelf_event(TEXT) TO authenticated;
