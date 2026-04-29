-- Sync-audit finding #6 — usage_kind discriminator on food_logs.
--
-- 2026-04-29.
--
-- BUG:
--   The Pi's ``usage_log.kind`` column distinguishes the provenance of
--   a consumption event: ``in_flight_ttl_expired``,
--   ``in_flight_return``, ``in_flight_replaced_new_item``,
--   ``reconciler_use_return``, ``single_item_consumed``. The cloud's
--   ``chefbyte.food_logs`` has no equivalent column — every consumed
--   apply_shelf_event branch writes a food_logs row tagged only by
--   ``source_client_event_id``. The provenance discriminator is lost
--   when the Pi syncs to cloud, so cloud-side analytics can't tell a
--   reconciler-driven retroactive consumption from a live in-flight
--   pickup, and the cloud Chef UI can't render the same ``r.kind``
--   filter the Pi inventory.html shows.
--
-- FIX (3 layers):
--
--   1. Add a nullable ``chefbyte.food_logs.usage_kind TEXT`` column
--      (this migration). No CHECK constraint at this stage — the Pi's
--      enum may grow and we don't want to land a CHECK that blocks
--      forward-compat. Existing rows stay NULL.
--
--   2. Add an optional ``p_usage_kind TEXT DEFAULT NULL`` parameter to
--      ``private.apply_shelf_event`` and stamp it onto every food_logs
--      INSERT in the consumed branches (consumed / depleted /
--      catch_all_second_measurement_consumed / pickup_close_whole_lot).
--      Splice via ``pg_get_functiondef`` to avoid re-emitting the ~1k
--      line function — same surgical pattern as 20260428050000 +
--      20260429010000. Adding a parameter to an existing function
--      requires DROP + CREATE OR REPLACE since CREATE OR REPLACE alone
--      can't change parameter lists; we DROP the canonical 10-arg here
--      and recreate as 11-arg with the param appended.
--
--   3. Refresh the ``chefbyte.apply_shelf_event_admin`` wrapper to
--      forward the new parameter to ``private.apply_shelf_event``.
--      Older edge-function deployments that don't pass ``p_usage_kind``
--      keep working — the DEFAULT NULL preserves backwards compat.
--
-- INVARIANT PRESERVED:
--   * Every existing food_logs INSERT branch writes the same column
--     set + values; only the new ``usage_kind`` column is added.
--   * Pi-emitted ``consumed`` events that don't carry ``usage_kind``
--     in their payload (older Pi binaries) land as
--     ``usage_kind = NULL`` — same shape as historical rows.
--   * No CHECK constraint, no FK — schema evolution stays cheap.
--
-- COMPANION TEST:
--   ``supabase/tests/chefbyte/food_logs_usage_kind.test.sql`` plants a
--   Pi-emitted consumed event with ``p_usage_kind='reconciler_use_return'``
--   and asserts the resulting food_logs row has the matching
--   ``usage_kind``. The mutation that drops the column from the
--   INSERT trips the assertion.

BEGIN;

------------------------------------------------------------
-- Layer 1: column on chefbyte.food_logs
------------------------------------------------------------

ALTER TABLE chefbyte.food_logs
  ADD COLUMN IF NOT EXISTS usage_kind TEXT;

-- Optional index — most analytics queries that filter by usage_kind
-- also filter by user_id+logical_date so a partial index on the rare
-- non-NULL rows keeps the cost low.
CREATE INDEX IF NOT EXISTS food_logs_usage_kind_idx
  ON chefbyte.food_logs (user_id, usage_kind)
  WHERE usage_kind IS NOT NULL;

------------------------------------------------------------
-- Layer 2: splice apply_shelf_event to add p_usage_kind + stamp it
------------------------------------------------------------

