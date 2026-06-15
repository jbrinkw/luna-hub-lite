-- ════════════════════════════════════════════════════════════════════════════
-- H-16 (SEAM-EDGE-DB-01) — hub.upsert_alert PostgREST-callable wrapper
-- ════════════════════════════════════════════════════════════════════════════
-- The invariant-monitor edge function (cron every 30 min, migration
-- 20260427040000) detects 11 classes of data-corruption invariant violations
-- and writes one row per violation to hub.alerts via the service-role key. It
-- called `supabase.schema('private').rpc('upsert_alert', …)` — but PostgREST
-- exposes only (public, graphql_public, hub, coachbyte, chefbyte) per
-- supabase/config.toml; `private` is NOT on the API surface. supabase-js sets
-- `Content-Profile: private`, so PostgREST rejects with PGRST106 ("Invalid
-- schema: private") BEFORE any grant check ever runs. The edge function
-- swallowed that error and reported ok:true → every detected violation was
-- silently dropped and hub.alerts stayed empty. The production data-corruption
-- backstop was completely inert.
--
-- Fix mirrors the established PGRST106 precedent in this repo (walmart_check
-- _and_increment 20260429070000, execute_scan_action 20260503100150,
-- void_scan_transaction 20260503100250): a thin SECURITY DEFINER wrapper in an
-- EXPOSED schema that delegates to the private function. Logic stays in
-- `private.upsert_alert` (where the SECURITY DEFINER privilege belongs);
-- `hub` exposes a PostgREST-callable surface. The edge function is changed to
-- call `supabase.schema('hub').rpc('upsert_alert', …)`.
--
-- Lockdown (T2 convention, 20260515020000): alerts are monitor-only. Clients
-- must NEVER write them — there is intentionally no INSERT RLS policy on
-- hub.alerts, and SECURITY DEFINER would bypass RLS anyway. So this wrapper is
-- granted to service_role ONLY and REVOKEd from PUBLIC/anon/authenticated. No
-- auth.uid() guard is needed here: the wrapper has no p_user_id argument to
-- forge, the only legitimate caller is the service-role edge function (auth.uid()
-- is NULL there), and the REVOKE alone closes the surface to every client role.
-- Signature is identical to private.upsert_alert (20260427030000:207), including
-- the hub.alerts composite return type.

CREATE OR REPLACE FUNCTION hub.upsert_alert(
  p_invariant_name TEXT,
  p_severity       TEXT,
  p_subject_type   TEXT,
  p_subject_id     TEXT,
  p_user_id        UUID,
  p_details        JSONB
) RETURNS hub.alerts
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.upsert_alert(
    p_invariant_name, p_severity, p_subject_type, p_subject_id, p_user_id, p_details
  );
$$;

REVOKE ALL ON FUNCTION hub.upsert_alert(TEXT, TEXT, TEXT, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hub.upsert_alert(TEXT, TEXT, TEXT, TEXT, UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION hub.upsert_alert(TEXT, TEXT, TEXT, TEXT, UUID, JSONB) IS
  'PostgREST-callable wrapper for private.upsert_alert (H-16). The '
  'invariant-monitor edge function invokes via '
  'supabase.schema(''hub'').rpc(''upsert_alert'', …) under the service-role '
  'key — calling private.* directly returned PGRST106 and silently dropped '
  'every alert. service_role only; clients must never write alerts (no INSERT '
  'RLS policy exists, and this wrapper is REVOKEd from authenticated/anon).';
