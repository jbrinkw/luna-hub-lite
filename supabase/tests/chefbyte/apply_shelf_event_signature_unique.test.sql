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
SELECT plan(4);

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
-- Assertion 2: the surviving overload has the canonical 11-arg contract.
--
-- CB-PG-02 (MOCK_AUDIT_CHEFBYTE_SERVER.md 2026-04-29):
-- Rather than snapshoting a raw OID string (which reads as an opaque
-- literal), we assert the contract explicitly:
--   (a) proargtypes — the INPUT type vector (name-agnostic, DEFAULT-
--       agnostic) expressed via regtype so the readable type name
--       appears in failure output;
--   (b) proargnames — parameter names pinned in positional order so a
--       rename is caught even if the type vector stays the same;
--   (c) event_kind dispatch carve-out — a separate assertion confirms
--       the function body references the canonical event-kind branches
--       (catches the "correct signature, empty body" class).
--
-- Canonical 11-arg signature (as of migration 20260429050000_food_logs_usage_kind).
-- Actual parameter names come from pg_proc.proargnames — verified by
-- running: SELECT proargnames FROM pg_proc WHERE proname='apply_shelf_event'.
--   1  p_user_id          uuid
--   2  p_device_id        uuid
--   3  p_scale_id         text
--   4  p_kind             text   (event source/kind routing discriminator)
--   5  p_event_kind       text   (VALID_EVENT_KINDS value)
--   6  p_product_id       uuid
--   7  p_delta_g          numeric
--   8  p_occurred_at      timestamptz
--   9  p_client_event_id  text
--  10  p_pi_event_id      text
--  11  p_usage_kind       text   (DEFAULT NULL — added 2026-04-29, finding #6)
--
-- If a 12th parameter is added, assertion (a) will fail here — the
-- developer MUST update both this comment and the arrays below so the
-- contract stays self-documenting, not silently mirrored.
------------------------------------------------------------

-- (a) Input type vector — fails if a parameter type changes or a new
--     parameter is added without updating this contract.
SELECT is(
  (SELECT p.proargtypes::text
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'apply_shelf_event'
    LIMIT 1),
  array_to_string(ARRAY[
    'uuid'::regtype::oid,        -- 1  p_user_id
    'uuid'::regtype::oid,        -- 2  p_device_id
    'text'::regtype::oid,        -- 3  p_scale_id
    'text'::regtype::oid,        -- 4  p_kind
    'text'::regtype::oid,        -- 5  p_event_kind
    'uuid'::regtype::oid,        -- 6  p_product_id
    'numeric'::regtype::oid,     -- 7  p_delta_g
    'timestamp with time zone'::regtype::oid, -- 8  p_occurred_at
    'text'::regtype::oid,        -- 9  p_client_event_id
    'text'::regtype::oid,        -- 10 p_pi_event_id
    'text'::regtype::oid         -- 11 p_usage_kind (DEFAULT NULL, added 2026-04-29)
  ], ' '),
  'CB-PG-02: apply_shelf_event has canonical 11-arg input type vector '
    '(uuid,uuid,text,text,text,uuid,numeric,timestamptz,text,text,text). '
    'Failure = wrong type at a position OR a new parameter added without '
    'updating this contract comment.'
);

-- (b) Parameter names — fails if a parameter is renamed even when type
--     stays the same. Catches refactors that shuffle arg semantics.
SELECT is(
  (SELECT p.proargnames
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'apply_shelf_event'
    LIMIT 1),
  ARRAY[
    'p_user_id', 'p_device_id', 'p_scale_id', 'p_kind',
    'p_event_kind', 'p_product_id', 'p_delta_g', 'p_occurred_at',
    'p_client_event_id', 'p_pi_event_id', 'p_usage_kind'
  ],
  'CB-PG-02: apply_shelf_event parameter names match canonical contract '
    '(positions 1-11). Failure = rename or reorder without updating contract.'
);

-- (c) Event-kind dispatch exists in the function body — catches the
--     "correct signature but hollow implementation" class. Asserts the
--     body references at least the most critical branch keywords.
SELECT ok(
  (SELECT prosrc LIKE '%consumed%' AND prosrc LIKE '%in_flight_pickup%'
       AND prosrc LIKE '%catch_all_first_measurement%'
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private'
      AND p.proname = 'apply_shelf_event'
    LIMIT 1),
  'CB-PG-02: apply_shelf_event body contains event-kind dispatch branches '
    '(consumed, in_flight_pickup, catch_all_first_measurement). Failure = '
    'hollow stub accidentally replaces the real implementation.'
);

SELECT * FROM finish();
ROLLBACK;
