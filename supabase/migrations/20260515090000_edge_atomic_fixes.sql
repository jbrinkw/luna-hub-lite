-- ════════════════════════════════════════════════════════════════════════════
-- Edge-function non-atomic cluster — deep-audit findings H-7, H-8 (theme T6)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Theme T6: "Non-atomic read-modify-write / two-round-trip transactions".
-- The walmart path (private.walmart_check_and_increment, 20260429040000) is the
-- canonical reference: gate + increment INSIDE one SQL statement, FOR UPDATE,
-- col = col + 1.
--
-- ── H-7 — analyze-product daily quota bypass ────────────────────────────────
-- analyze-product/index.ts::checkQuota did a CLIENT-side read-modify-write:
--   SELECT value → JSON.parse(count) → if (count >= 100) return false
--   → upsert({count: count + 1})        (an ABSOLUTE JS-computed value)
-- Two concurrent requests both read count=99, both pass the gate, both upsert
-- 100 → the 100/user/day platform-paid-LLM cap is bypassed.
--
-- Fix: private.analyze_check_and_increment(p_user_id, p_quota) ports the
-- walmart atomic pattern but PRESERVES analyze-product's existing storage:
--   * counter lives in chefbyte.user_config, key='analyze_quota',
--     value = JSON text {"date": "YYYY-MM-DD", "count": N}
--   * keyed on the UTC calendar date (matches the edge fn's
--     `new Date().toISOString().slice(0,10)` + the walmart UTC-billing window)
--   * stale-date row (yesterday) RESETS count to 0 before the gate, preserving
--     the edge fn's "resets on a new day" behavior
-- The gate is enforced in SQL: at the cap the function RETURNS allowed=false
-- WITHOUT incrementing past the limit. The edge fn calls this AFTER the OFF
-- lookup succeeds (charge-after-OFF timing unchanged — the RPC is just the new
-- atomic implementation of the same check that already ran post-OFF).
--
-- ── H-8 — shelf-ingest stock mutation commits before the audit row ──────────
-- shelf-ingest/index.ts::handleBarcodeScan called execute_scan_action (1 txn,
-- commits the stock mutation) then INSERTed scan_transactions (a SEPARATE
-- PostgREST txn). If the audit insert failed (e.g. an invalid `unit` hitting
-- the scan_transactions CHECK), the stock RPC had already committed and the
-- 500 path wrote NO idempotency row → on Pi retry the idempotency SELECT found
-- nothing → execute_scan_action re-ran → double mint / double consume.
--
-- Fix (single-transaction RPC — the "fold both into ONE txn" option): a new
-- private.execute_scan_and_record(...) calls execute_scan_action AND inserts
-- the matching scan_transactions row in the SAME function (one txn). The
-- applied audit row commits atomically with the stock mutation, so a Pi retry
-- always observes the prior result via the (user_id, pi_event_id) unique index.
-- On an in-RPC failure (bad input, conflict) NOTHING commits, so a retry safely
-- re-runs exactly once. The `unit` CHECK is also enforced at the edge BEFORE
-- any call (defense-in-depth — see shelf-ingest/index.ts).
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- H-7 — private.analyze_check_and_increment(uuid, int)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.analyze_check_and_increment(
  p_user_id UUID,
  p_quota   INT DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- UTC calendar date — matches the edge fn's prior
  -- `new Date().toISOString().slice(0,10)` and the walmart UTC window.
  v_today TEXT := (now() AT TIME ZONE 'UTC')::date::text;
  v_count INT;
  v_value JSONB;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required';
  END IF;
  IF p_quota <= 0 THEN
    RAISE EXCEPTION 'p_quota must be positive';
  END IF;

  -- Step 1 — upsert-normalize: insert a fresh {today, 0} row if absent,
  -- else reset to {today, 0} only when the stored date is stale. When the
  -- stored date is already today, the row is left untouched. The ON CONFLICT
  -- target (user_id, key) matches chefbyte.user_config's UNIQUE (user_id, key),
  -- so concurrent callers serialize on the same row here.
  INSERT INTO chefbyte.user_config AS uc (user_id, key, value)
  VALUES (
    p_user_id,
    'analyze_quota',
    jsonb_build_object('date', v_today, 'count', 0)::text
  )
  ON CONFLICT (user_id, key) DO UPDATE
    SET value = CASE
                  WHEN COALESCE(uc.value::jsonb->>'date', '') <> v_today
                    THEN jsonb_build_object('date', v_today, 'count', 0)::text
                  ELSE uc.value
                END;

  -- Step 2 — lock + re-read the now-normalized row (mirrors the walmart
  -- FOR UPDATE re-read). A malformed/legacy value JSON is treated as a fresh
  -- counter (count := 0), matching the edge fn's prior try/catch-resets-counter
  -- behavior.
  SELECT value::jsonb INTO v_value
    FROM chefbyte.user_config
   WHERE user_id = p_user_id AND key = 'analyze_quota'
   FOR UPDATE;

  BEGIN
    v_count := COALESCE((v_value->>'count')::int, 0);
  EXCEPTION WHEN others THEN
    v_count := 0;
  END;

  -- Step 3 — gate IN SQL. At/over the cap: refuse WITHOUT incrementing past
  -- the limit (the H-7 fix — the absolute-write race can no longer leak).
  IF v_count >= p_quota THEN
    RETURN jsonb_build_object(
      'allowed',   false,
      'used',      v_count,
      'remaining', 0,
      'limit',     p_quota
    );
  END IF;

  -- Under the cap — atomic increment (count = count + 1) on the locked row.
  v_count := v_count + 1;
  UPDATE chefbyte.user_config
     SET value = jsonb_build_object('date', v_today, 'count', v_count)::text
   WHERE user_id = p_user_id AND key = 'analyze_quota';

  RETURN jsonb_build_object(
    'allowed',   true,
    'used',      v_count,
    'remaining', p_quota - v_count,
    'limit',     p_quota
  );
END;
$$;

GRANT EXECUTE ON FUNCTION private.analyze_check_and_increment(UUID, INT) TO service_role;

COMMENT ON FUNCTION private.analyze_check_and_increment(UUID, INT) IS
  'Atomic per-user/per-UTC-day quota check+increment for analyze-product (H-7). '
  'Stores {date,count} JSON in chefbyte.user_config key=analyze_quota. Gate is '
  'enforced in SQL: at the cap returns allowed=false WITHOUT over-incrementing. '
  'Replaces the edge fn''s non-atomic read-modify-write. Mirrors '
  'private.walmart_check_and_increment. service_role only (dual-auth edge fn).';

-- ─────────────────────────────────────────────────────────────────
-- H-7 — chefbyte.analyze_check_and_increment(uuid, int)  [PostgREST wrapper]
-- ─────────────────────────────────────────────────────────────────
-- PostgREST exposes only (public, graphql_public, hub, coachbyte, chefbyte)
-- per supabase/config.toml; a direct .schema('private').rpc() returns PGRST106.
-- Thin SECURITY DEFINER pass-through (mirrors walmart_check_and_increment's
-- chefbyte wrapper, 20260429070000). analyze-product's dual-auth means BOTH
-- the browser (authenticated JWT) and the service-role forwarder hit this
-- wrapper, so EXECUTE is granted to authenticated AND service_role.
--
-- T2 lockdown convention (the prompt asks for it on any newly-exposed wrapper
-- that takes p_user_id): because EXECUTE is granted to `authenticated` and the
-- function takes a `p_user_id`, an authenticated attacker could otherwise call
-- it with a VICTIM's user_id to inflate the victim's daily quota counter (a
-- cross-tenant DoS — exhaust someone else's analyze budget). SECURITY DEFINER
-- bypasses RLS, and the inner counter trusts p_user_id, so we add the same
-- in-body auth.uid() guard as 20260515020000: an authenticated caller may only
-- bump THEIR OWN counter (p_user_id must equal auth.uid()); the service-role
-- path (auth.uid() IS NULL) passes through with the explicit p_user_id the edge
-- fn resolved. This is stricter than the pre-T2 walmart wrapper on purpose.
CREATE OR REPLACE FUNCTION chefbyte.analyze_check_and_increment(
  p_user_id UUID,
  p_quota   INT DEFAULT 100
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL
     AND p_user_id IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must equal auth.uid()'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN private.analyze_check_and_increment(p_user_id, p_quota);
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.analyze_check_and_increment(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.analyze_check_and_increment(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.analyze_check_and_increment(UUID, INT) TO service_role;

COMMENT ON FUNCTION chefbyte.analyze_check_and_increment(UUID, INT) IS
  'PostgREST-callable wrapper for private.analyze_check_and_increment (H-7). '
  'analyze-product invokes via /rest/v1/rpc/analyze_check_and_increment with '
  'content-profile=chefbyte. auth.uid() guard: authenticated callers may only '
  'bump their own counter; service_role passes the explicit p_user_id. [T2]';

-- ─────────────────────────────────────────────────────────────────
-- H-8 — private.execute_scan_and_record(...)
-- ─────────────────────────────────────────────────────────────────
-- Folds the stock mutation (execute_scan_action) AND the scan_transactions
-- audit insert into ONE transaction. Returns the SAME JSONB shape the edge fn
-- previously built by hand after the two-step, plus the recorded
-- transaction_id, so the Pi response is unchanged.
--
-- Atomicity guarantee: if execute_scan_action commits a stock mutation but the
-- audit row can't be written, the whole function aborts and NOTHING commits, so
-- a Pi retry re-runs exactly once. On success, the applied audit row carries
-- pi_event_id and commits with the mutation, so the unique index
-- (user_id, pi_event_id) makes the retry idempotent at the edge SELECT.
--
-- logical_date is resolved via the canonical get_logical_date(profile.tz, dsh)
-- — NOT raw UTC (a side fix that also closes the TZ-02/03 audit-vs-macro
-- ledger split called out in H-19 for the scan_transactions.logical_date
-- stamp). The edge fn previously stamped raw `new Date().toISOString()`.
CREATE OR REPLACE FUNCTION private.execute_scan_and_record(
  p_user_id            UUID,
  p_product_id         UUID,
  p_barcode            TEXT,
  p_mode               TEXT,
  p_qty                NUMERIC,
  p_unit               TEXT,
  p_nutrition_snapshot JSONB,
  p_source             TEXT,
  p_pi_event_id        TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tz             TEXT;
  v_dsh            INTEGER;
  v_logical_date   DATE;
  v_action         JSONB;
  v_lot_id         UUID;
  v_food_log_id    UUID;
  v_cart_item_id   UUID;
  v_tx_id          UUID;
BEGIN
  -- Defense-in-depth: the scan_transactions CHECK only allows
  -- {container, serving}; reject anything else BEFORE the mutation so a bad
  -- unit can never commit a stock change that the audit insert would then
  -- reject (the original H-8 partial-apply). The edge fn validates first too.
  IF p_unit IS NOT NULL AND p_unit NOT IN ('container', 'serving') THEN
    RAISE EXCEPTION 'invalid unit: % (expected container or serving)', p_unit
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('web', 'pi_usb') THEN
    RAISE EXCEPTION 'invalid source: % (expected web or pi_usb)', p_source
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve logical_date from the user's profile (same primitive
  -- execute_scan_action uses for food_logs).
  SELECT timezone, day_start_hour INTO v_tz, v_dsh
    FROM hub.profiles WHERE user_id = p_user_id;
  IF v_tz  IS NULL THEN v_tz  := 'UTC'; END IF;
  IF v_dsh IS NULL THEN v_dsh := 0;     END IF;
  v_logical_date := private.get_logical_date(now(), v_tz, v_dsh);

  -- Apply the scan (purchase / consume_* / shopping). Raises on bad
  -- product / no location / etc — propagates so the edge fn writes an
  -- errored row in its own catch (nothing has committed yet).
  v_action := private.execute_scan_action(
    p_user_id, p_product_id, p_mode, p_qty, p_unit, p_nutrition_snapshot
  );

  v_lot_id       := (v_action->>'applied_lot_id')::uuid;
  v_food_log_id  := (v_action->>'applied_food_log_id')::uuid;
  v_cart_item_id := (v_action->>'applied_cart_item_id')::uuid;

  -- Record the applied audit row IN THE SAME TRANSACTION. A CHECK violation
  -- here (should be impossible given the up-front unit guard, but defensive)
  -- aborts the whole function → the stock mutation rolls back too.
  INSERT INTO chefbyte.scan_transactions (
    user_id, barcode, product_id, mode, qty, unit, nutrition_snapshot,
    status, logical_date, source, pi_event_id,
    applied_lot_id, applied_food_log_id, applied_cart_item_id, applied_at
  ) VALUES (
    p_user_id, p_barcode, p_product_id, p_mode, p_qty, p_unit, p_nutrition_snapshot,
    'applied', v_logical_date, p_source, p_pi_event_id,
    v_lot_id, v_food_log_id, v_cart_item_id, now()
  )
  RETURNING transaction_id INTO v_tx_id;

  RETURN jsonb_build_object(
    'transaction_id',       v_tx_id,
    'status',               'applied',
    'mode',                 p_mode,
    'product_id',           p_product_id,
    'applied_lot_id',       v_lot_id,
    'applied_food_log_id',  v_food_log_id,
    'applied_cart_item_id', v_cart_item_id
  );
END;
$$;

REVOKE ALL ON FUNCTION private.execute_scan_and_record(
  UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.execute_scan_and_record(
  UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION private.execute_scan_and_record(
  UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT
) IS
  'Atomic scan apply + audit (H-8). Runs execute_scan_action AND inserts the '
  'applied scan_transactions row in ONE transaction so a Pi retry can never '
  'double-apply (the prior result is observable via the (user_id,pi_event_id) '
  'unique index). Validates unit in {container,serving} up front. logical_date '
  'via get_logical_date(profile tz) (also fixes the TZ-02/03 audit-ledger '
  'stamp). service_role only.';

-- ─────────────────────────────────────────────────────────────────
-- H-8 — chefbyte.execute_scan_and_record(...)  [PostgREST wrapper]
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION chefbyte.execute_scan_and_record(
  p_user_id            UUID,
  p_product_id         UUID,
  p_barcode            TEXT,
  p_mode               TEXT,
  p_qty                NUMERIC,
  p_unit               TEXT,
  p_nutrition_snapshot JSONB,
  p_source             TEXT,
  p_pi_event_id        TEXT
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.execute_scan_and_record(
    p_user_id, p_product_id, p_barcode, p_mode, p_qty, p_unit,
    p_nutrition_snapshot, p_source, p_pi_event_id
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.execute_scan_and_record(
  UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.execute_scan_and_record(
  UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION chefbyte.execute_scan_and_record(
  UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT
) IS
  'PostgREST-callable wrapper for private.execute_scan_and_record (H-8). '
  'shelf-ingest invokes via supabase.schema(''chefbyte'').rpc(...). Thin '
  'pass-through; logic stays in private. service_role only. [T2]';

COMMIT;
