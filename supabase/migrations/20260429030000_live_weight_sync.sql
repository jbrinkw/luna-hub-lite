-- Live-weight sync — Pi → cloud per-lot current-weight stream for
-- live_shelf and live_scale (catch_all already has this via the
-- delta-capture model).
--
-- CONTEXT (2026-04-29):
--   The catch-all scale streams the lot's current weight to cloud
--   continuously via catch_all_first_measurement / _second_measurement
--   (see migrations 20260427120000 + 20260427130000). Live_shelf and
--   live_scale lots only sync their qty at event boundaries
--   (in_flight_pickup, consumed, refilled, in_flight_return). Between
--   events the cloud's view of the lot is stale: stock_lots.qty_containers
--   stays put but the *physical* weight on the scale right now is
--   invisible to the cloud UI.
--
--   Symptom that motivated the fix: a Pi-side lot reads "160.4 g on
--   scale / 16% full / last seen 03:32:41" while the cloud /chef/inventory
--   row shows just "1.6 ctn — no weight info" between events.
--
-- DESIGN:
--   1. Add ``stock_lots.last_observed_weight_g NUMERIC(10,3)`` and
--      ``last_observed_at TIMESTAMPTZ``. Both NULL when no live-weight
--      observation has ever been pushed for the lot.
--   2. Add a SECURITY DEFINER helper ``private.apply_live_weight_sync``
--      that receives ``(p_pi_lot_id, p_observed_weight_g, p_observed_at)``
--      and updates ONLY those two columns on the targeted lot. NEVER
--      touches ``qty_containers`` — the qty is event-driven, the
--      observation is a snapshot. NEVER writes ``food_logs`` — there's
--      no consumption claim being made.
--   3. Same idempotency guarantee as ``apply_shelf_event``:
--      ``shelf_event_log`` UNIQUE(user_id, client_event_id) dedup makes
--      replays safe (a duplicate client_event_id replays the cached
--      reason without re-running the UPDATE).
--   4. Edge function dispatches to this helper when the request body
--      satisfies all of:
--        * kind in ('live_shelf', 'live_scale')
--        * event_kind = 'live_weight_sync'
--        * pi_lot_id is a non-null UUID
--      The legacy apply_shelf_event_admin path is unchanged for older
--      Pi versions / unrelated event_kinds.
--
-- WHY A DEDICATED HELPER (vs another branch in ``apply_shelf_event``):
--   * ``apply_shelf_event`` is ~1000 lines and is concurrently being
--     touched by other migrations. Adding a new branch requires a
--     CREATE OR REPLACE of the whole function which races with the
--     20260428050000 splice patches and the orphan-overload cleanup
--     in 20260429020000. A dedicated helper is isolated.
--   * The lot-targeted ``apply_discard_with_lot_id`` (migration
--     20260428030000) sets the precedent for "thin SECURITY DEFINER
--     helper, edge function dispatches by event_kind". This migration
--     follows the same pattern verbatim.
--
-- IDEMPOTENCY + REPLAY:
--   * ``shelf_event_log`` INSERT with ON CONFLICT (user_id,
--     client_event_id) DO NOTHING. Replay returns cached row.
--   * The UPDATE itself is idempotent under last-write-wins:
--     re-running with the same observed_at + observed_weight_g produces
--     the same end state. The dedup gate ensures we don't even reach
--     the UPDATE on replay.
--   * Stale-write protection: when the incoming ``p_observed_at`` is
--     older than the stored ``last_observed_at`` we still record the
--     event but skip the UPDATE (returns reason='stale (older than
--     stored last_observed_at)'). This avoids out-of-order Pi heartbeats
--     overwriting a fresher reading.
--
-- NON-GOALS:
--   * Does NOT mutate ``qty_containers`` — the qty stays event-driven
--     so reconciliation cycles (in_flight pickup/return, refilled,
--     consumed) remain the only authority on stock counts.
--   * Does NOT write ``food_logs`` — observation events claim no
--     consumption; only catch_all_second_measurement does that and
--     only for live-shelf/scale lots via the existing consumed branch.
--   * Does NOT clear ``in_flight_since`` / ``pickup_event_id`` — even
--     in-flight lots get their last_observed_weight_g updated so the
--     catch-all-style "lot is in flight but has been re-measured"
--     case is supported.
--   * Does NOT bump ``last_update_ts`` / ``last_update_source`` — those
--     fields track stock-mutating writes; observation snapshots are not
--     stock mutations. ``last_observed_at`` is the dedicated freshness
--     signal for observation rows.

