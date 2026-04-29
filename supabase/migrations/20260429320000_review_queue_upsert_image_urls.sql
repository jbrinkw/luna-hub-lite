-- Migration: extend upsert_review_queue_from_pi{,_admin} to accept and
-- write before_image_url / after_image_url (added in 20260429310000).
--
-- The Pi passes these optional fields in the review_queue_create outbox
-- payload when images have already been uploaded to Supabase Storage.
-- Old Pi clients that don't send the fields get NULL (no change).

------------------------------------------------------------
-- 1. private.upsert_review_queue_from_pi (add 2 new params)
------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.upsert_review_queue_from_pi(
  p_user_id          UUID,
  p_pi_review_id     UUID,
  p_kind             TEXT,
  p_pi_session_id    UUID,
  p_pi_event_id      UUID,
  p_proposed         JSONB,
  p_images           JSONB,
  p_created_at       TIMESTAMPTZ,
  p_before_image_url TEXT DEFAULT NULL,
  p_after_image_url  TEXT DEFAULT NULL
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
    pi_session_id, pi_event_id, proposed, images, created_at,
    before_image_url, after_image_url
  ) VALUES (
    p_user_id, p_pi_review_id, p_kind, 'pending',
    p_pi_session_id, p_pi_event_id, p_proposed, p_images,
    COALESCE(p_created_at, now()),
    p_before_image_url,
    p_after_image_url
  )
  ON CONFLICT (user_id, pi_review_id) DO UPDATE
    SET kind              = EXCLUDED.kind,
        pi_session_id     = EXCLUDED.pi_session_id,
        pi_event_id       = EXCLUDED.pi_event_id,
        proposed          = EXCLUDED.proposed,
        images            = EXCLUDED.images,
        -- Only overwrite cloud URL when the replay actually provides one
        -- (non-NULL wins over NULL to avoid regressing a previously-uploaded URL).
        before_image_url  = COALESCE(EXCLUDED.before_image_url, chefbyte.review_queue.before_image_url),
        after_image_url   = COALESCE(EXCLUDED.after_image_url,  chefbyte.review_queue.after_image_url)
    WHERE chefbyte.review_queue.status = 'pending'
  RETURNING * INTO v_row;

  IF v_row.review_id IS NULL THEN
    SELECT * INTO v_row
      FROM chefbyte.review_queue
     WHERE user_id = p_user_id AND pi_review_id = p_pi_review_id;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_review_queue_from_pi(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.upsert_review_queue_from_pi(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

------------------------------------------------------------
-- 2. chefbyte.upsert_review_queue_from_pi_admin (wrapper, same new sig)
------------------------------------------------------------

CREATE OR REPLACE FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  p_user_id          UUID,
  p_pi_review_id     UUID,
  p_kind             TEXT,
  p_pi_session_id    UUID,
  p_pi_event_id      UUID,
  p_proposed         JSONB,
  p_images           JSONB,
  p_created_at       TIMESTAMPTZ,
  p_before_image_url TEXT DEFAULT NULL,
  p_after_image_url  TEXT DEFAULT NULL
) RETURNS chefbyte.review_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM private.upsert_review_queue_from_pi(
    p_user_id, p_pi_review_id, p_kind,
    p_pi_session_id, p_pi_event_id, p_proposed, p_images, p_created_at,
    p_before_image_url, p_after_image_url
  );
$$;

REVOKE ALL ON FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ, TEXT, TEXT
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION chefbyte.upsert_review_queue_from_pi_admin(
  UUID, UUID, TEXT, UUID, UUID, JSONB, JSONB, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;
