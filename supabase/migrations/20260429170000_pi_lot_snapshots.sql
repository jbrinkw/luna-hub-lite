-- Pi-side lot snapshots cloud mirror.
--
-- Drains the "Pi-side invariant check from cloud edge function" entry
-- from ignore.md (originally a documented gap in the
-- ``pi_cloud_lot_id_match`` invariant which couldn't run from the
-- cloud because Pi-local lot state wasn't visible).
--
-- WHY:
--   The cloud invariant-monitor's ``pi_cloud_lot_id_match`` check
--   wanted to assert: every cloud ``stock_lots`` row touched by a
--   ``live_shelf`` / ``live_scale`` source has a matching Pi-side
--   record with consistent state. Without a cloud-side mirror of Pi
--   data the invariant could only emit a static "deferred" warning.
--
-- WHAT:
--   1. New ``chefbyte.pi_lot_snapshots`` table — keyed
--      (user_id, device_id, pi_lot_id), one row per Pi-local lot. The
--      Pi heartbeat extends its body with a ``lots`` array containing
--      these snapshots; the shelf-ingest /heartbeat endpoint UPSERTs
--      them via the helper RPC below.
--
--   2. ``chefbyte.upsert_pi_lot_snapshots_admin`` — bulk UPSERT helper
--      that the edge function calls per heartbeat. Same idempotency
--      guarantees as ``heartbeat_upsert_pairings_admin`` (single
--      round-trip, ON CONFLICT DO UPDATE). The cloud lot_id is the
--      key the Pi knows from its cloud_lots mirror; cloud-side we
--      preserve it as-is so the invariant can join back to
--      ``stock_lots.lot_id`` for cross-checking.
--
--   3. RLS — per-user read policy mirrors live_shelf_devices.
--      Direct INSERT/UPDATE/DELETE from clients is not allowed; only
--      service_role (via the admin helper called from the edge
--      function) writes.

BEGIN;

------------------------------------------------------------
-- 1. pi_lot_snapshots table
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chefbyte.pi_lot_snapshots (
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id            UUID NOT NULL REFERENCES chefbyte.live_shelf_devices(device_id) ON DELETE CASCADE,
  pi_lot_id            TEXT NOT NULL,
  -- Cloud lot_id the Pi believes this snapshot maps to (read from
  -- cloud_lots). NULL when the Pi has no cloud mapping (a fresh local
  -- lot that hasn't been promoted to cloud yet). The invariant uses
  -- this to join back to stock_lots.lot_id.
  cloud_lot_id         UUID,
  qty_containers       NUMERIC(10,3),
  status               TEXT,
  last_update_source   TEXT,
  in_flight_since      TIMESTAMPTZ,
  in_flight_kind       TEXT,
  current_weight_g     NUMERIC(10,3),
  scale_id_paired_to   TEXT,
  observed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id, pi_lot_id)
);

CREATE INDEX IF NOT EXISTS pi_lot_snapshots_user_idx
  ON chefbyte.pi_lot_snapshots (user_id);

CREATE INDEX IF NOT EXISTS pi_lot_snapshots_cloud_lot_idx
  ON chefbyte.pi_lot_snapshots (cloud_lot_id) WHERE cloud_lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pi_lot_snapshots_observed_at_idx
  ON chefbyte.pi_lot_snapshots (observed_at);

COMMENT ON TABLE chefbyte.pi_lot_snapshots IS
  'Cloud mirror of Pi-local lot state, refreshed every heartbeat. '
  'Powers the pi_cloud_lot_id_match invariant in invariant-monitor: '
  'each lot touched by a live_shelf/live_scale source on cloud must '
  'have a matching Pi snapshot with consistent (lot_id, status, '
  'qty/weight). Drift detection feeds the pi_cloud_drift alert class.';

------------------------------------------------------------
-- 2. RLS — per-user read; writes via admin helper only
------------------------------------------------------------

ALTER TABLE chefbyte.pi_lot_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pi_lot_snapshots_select_rls ON chefbyte.pi_lot_snapshots;
CREATE POLICY pi_lot_snapshots_select_rls
  ON chefbyte.pi_lot_snapshots
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

------------------------------------------------------------
-- 3. Admin helper — bulk UPSERT from /heartbeat
------------------------------------------------------------
--
-- p_lots shape: JSONB array of objects:
--   [{
--     "pi_lot_id": "...",
--     "cloud_lot_id": "<uuid or null>",
--     "qty_containers": <number or null>,
--     "status": "<string or null>",
--     "last_update_source": "<string or null>",
--     "in_flight_since": "<iso ts or null>",
--     "in_flight_kind": "<string or null>",
--     "current_weight_g": <number or null>,
--     "scale_id_paired_to": "<string or null>"
--   }, ...]
--
-- Defensive: an entry whose pi_lot_id is missing/empty is silently
-- skipped (defense-in-depth — edge function pre-validates but a bad
-- row inside an otherwise-valid heartbeat shouldn't poison the
-- whole call).

CREATE OR REPLACE FUNCTION chefbyte.upsert_pi_lot_snapshots_admin(
  p_device_id UUID,
  p_user_id   UUID,
  p_lots      JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec      JSONB;
  v_pi_lot   TEXT;
  v_cloud_lot_text TEXT;
  v_cloud_lot UUID;
  v_qty      NUMERIC(10,3);
  v_status   TEXT;
  v_last_src TEXT;
  v_inflight TIMESTAMPTZ;
  v_inflight_kind TEXT;
  v_weight   NUMERIC(10,3);
  v_scale    TEXT;
  v_now      TIMESTAMPTZ := now();
  v_count    INTEGER := 0;
BEGIN
  IF p_lots IS NULL OR jsonb_typeof(p_lots) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR v_rec IN SELECT jsonb_array_elements(p_lots) LOOP
    v_pi_lot := v_rec->>'pi_lot_id';
    IF v_pi_lot IS NULL OR char_length(v_pi_lot) = 0 THEN
      CONTINUE;  -- skip malformed entry
    END IF;

    v_cloud_lot_text := NULLIF(v_rec->>'cloud_lot_id', '');
    BEGIN
      v_cloud_lot := v_cloud_lot_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_cloud_lot := NULL;
    END;

    -- Numeric fields: jsonb ::numeric tolerates both true numbers
    -- and stringified-numbers, but NULL handling needs care.
    BEGIN
      v_qty := NULLIF(v_rec->>'qty_containers', '')::numeric(10,3);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      v_qty := NULL;
    END;
    BEGIN
      v_weight := NULLIF(v_rec->>'current_weight_g', '')::numeric(10,3);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      v_weight := NULL;
    END;

    v_status     := NULLIF(v_rec->>'status', '');
    v_last_src   := NULLIF(v_rec->>'last_update_source', '');
    v_inflight_kind := NULLIF(v_rec->>'in_flight_kind', '');
    v_scale      := NULLIF(v_rec->>'scale_id_paired_to', '');

    BEGIN
      v_inflight := NULLIF(v_rec->>'in_flight_since', '')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      v_inflight := NULL;
    END;

    INSERT INTO chefbyte.pi_lot_snapshots (
      user_id, device_id, pi_lot_id,
      cloud_lot_id, qty_containers, status, last_update_source,
      in_flight_since, in_flight_kind, current_weight_g,
      scale_id_paired_to, observed_at
    ) VALUES (
      p_user_id, p_device_id, v_pi_lot,
      v_cloud_lot, v_qty, v_status, v_last_src,
      v_inflight, v_inflight_kind, v_weight,
      v_scale, v_now
    )
    ON CONFLICT (user_id, device_id, pi_lot_id) DO UPDATE
      SET cloud_lot_id       = EXCLUDED.cloud_lot_id,
          qty_containers     = EXCLUDED.qty_containers,
          status             = EXCLUDED.status,
          last_update_source = EXCLUDED.last_update_source,
          in_flight_since    = EXCLUDED.in_flight_since,
          in_flight_kind     = EXCLUDED.in_flight_kind,
          current_weight_g   = EXCLUDED.current_weight_g,
          scale_id_paired_to = EXCLUDED.scale_id_paired_to,
          observed_at        = EXCLUDED.observed_at;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.upsert_pi_lot_snapshots_admin(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.upsert_pi_lot_snapshots_admin(UUID, UUID, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.upsert_pi_lot_snapshots_admin(UUID, UUID, JSONB) TO service_role;

GRANT SELECT ON chefbyte.pi_lot_snapshots TO authenticated;

COMMIT;