BEGIN;

------------------------------------------------------------
-- 1. Schema additions
------------------------------------------------------------

ALTER TABLE chefbyte.stock_lots
  ADD COLUMN IF NOT EXISTS last_observed_weight_g NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS last_observed_at       TIMESTAMPTZ;

-- last_observed_weight_g must be >= 0 when present. NULL is the
-- "never observed" sentinel. Zero is allowed (catch-all empty-bottle
-- semantics carry over: a depleted live_scale lot reads 0g).
ALTER TABLE chefbyte.stock_lots
  DROP CONSTRAINT IF EXISTS stock_lots_last_observed_weight_g_check;
ALTER TABLE chefbyte.stock_lots
  ADD CONSTRAINT stock_lots_last_observed_weight_g_check
    CHECK (last_observed_weight_g IS NULL OR last_observed_weight_g >= 0);

COMMENT ON COLUMN chefbyte.stock_lots.last_observed_weight_g IS
  'Most recent gram-level weight reading streamed from the Pi for this '
  'lot via the live_weight_sync flow (live_shelf + live_scale only). '
  'Catch-all uses pickup_weight_g for its delta-capture cycle, not this '
  'column. NULL = never observed. Zero is allowed (depleted scale).';

COMMENT ON COLUMN chefbyte.stock_lots.last_observed_at IS
  'Timestamp of the most recent live_weight_sync observation. Paired '
  'with last_observed_weight_g — the cloud UI uses this to render '
  '"on scale right now" with a freshness indicator. NULL = never '
  'observed.';

