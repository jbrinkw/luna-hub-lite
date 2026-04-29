-- Walmart-scrape per-user rate limiting (UX_AUDIT_CHEFBYTE_USE finding).
--
-- The walmart-scrape edge function had no rate limit despite the spec
-- (`docs/apps/chefbyte.md`, `CLAUDE.md`) promising one. A user clicking
-- "Refresh All Prices" with 200 linked products burned through SerpAPI
-- quota silently, with no visible counter and no failsafe.
--
-- This migration introduces:
--   * chefbyte.walmart_quota — one row per user, tracks today's count
--     and the ISO date it covers (UTC). Auto-resets when day changes.
--   * private.walmart_check_and_increment(p_user_id, p_max) — atomic
--     check-and-increment. Returns JSONB { allowed, used, remaining,
--     limit, reset_at }. Edge fn calls this BEFORE invoking SerpAPI.
--
-- 100/user/day matches the analyze-product spec quota in CLAUDE.md.
--
-- Concurrency: SELECT ... FOR UPDATE on the user's row serializes
-- concurrent calls so two simultaneous "Refresh All" loops can't race
-- past the cap. The single-row-per-user shape keeps the lock narrow.

BEGIN;

CREATE TABLE IF NOT EXISTS chefbyte.walmart_quota (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- UTC date the count covers. We use UTC (not the user's logical date)
  -- because SerpAPI itself bills in calendar days; aligning the quota
  -- window to UTC midnight keeps the math simple.
  quota_date DATE NOT NULL,
  used INT NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chefbyte.walmart_quota ENABLE ROW LEVEL SECURITY;

-- Owners can read their own quota row (the UI can show "X/100 today").
CREATE POLICY walmart_quota_owner_read
  ON chefbyte.walmart_quota
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- No write policy — only the SECURITY DEFINER function below can mutate.

CREATE OR REPLACE FUNCTION private.walmart_check_and_increment(
  p_user_id UUID,
  p_max INT DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'UTC')::DATE;
  v_used INT;
  v_reset_at TIMESTAMPTZ := ((v_today + INTERVAL '1 day')::TIMESTAMP AT TIME ZONE 'UTC');
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id required';
  END IF;
  IF p_max <= 0 THEN
    RAISE EXCEPTION 'p_max must be positive';
  END IF;

  -- Upsert: insert today's row if missing or stale (yesterday's date),
  -- otherwise lock the existing row. The combination of ON CONFLICT
  -- and FOR UPDATE serializes concurrent callers.
  INSERT INTO chefbyte.walmart_quota AS q (user_id, quota_date, used, updated_at)
  VALUES (p_user_id, v_today, 0, now())
  ON CONFLICT (user_id) DO UPDATE
    SET quota_date = CASE
                       WHEN q.quota_date <> v_today THEN v_today
                       ELSE q.quota_date
                     END,
        used = CASE
                 WHEN q.quota_date <> v_today THEN 0
                 ELSE q.used
               END,
        updated_at = now()
  RETURNING used INTO v_used;

  -- Lock + re-read after upsert to get a stable view.
  SELECT used INTO v_used
  FROM chefbyte.walmart_quota
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_used >= p_max THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'used', v_used,
      'remaining', 0,
      'limit', p_max,
      'reset_at', v_reset_at
    );
  END IF;

  UPDATE chefbyte.walmart_quota
     SET used = used + 1, updated_at = now()
   WHERE user_id = p_user_id
   RETURNING used INTO v_used;

  RETURN jsonb_build_object(
    'allowed', true,
    'used', v_used,
    'remaining', p_max - v_used,
    'limit', p_max,
    'reset_at', v_reset_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION private.walmart_check_and_increment(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION private.walmart_check_and_increment(UUID, INT) TO service_role;

COMMIT;
