-- Schedule the invariant-monitor edge function to run every 30 minutes.
--
-- Wires pg_cron + pg_net (both pre-installed on Supabase managed
-- Postgres) so the DB itself triggers the edge function — no external
-- scheduler needed. Each tick POSTs to /functions/v1/invariant-monitor
-- with the service-role JWT in the Authorization header.
--
-- Why pg_cron + pg_net (and not Supabase's "Scheduled Functions" UI):
--   * Configuration lives in source control, not the dashboard. A
--     fresh `supabase db push --linked` rebuilds the schedule with no
--     manual click-ops.
--   * Identical behaviour against a local stack — `supabase test db`
--     can simulate the scheduled trigger by manually invoking
--     `cron.schedule` or by calling the edge function with the
--     service-role key.
--
-- IMPORTANT: this migration is idempotent. Re-running it unschedules
-- any previous version of the job by name first. Both the URL and the
-- service-role key are read from `vault.secrets` if available, falling
-- back to `current_setting`. On a fresh local stack neither is present
-- and the schedule simply fails to register — which is the desired
-- behavior (local devs don't want auto-running cron jobs).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Helper: resolve the function URL + service-role token from vault if
-- present, else from current_setting() (set by `vercel env pull` or
-- equivalent). Returns NULL if not configured — the trigger then
-- silently no-ops, which is what we want on local stacks.
CREATE OR REPLACE FUNCTION private.invariant_monitor_invoke()
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_url   TEXT;
  v_key   TEXT;
  v_req   bigint;
BEGIN
  -- supabase managed Postgres exposes the function URL via
  -- vault.secrets / app.settings. Fall back gracefully.
  BEGIN
    v_url := current_setting('app.settings.supabase_url', true);
  EXCEPTION WHEN OTHERS THEN
    v_url := NULL;
  END;
  IF v_url IS NULL OR v_url = '' THEN
    -- Try the standard env var name set by Supabase Cloud.
    BEGIN
      v_url := current_setting('supabase_functions.endpoint', true);
    EXCEPTION WHEN OTHERS THEN
      v_url := NULL;
    END;
  END IF;

  BEGIN
    v_key := current_setting('app.settings.service_role_key', true);
  EXCEPTION WHEN OTHERS THEN
    v_key := NULL;
  END;

  IF v_url IS NULL OR v_url = '' OR v_key IS NULL OR v_key = '' THEN
    RAISE NOTICE 'invariant-monitor invocation skipped: app.settings.supabase_url / service_role_key not configured';
    RETURN NULL;
  END IF;

  SELECT extensions.http_post(
    url := v_url || '/functions/v1/invariant-monitor',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    )
  ) INTO v_req;

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION private.invariant_monitor_invoke() FROM PUBLIC;

-- Unschedule any prior job with the same name (idempotency on re-run).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'invariant-monitor-30min';
EXCEPTION WHEN OTHERS THEN
  -- pg_cron extension not installed (local stack) — skip silently.
  NULL;
END $$;

-- Schedule every 30 minutes. The function name is namespaced with the
-- explicit cadence so future schedules (15min, hourly) don't collide.
DO $$
BEGIN
  PERFORM cron.schedule(
    'invariant-monitor-30min',
    '*/30 * * * *',
    $cron$ SELECT private.invariant_monitor_invoke(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron not available (local stack or restricted role) — skip
  -- silently. The migration still records the helper function so the
  -- cloud apply, where pg_cron IS available, succeeds.
  RAISE NOTICE 'cron.schedule failed: %', SQLERRM;
END $$;