------------------------------------------------------------
-- 2. Helper function — apply a live-weight observation
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.apply_live_weight_sync(
  p_user_id           UUID,
  p_device_id         UUID,
  p_scale_id          TEXT,
  p_kind              TEXT,
  p_pi_lot_id         UUID,
  p_observed_weight_g NUMERIC,
  p_observed_at       TIMESTAMPTZ,
  p_client_event_id   TEXT,
  p_pi_event_id       TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_log_id           UUID;
  v_existing_applied BOOLEAN;
  v_existing_lot     UUID;
  v_existing_reason  TEXT;
  v_lot_user_id      UUID;
  v_stored_observed_at TIMESTAMPTZ;
  v_result           chefbyte.shelf_event_result;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('live_shelf','live_scale') THEN
    RAISE EXCEPTION 'live_weight_sync requires kind in (live_shelf, live_scale), got %', p_kind
      USING ERRCODE = '22023';
  END IF;
  IF p_client_event_id IS NULL OR char_length(p_client_event_id) = 0 THEN
    RAISE EXCEPTION 'client_event_id required' USING ERRCODE = '22023';
  END IF;
  IF p_pi_lot_id IS NULL THEN
    RAISE EXCEPTION 'pi_lot_id required' USING ERRCODE = '22023';
  END IF;
  IF p_observed_weight_g IS NULL OR p_observed_weight_g < 0 THEN
    RAISE EXCEPTION 'observed_weight_g must be non-negative' USING ERRCODE = '22023';
  END IF;
  IF p_observed_at IS NULL THEN
    RAISE EXCEPTION 'observed_at required' USING ERRCODE = '22023';
  END IF;

  -- Race-free idempotency: shelf_event_log INSERT with UNIQUE
  -- (user_id, client_event_id) dedup. Replay returns cached row
  -- without re-running the UPDATE.
  INSERT INTO chefbyte.shelf_event_log (
    user_id, device_id, client_event_id, payload, applied, reason, pi_event_id
  ) VALUES (
    p_user_id, p_device_id, p_client_event_id,
    jsonb_build_object(
      'scale_id', p_scale_id,
      'kind', p_kind,
      'event_kind', 'live_weight_sync',
      'pi_lot_id', p_pi_lot_id,
      'observed_weight_g', p_observed_weight_g,
      'observed_at', p_observed_at,
      'pi_event_id', p_pi_event_id
    ),
    false, 'pending', p_pi_event_id
  )
  ON CONFLICT (user_id, client_event_id) DO NOTHING
  RETURNING event_id INTO v_log_id;

  IF v_log_id IS NULL THEN
    -- Replay path — pick up cached pi_event_id when caller passes one.
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

  -- Validate lot ownership. Cross-user writes rejected.
  SELECT user_id, last_observed_at
    INTO v_lot_user_id, v_stored_observed_at
    FROM chefbyte.stock_lots
   WHERE lot_id = p_pi_lot_id;

  IF v_lot_user_id IS NULL THEN
    v_result := ROW(NULL::UUID, false, 'lot_id not found');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  IF v_lot_user_id <> p_user_id THEN
    v_result := ROW(NULL::UUID, false, 'lot_id not owned by user');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  -- Stale-write protection: skip the UPDATE when the incoming
  -- observed_at is strictly older than the stored last_observed_at.
  -- The shelf_event_log row still records that we saw the event, but
  -- the lot's observation columns aren't regressed. This handles
  -- out-of-order arrivals from the Pi's outbox drainer.
  IF v_stored_observed_at IS NOT NULL
     AND p_observed_at < v_stored_observed_at THEN
    v_result := ROW(p_pi_lot_id, true, 'stale (older than stored last_observed_at)');
    UPDATE chefbyte.shelf_event_log
       SET applied = v_result.applied,
           resolved_lot_id = v_result.resolved_lot_id,
           reason = v_result.reason
     WHERE event_id = v_log_id;
    RETURN v_result;
  END IF;

  -- Apply the observation. Updates ONLY the two observation columns —
  -- qty_containers, in_flight_*, pickup_*, last_update_ts, and
  -- last_update_source are intentionally untouched.
  UPDATE chefbyte.stock_lots
     SET last_observed_weight_g = p_observed_weight_g,
         last_observed_at       = p_observed_at
   WHERE lot_id = p_pi_lot_id
     AND user_id = p_user_id;

  v_result := ROW(p_pi_lot_id, true, 'live_weight_sync applied');
  UPDATE chefbyte.shelf_event_log
     SET applied = v_result.applied,
         resolved_lot_id = v_result.resolved_lot_id,
         reason = v_result.reason
   WHERE event_id = v_log_id;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_live_weight_sync(
  UUID, UUID, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_live_weight_sync(
  UUID, UUID, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION private.apply_live_weight_sync(
  UUID, UUID, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) IS
  'Apply a live-weight observation from the Pi for a live_shelf or '
  'live_scale lot. Updates only stock_lots.last_observed_weight_g + '
  'last_observed_at; never mutates qty_containers and never writes '
  'food_logs. Idempotent via shelf_event_log dedup; out-of-order '
  'arrivals are recorded but do not regress last_observed_at.';

------------------------------------------------------------
-- 3. Public wrapper — mirrors apply_shelf_event_admin convention
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.apply_live_weight_sync_admin(
  p_user_id           UUID,
  p_device_id         UUID,
  p_scale_id          TEXT,
  p_kind              TEXT,
  p_pi_lot_id         UUID,
  p_observed_weight_g NUMERIC,
  p_observed_at       TIMESTAMPTZ,
  p_client_event_id   TEXT,
  p_pi_event_id       TEXT DEFAULT NULL
) RETURNS chefbyte.shelf_event_result
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.apply_live_weight_sync(
    p_user_id, p_device_id, p_scale_id, p_kind,
    p_pi_lot_id, p_observed_weight_g, p_observed_at,
    p_client_event_id, p_pi_event_id
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.apply_live_weight_sync_admin(
  UUID, UUID, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.apply_live_weight_sync_admin(
  UUID, UUID, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.apply_live_weight_sync_admin(
  UUID, UUID, TEXT, TEXT, UUID, NUMERIC, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

COMMIT;