DO $patch$
DECLARE
  v_src             TEXT;
  v_old_param_block TEXT;
  v_new_param_block TEXT;
  v_old_insert      TEXT;
  v_new_insert      TEXT;
  v_old_count       INTEGER;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private'
     AND p.proname = 'apply_shelf_event';

  IF v_src IS NULL THEN
    RAISE EXCEPTION
      '20260429080000: private.apply_shelf_event not found — cannot patch';
  END IF;

  -- Idempotency check: if the new parameter is already present, this
  -- migration is a no-op (e.g. re-running on a freshly-reset DB where
  -- everything's already in place).
  IF position('p_usage_kind' IN v_src) > 0 THEN
    RAISE NOTICE
      '20260429080000: apply_shelf_event already has p_usage_kind, no-op';
    RETURN;
  END IF;

  ----------------------------------------------------------
  -- Splice 1: add the parameter to the signature.
  --
  -- ``pg_get_functiondef`` formats the arg list as
  -- ``..., p_pi_event_id text DEFAULT NULL::text)`` — lowercase types,
  -- no ``IN`` prefix, no alignment padding, ``::text`` cast on the
  -- DEFAULT literal. We match that exact shape so the splice is
  -- whitespace-stable across PG versions.
  ----------------------------------------------------------
  v_old_param_block := 'p_pi_event_id text DEFAULT NULL::text)';
  v_new_param_block := 'p_pi_event_id text DEFAULT NULL::text, '
                    || 'p_usage_kind text DEFAULT NULL::text)';

  IF position(v_old_param_block IN v_src) = 0 THEN
    RAISE EXCEPTION
      '20260429080000: parameter list shape did not match expected '
      '(looking for: %); pg_get_functiondef format may have shifted',
      v_old_param_block;
  END IF;

  v_src := replace(v_src, v_old_param_block, v_new_param_block);

  ----------------------------------------------------------
  -- Splice 2: rewrite every food_logs INSERT in the consumed
  -- branches. The 3 INSERTs share the same column list + values
  -- shape (only indentation differs). pg_get_functiondef emits the
  -- function body verbatim, so we splice the column+values fragment
  -- that's unique enough to match all three at once.
  --
  -- Old shape (column list):
  --   (user_id, product_id, logical_date, qty_consumed, unit,
  --    calories, carbs, protein, fat, source_client_event_id)
  --
  -- New shape:
  --   (user_id, product_id, logical_date, qty_consumed, unit,
  --    calories, carbs, protein, fat, source_client_event_id,
  --    usage_kind)
  --
  -- And the trailing values fragment ``p_client_event_id);`` becomes
  -- ``p_client_event_id, p_usage_kind);``. We require both splices to
  -- match the same number of times (3 in current source) so a future
  -- refactor can't silently drop a stamp by editing only one of the
  -- two halves.
  ----------------------------------------------------------
  v_old_insert :=
    '(user_id, product_id, logical_date, qty_consumed, unit, '
    || 'calories, carbs, protein, fat, source_client_event_id)';
  v_new_insert :=
    '(user_id, product_id, logical_date, qty_consumed, unit, '
    || 'calories, carbs, protein, fat, source_client_event_id, '
    || 'usage_kind)';

  -- pg_get_functiondef preserves whitespace; the column list spans two
  -- lines in source. Two known indent shapes — splice each.
  v_old_count := 0;
  DECLARE
    -- 9-space pre-``calories`` indent (catch_all_second_measurement +
    -- decremented branches — the parent IF block has 4-space + 2 = 6
    -- before INSERT, and the column-list ``calories`` is aligned 9
    -- under the row's open paren).
    v_two_line_old TEXT := E'(user_id, product_id, logical_date, qty_consumed, unit,\n         calories, carbs, protein, fat, source_client_event_id)';
    v_two_line_new TEXT := E'(user_id, product_id, logical_date, qty_consumed, unit,\n         calories, carbs, protein, fat, source_client_event_id,\n         usage_kind)';
    -- 11-space pre-``calories`` indent (pickup_close_whole_lot — nested
    -- one extra IF deep so the leading whitespace is bumped by 2).
    v_two_line_old_alt TEXT := E'(user_id, product_id, logical_date, qty_consumed, unit,\n           calories, carbs, protein, fat, source_client_event_id)';
    v_two_line_new_alt TEXT := E'(user_id, product_id, logical_date, qty_consumed, unit,\n           calories, carbs, protein, fat, source_client_event_id,\n           usage_kind)';
  BEGIN
    WHILE position(v_two_line_old IN v_src) > 0 LOOP
      v_src := overlay(v_src placing v_two_line_new
                       from position(v_two_line_old IN v_src)
                       for length(v_two_line_old));
      v_old_count := v_old_count + 1;
    END LOOP;
    WHILE position(v_two_line_old_alt IN v_src) > 0 LOOP
      v_src := overlay(v_src placing v_two_line_new_alt
                       from position(v_two_line_old_alt IN v_src)
                       for length(v_two_line_old_alt));
      v_old_count := v_old_count + 1;
    END LOOP;
  END;

  IF v_old_count = 0 THEN
    RAISE EXCEPTION
      '20260429080000: food_logs INSERT column-list shape not found in '
      'apply_shelf_event source — schema drift suspected';
  END IF;

  -- Now splice the values list trailing fragment for every INSERT we
  -- found. The trailing token ``p_client_event_id);`` is unique to
  -- food_logs INSERTs in the consumed branches; other call sites of
  -- ``p_client_event_id`` end with different punctuation
  -- (``p_client_event_id\n`` or ``p_client_event_id ::TEXT``).
  DECLARE
    v_values_old TEXT := 'p_client_event_id);';
    v_values_new TEXT := 'p_client_event_id, p_usage_kind);';
    v_values_count INTEGER := 0;
  BEGIN
    WHILE position(v_values_old IN v_src) > 0 LOOP
      v_src := overlay(v_src placing v_values_new
                       from position(v_values_old IN v_src)
                       for length(v_values_old));
      v_values_count := v_values_count + 1;
    END LOOP;
    IF v_values_count <> v_old_count THEN
      RAISE EXCEPTION
        '20260429080000: column-list / values-list splice count mismatch '
        '(columns=%, values=%) — function body shape unexpected; aborting '
        'to avoid a half-spliced INSERT', v_old_count, v_values_count;
    END IF;
  END;

  ----------------------------------------------------------
  -- DROP the existing canonical 10-arg, then EXECUTE the new
  -- 11-arg source. CREATE OR REPLACE FUNCTION cannot change the
  -- parameter list, so a clean DROP + recreate is required.
  -- The drop is safe because chefbyte.apply_shelf_event_admin (the
  -- only direct caller) is refreshed below in the same transaction.
  ----------------------------------------------------------
  DROP FUNCTION private.apply_shelf_event(
    UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
  );
  EXECUTE v_src;
END
$patch$;

------------------------------------------------------------
-- Layer 3: refresh chefbyte.apply_shelf_event_admin wrapper
------------------------------------------------------------

DROP FUNCTION IF EXISTS chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
);

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
  p_pi_event_id     TEXT DEFAULT NULL,
  p_usage_kind      TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_shelf_event(
    p_user_id, p_device_id, p_scale_id, p_kind,
    p_event_kind, p_product_id, p_delta_g, p_occurred_at,
    p_client_event_id, p_pi_event_id, p_usage_kind
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.apply_shelf_event_admin(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shelf_event(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
