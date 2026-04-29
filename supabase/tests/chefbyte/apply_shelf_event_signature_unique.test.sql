-- pgTAP — private.apply_shelf_event has exactly ONE overload.
--
-- Regression test for 2026-04-29 production outage where an orphan
-- 11-arg overload (p_after_weight_g) coexisted with the canonical
-- 10-arg signature, causing PostgreSQL function-resolution to fail
-- with SQLSTATE 42725 ("function ... is not unique") on every Pi
-- outbox drain attempt.
--
-- The fix migration (20260429020000_drop_orphan_apply_shelf_event_overload.sql)
-- iterates pg_proc and drops everything except the canonical signature.
-- This test asserts the post-migration invariant: exactly one overload,
-- with the canonical (uuid,uuid,text,text,text,uuid,numeric,timestamptz,text,text)
-- signature.
--
-- The mutation that re-introduces the orphan (e.g. a CREATE OR REPLACE
-- with a different parameter list, or a partial rollback that leaves
-- DROPped functions behind) trips assertion 1.

BEGIN;
SELECT plan(2);

------------------------------------------------------------
-- Assertion 1: exactly one overload exists.
------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'apply_shelf_event'),
  1,
  'exactly one private.apply_shelf_event overload exists'
);

------------------------------------------------------------
-- Assertion 2: the surviving overload is the canonical 10-arg one.
--
-- Compare ``proargtypes`` (the input-type vector) against the canonical
-- type list, expressed as a space-separated regtype OID string. This
-- form is name-agnostic + DEFAULT-agnostic, so a refactor that renames
-- parameters or adds a DEFAULT NULL doesn't trip this assertion — only
-- a real signature change does.
------------------------------------------------------------

SELECT is(
  (SELECT p.proargtypes::text
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'apply_shelf_event'
    LIMIT 1),
  array_to_string(ARRAY[
    'uuid'::regtype::oid,
    'uuid'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'uuid'::regtype::oid,
    'numeric'::regtype::oid,
    'timestamp with time zone'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    -- 2026-04-29: sync-audit finding #6 added p_usage_kind TEXT
    -- DEFAULT NULL as the 11th parameter so Pi-emitted consumed
    -- events can stamp ``food_logs.usage_kind`` with the Pi
    -- ``usage_log.kind`` provenance discriminator.
    'text'::regtype::oid
  ], ' '),
  'surviving overload has canonical 11-arg signature'
);

SELECT * FROM finish();
ROLLBACK;
