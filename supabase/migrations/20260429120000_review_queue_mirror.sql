-- Cloud mirror of the Pi-side review_queue (sync-audit finding #5).
--
-- The Pi maintains a human-in-the-loop ``review_queue`` table for
-- low-confidence classifications, weight mismatches, unpaired removes,
-- etc. (hardware/live-shelf/server/storage/schema.sql §review_queue).
-- The Pi heartbeat already forwards a per-device ``pending_review_count``
-- integer (chefbyte.live_shelf_devices.pending_review_count) but the
-- cloud has no way to actually display the queue items or let the user
-- resolve them remotely.
--
-- This migration adds chefbyte.review_queue, column-compatible with the
-- Pi schema, plus a SECURITY DEFINER resolution helper invoked by both
-- (a) the cloud /chef/reviews UI when the user picks Accept / Reject /
-- Override, and (b) the shelf-ingest /review-resolve edge function path
-- when the Pi resolves on its own /inventory page and propagates the
-- decision back to the cloud.
--
-- Idempotency is keyed on (user_id, pi_review_id). The shelf-ingest
-- ``review_queue_create`` event_kind branch UPSERTs on that pair so
-- replays from the Pi outbox can't double-insert.

------------------------------------------------------------
-- 1. Table
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chefbyte.review_queue (
  review_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pi_review_id   UUID NOT NULL,
  -- Set kept in sync with the Pi enum at
  -- hardware/live-shelf/server/storage/schema.sql:220-222.
  kind           TEXT NOT NULL CHECK (kind IN (
    'unknown_item_add','low_confidence','weight_mismatch','unpaired_remove',
    'multi_match','failed_intake','sensor_anomaly'
  )),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','resolved','dismissed')),
  pi_session_id  UUID,
  pi_event_id    UUID,
  -- Classifier / reconciler proposed payload. JSONB for cheap key reads
  -- in the UI without re-parsing.
  proposed       JSONB,
  -- Relative paths under the Pi LAN URL (e.g. ``events/<event_id>/before.jpg``).
  -- The cloud UI proxies via http://<lan_ip>:8000/<path> when reachable;
  -- out-of-LAN falls back to a placeholder. We DO NOT copy image bytes
  -- to cloud storage (cost) — see caveat in PR description.
  images         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  user_response  JSONB,
  -- Idempotency: every push from the Pi (and every replay) must dedupe
  -- on the Pi-side review_id so a worker retry can't double-insert.
  UNIQUE (user_id, pi_review_id)
);

CREATE INDEX IF NOT EXISTS review_queue_user_status_idx
  ON chefbyte.review_queue (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS review_queue_pi_event_idx
  ON chefbyte.review_queue (user_id, pi_event_id)
  WHERE pi_event_id IS NOT NULL;

------------------------------------------------------------
-- 2. RLS
------------------------------------------------------------

ALTER TABLE chefbyte.review_queue ENABLE ROW LEVEL SECURITY;

-- Owner can SELECT + UPDATE (resolve / dismiss). INSERT and DELETE are
-- service_role only — the Pi-driven create path runs through
-- shelf-ingest with the service-role key, and we never want a client
-- to mint phantom reviews.
DROP POLICY IF EXISTS review_queue_owner_select ON chefbyte.review_queue;
CREATE POLICY review_queue_owner_select
  ON chefbyte.review_queue FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS review_queue_owner_update ON chefbyte.review_queue;
CREATE POLICY review_queue_owner_update
  ON chefbyte.review_queue FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, UPDATE ON chefbyte.review_queue TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.review_queue TO service_role;

------------------------------------------------------------
-- 3. UPSERT helper used by shelf-ingest review_queue_create branch
------------------------------------------------------------
-- Single round-trip + idempotent on (user_id, pi_review_id). Returns
-- the resulting row. Called from the edge function with the service
-- role key so RLS doesn't apply, but we still scope inserts to the
-- authenticated device's user_id explicitly.

CREATE OR REPLACE FUNCTION private.upsert_review_queue_from_pi(
  p_user_id       UUID,
  p_pi_review_id  UUID,
  p_kind          TEXT,
  p_pi_session_id UUID,
  p_pi_event_id   UUID,
  p_proposed      JSONB,
  p_images        JSONB,
  p_created_at    TIMESTAMPTZ
) RETURNS chefbyte.review_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row chefbyte.review_queue;
BEGIN
  IF p_user_id IS NULL OR p_pi_review_id IS NULL THEN
    RAISE EXCEPTION 'user_id and pi_review_id required'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind NOT IN (
    'unknown_item_add','low_confidence','weight_mismatch',
    'unpaired_remove','multi_match','failed_intake','sensor_anomaly'
  ) THEN
    RAISE EXCEPTION 'invalid review kind: %', p_kind USING ERRCODE = '22023';
  END IF;

  INSERT INTO chefbyte.review_queue (
    user_id, pi_review_id, kind, status,
    pi_session_id, pi_event_id, proposed, images, created_at
  ) VALUES (
    p_user_id, p_pi_review_id, p_kind, 'pending',
    p_pi_session_id, p_pi_event_id, p_proposed, p_images,
    COALESCE(p_created_at, now())
  )
  ON CONFLICT (user_id, pi_review_id) DO UPDATE
    -- Idempotent replay. Only refresh the metadata fields the Pi might
    -- have re-evaluated; never overwrite a user-side resolution.
    SET kind          = EXCLUDED.kind,
        pi_session_id = EXCLUDED.pi_session_id,
        pi_event_id   = EXCLUDED.pi_event_id,
        proposed      = EXCLUDED.proposed,
        images        = EXCLUDED.images
    WHERE chefbyte.review_queue.status = 'pending'
  RETURNING * INTO v_row;

  IF v_row.review_id IS NULL THEN
    -- ON CONFLICT skipped (already-resolved row). Read it back so the
    -- caller still gets the canonical row.
    SELECT * INTO v_row
      FROM chefbyte.review_queue
     WHERE user_id = p_user_id AND pi_review_id = p_pi_review_id;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_review_queue_from_pi(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.upsert_review_queue_from_pi(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
) TO service_role;

-- Thin chefbyte-schema wrapper so the shelf-ingest edge function can call
-- it via supabase.schema('chefbyte').rpc('upsert_review_queue_from_pi_admin')
-- — mirrors the chefbyte.apply_shelf_event_admin precedent (the private
-- schema isn't exposed through PostgREST so the edge function needs a
-- chefbyte-side handle).

CREATE OR REPLACE FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  p_user_id       UUID,
  p_pi_review_id  UUID,
  p_kind          TEXT,
  p_pi_session_id UUID,
  p_pi_event_id   UUID,
  p_proposed      JSONB,
  p_images        JSONB,
  p_created_at    TIMESTAMPTZ
) RETURNS chefbyte.review_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.upsert_review_queue_from_pi(
    p_user_id, p_pi_review_id, p_kind,
    p_pi_session_id, p_pi_event_id, p_proposed, p_images, p_created_at
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ
) TO service_role;

------------------------------------------------------------
-- 4. Resolution helper (cloud UI + Pi push-back)
------------------------------------------------------------
-- chefbyte_resolve_review — wraps the cloud-side UI's UPDATE so the
-- timestamp + status flip + user_response merge happen in one round-trip.
-- The cloud UI calls this via supabase.schema('chefbyte').rpc().
-- The Pi-side push-back path uses the same helper through the
-- shelf-ingest /review-resolve handler with the service role key.

CREATE OR REPLACE FUNCTION chefbyte.resolve_review(
  p_review_id     UUID,
  p_status        TEXT,
  p_user_response JSONB DEFAULT NULL
) RETURNS chefbyte.review_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_row chefbyte.review_queue;
BEGIN
  IF p_status NOT IN ('resolved','dismissed') THEN
    RAISE EXCEPTION 'status must be resolved or dismissed (got %)', p_status
      USING ERRCODE = '22023';
  END IF;

  -- Caller-scoping: when invoked by an authenticated user, only let them
  -- resolve their own rows. service_role bypasses the auth.uid() check
  -- (returns NULL) and is allowed to operate on any user's row — the
  -- shelf-ingest /review-resolve handler scopes by device user_id before
  -- calling this.
  UPDATE chefbyte.review_queue
     SET status        = p_status,
         user_response = COALESCE(p_user_response, user_response),
         resolved_at   = COALESCE(resolved_at, now())
   WHERE review_id = p_review_id
     AND (v_uid IS NULL OR user_id = v_uid)
   RETURNING * INTO v_row;

  IF v_row.review_id IS NULL THEN
    RAISE EXCEPTION 'review not found or not owned by caller'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION chefbyte.resolve_review(UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chefbyte.resolve_review(UUID, TEXT, JSONB) TO authenticated, service_role;

------------------------------------------------------------
-- 5. Realtime publication
------------------------------------------------------------
-- The cloud UI subscribes to postgres_changes on chefbyte.review_queue
-- so a push from the Pi lands in the list without a manual refetch.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'review_queue'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.review_queue';
  END IF;
END $$;
