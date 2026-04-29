-- Drop orphan ``private.apply_shelf_event`` overloads that conflict with
-- the canonical 10-arg signature.
--
-- 2026-04-29 PRODUCTION OUTAGE — root cause:
--
--   Pi outbox 97 (an in_flight_pickup event re-emitted by the startup
--   backfill) was returning HTTP 500 from shelf-ingest with the SQL
--   error:
--
--     42725: function private.apply_shelf_event(uuid, uuid, unknown,
--             unknown, unknown, uuid, numeric, timestamp with time zone,
--             text, unknown) is not unique
--
--   Production has TWO overloads of ``private.apply_shelf_event``:
--     1. Canonical 10-arg (this repo's source of truth):
--        (uuid, uuid, text, text, text, uuid, numeric,
--         timestamp with time zone, text, text)
--     2. Stale 11-arg with ``p_after_weight_g numeric DEFAULT NULL``,
--        introduced by a later-reverted experiment (commits 74a02407 +
--        2a14d4e6 — see migration 20260429010000 header). The migration
--        rolling back that experiment dropped the local instance but
--        production was already deployed — the orphan signature stayed
--        live with no migration ever DROPping it.
--
--   ``chefbyte.apply_shelf_event_admin`` (the SQL wrapper that
--   shelf-ingest's ``apply_shelf_event_admin`` RPC calls) invokes the
--   underlying function POSITIONALLY with 10 arguments. PostgreSQL
--   cannot disambiguate between the two overloads because the 11-arg
--   variant's last parameter has a DEFAULT, so it's a valid candidate
--   for a 10-arg call too. Function-resolution then fails 42725 and the
--   wrapper raises, which propagates as 500 from shelf-ingest.
--
--   Cascade impact: every event from the affected device's outbox
--   queues behind the broken call (worker is FIFO). The user's chicken
--   in_flight_pickup → consumed → in_flight_return chain (outbox 97/98/
--   99) all hit the same wall.
--
-- FIX:
--   Drop every overload that is NOT the canonical 10-arg signature.
--   Use IF EXISTS so the migration is safe on:
--     * a fresh DB (no orphans → no-ops)
--     * production (orphan present → drops it, leaving the canonical)
--     * any future drift where extra overloads accumulate
--
-- VERIFICATION:
--   Companion pgTAP test
--   ``supabase/tests/chefbyte/apply_shelf_event_signature_unique.test.sql``
--   asserts that exactly one ``private.apply_shelf_event`` overload
--   exists post-migration, with the canonical 10-arg signature. Any
--   future orphan introduction trips the test.

BEGIN;

DO $$
DECLARE
  rec RECORD;
  -- The canonical signature is identified by its argument-type vector
  -- (oidvector). Comparing types directly avoids the parameter-name
  -- variability that ``pg_get_function_identity_arguments`` exposes:
  -- in this Postgres version it INCLUDES parameter names alongside types
  -- (``p_user_id uuid, p_device_id uuid, ...``), so a string comparison
  -- against a name-less canonical would miss every overload.
  -- Canonical input-type vector as ``proargtypes::text`` formats it:
  -- a space-separated list of pg_type OIDs in declaration order. Built
  -- via regtype lookups so the migration is robust against catalog OID
  -- shifts across PG versions.
  v_canonical_types CONSTANT TEXT := array_to_string(ARRAY[
    'uuid'::regtype::oid,
    'uuid'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'uuid'::regtype::oid,
    'numeric'::regtype::oid,
    'timestamp with time zone'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid
  ], ' ');
BEGIN
  FOR rec IN
    SELECT p.oid::regprocedure AS sig,
           p.proargtypes::text AS argtypes_text,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           p.pronargs AS nargs
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private'
       AND p.proname = 'apply_shelf_event'
  LOOP
    -- ``proargtypes`` is the *input-type vector* — it is the column
    -- PostgreSQL uses internally to disambiguate overloads. Cast it to
    -- text so we get a stable space-separated type list (regtype names)
    -- to compare against the canonical. Strips parameter names +
    -- DEFAULT clauses + return type entirely.
    IF rec.argtypes_text <> v_canonical_types
       OR rec.nargs <> 10 THEN
      EXECUTE format('DROP FUNCTION %s', rec.sig);
      RAISE NOTICE
        '20260429020000: dropped orphan overload private.apply_shelf_event(%)',
        rec.args;
    END IF;
  END LOOP;
END $$;

COMMIT;
