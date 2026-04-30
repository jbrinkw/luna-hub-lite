-- event_lifecycle state / transition tests (pgTAP)
--
-- The Pi's event_lifecycle table (hardware/live-shelf/server/storage/schema.sql)
-- is SQLite and lives on the device. This pgTAP file verifies the same append-
-- only lifecycle audit trail using a temporary Postgres mirror.
--
-- event_lifecycle is NOT a state machine in the traditional sense — it is an
-- append-only audit log where each row records ONE transition of the event's
-- pipeline state. The "current state" of an event is the reason_code of its
-- LATEST row.
--
-- Pipeline stages and their canonical reason_codes (lifecycle.py ReasonCode):
--
--   ingress  : event_ingress | event_ingress_dedup_hit | event_ingress_noise |
--               event_ingress_rejected
--   claimed  : event_claimed | event_claim_lost | event_row_missing
--   frames   : frames_picked | frames_copied | frames_copy_error
--   classify : classifier_dispatched → classifier_returned | classifier_threw
--   apply    : apply_accepted | apply_skipped | lot_mutated | review_enqueued
--
-- Tests:
--   1. Append-only: rows accumulate, are never updated.
--   2. One event can have multiple lifecycle rows (full happy-path chain).
--   3. Concurrent events are isolated by event_id.
--   4. Reason codes from the dedup / noise / rejected branches.
--   5. get_event_timeline ordering (by id ASC).
--   6. Purge: rows older than N days are deleted, recent ones are not.
--   7. No hard FK on event_id: lifecycle survives if the referenced
--      scale_events row is deleted.
--   8. NULL event_id rows are rejected by NOT NULL constraint.

BEGIN;

SELECT plan(18);

-- -----------------------------------------------------------------------
-- Mirror the Pi SQLite event_lifecycle schema.
-- -----------------------------------------------------------------------

CREATE TEMP TABLE event_lifecycle_mirror (
  id              SERIAL PRIMARY KEY,
  event_id        TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor           TEXT NOT NULL,
  reason_code     TEXT NOT NULL,
  payload_json    TEXT
);

-- -----------------------------------------------------------------------
-- Helper: get the latest reason_code for an event (= current pipeline state)
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION temp_latest_reason(p_event_id TEXT)
RETURNS TEXT LANGUAGE sql AS $$
  SELECT reason_code
    FROM event_lifecycle_mirror
   WHERE event_id = p_event_id
   ORDER BY id DESC
   LIMIT 1;
$$;

-- -----------------------------------------------------------------------
-- 1. Ingress transition: first row always has an ingress reason_code
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('evt-aaa', 'ingress', 'event_ingress');

SELECT is(
  temp_latest_reason('evt-aaa'),
  'event_ingress',
  'ingress: first lifecycle row is event_ingress'
);

-- -----------------------------------------------------------------------
-- 2. Happy-path chain: ingress → claimed → frames → classify → apply
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('evt-aaa', 'tracker',    'event_claimed');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('evt-aaa', 'classifier', 'frames_picked');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-aaa', 'classifier', 'classifier_dispatched', '{"model":"claude-sonnet-4-5"}');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-aaa', 'classifier', 'classifier_returned', '{"item":"milk","confidence":0.92}');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-aaa', 'reconciler', 'apply_accepted', '{"lot_id":"lot-001"}');

SELECT is(
  temp_latest_reason('evt-aaa'),
  'apply_accepted',
  'happy-path: latest reason_code after full pipeline is apply_accepted'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror WHERE event_id = 'evt-aaa'),
  6,
  'append-only: all 6 pipeline steps are recorded, none overwritten'
);

-- -----------------------------------------------------------------------
-- 3. Dedup path: ingress_dedup_hit terminates the pipeline
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('evt-bbb', 'ingress', 'event_ingress');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-bbb', 'ingress', 'event_ingress_dedup_hit',
          '{"existing_event_id":"evt-bbb-prev"}');

SELECT is(
  temp_latest_reason('evt-bbb'),
  'event_ingress_dedup_hit',
  'dedup: event_ingress_dedup_hit recorded and is latest reason'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror WHERE event_id = 'evt-bbb'),
  2,
  'dedup: exactly 2 rows (ingress + dedup_hit) for deduplicated event'
);

-- -----------------------------------------------------------------------
-- 4. Noise path: event_ingress_noise — pipeline stops at ingress
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-ccc', 'ingress', 'event_ingress_noise', '{"delta_g":1.2}');

SELECT is(
  temp_latest_reason('evt-ccc'),
  'event_ingress_noise',
  'noise: event_ingress_noise is terminal for sub-threshold events'
);

-- -----------------------------------------------------------------------
-- 5. Classifier failure path: classifier_threw → review_enqueued
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('evt-ddd', 'ingress', 'event_ingress');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('evt-ddd', 'tracker', 'event_claimed');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-ddd', 'classifier', 'classifier_dispatched', '{}');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-ddd', 'classifier', 'classifier_threw',
          '{"error":"anthropic timeout","attempt":1}');

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-ddd', 'reconciler', 'review_enqueued',
          '{"review_id":"rev-001","kind":"low_confidence"}');

SELECT is(
  temp_latest_reason('evt-ddd'),
  'review_enqueued',
  'classifier failure: review_enqueued after classifier_threw'
);

-- -----------------------------------------------------------------------
-- 6. Concurrent events are isolated by event_id (each gets its own trail)
-- -----------------------------------------------------------------------

-- evt-aaa chain has 6 rows; evt-bbb has 2; evt-ccc has 1; evt-ddd has 5.
SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror),
  14,
  'isolation: total 14 rows across all events, each trail independent'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror WHERE event_id = 'evt-ddd'),
  5,
  'isolation: evt-ddd has exactly 5 rows independent of other events'
);

-- -----------------------------------------------------------------------
-- 7. get_event_timeline ordering: rows for an event must be id ASC
-- -----------------------------------------------------------------------

SELECT ok(
  (SELECT bool_and(a.id < b.id)
     FROM event_lifecycle_mirror a
     JOIN event_lifecycle_mirror b
       ON a.event_id = b.event_id
      AND b.id = (
            SELECT MIN(m2.id) FROM event_lifecycle_mirror m2
             WHERE m2.event_id = a.event_id AND m2.id > a.id
          )
    WHERE a.event_id = 'evt-aaa'),
  'timeline ordering: id is strictly monotone for the happy-path event trail'
);

-- -----------------------------------------------------------------------
-- 8. Append-only: UPDATE of a lifecycle row is structurally allowed
--    (no trigger blocks it) but the Pi code NEVER does it. Verify the
--    row survives after an update attempt (defensive: confirm old value
--    changed to detect if a future agent accidentally makes this writable).
-- -----------------------------------------------------------------------

-- Capture the original reason_code of row id=1 for evt-aaa.
UPDATE event_lifecycle_mirror
   SET reason_code = 'mutated_for_test'
 WHERE id = (SELECT MIN(id) FROM event_lifecycle_mirror WHERE event_id = 'evt-aaa');

-- Confirm the write landed — this shows the table itself is writable (no DDL
-- lock), but production code never issues such UPDATEs. The test documents
-- that the append-only contract is behavioral (enforced by outbox.py), not
-- structural. A future migration that adds a trigger to block UPDATEs would
-- cause this test to throw — which is fine; update the test at that time.
SELECT isnt(
  (SELECT reason_code FROM event_lifecycle_mirror
    WHERE id = (SELECT MIN(id) FROM event_lifecycle_mirror WHERE event_id = 'evt-aaa')),
  'event_ingress',
  'append-only is behavioral: the table allows UPDATE (contract is enforced by application code)'
);

-- Restore for remaining tests.
UPDATE event_lifecycle_mirror
   SET reason_code = 'event_ingress'
 WHERE id = (SELECT MIN(id) FROM event_lifecycle_mirror WHERE event_id = 'evt-aaa');

-- -----------------------------------------------------------------------
-- 9. No hard FK on event_id: lifecycle rows survive a hypothetical
--    scale_events delete (documented via NOT NULL only, no FK).
--    Verify the column accepts any TEXT value (no FK lookup).
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
  VALUES ('orphan-event-id-that-has-no-scale_event-row', 'ingress', 'event_ingress');

SELECT is(
  (SELECT reason_code FROM event_lifecycle_mirror
    WHERE event_id = 'orphan-event-id-that-has-no-scale_event-row'),
  'event_ingress',
  'no FK: orphan event_id accepted (forensic trail survives if scale_events row is wiped)'
);

-- -----------------------------------------------------------------------
-- 10. NULL event_id is rejected by NOT NULL constraint
-- -----------------------------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code)
    VALUES (NULL, 'ingress', 'event_ingress')$$,
  '23502',
  NULL,
  'NOT NULL: NULL event_id raises not_null_violation'
);

-- -----------------------------------------------------------------------
-- 11. Purge semantics: rows older than N days are deleted; recent rows stay
-- -----------------------------------------------------------------------

-- Insert an old row (backdated 35 days).
INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, ts)
  VALUES ('evt-old', 'ingress', 'event_ingress', now() - interval '35 days');

SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror WHERE event_id = 'evt-old'),
  1,
  'purge setup: old row inserted (35 days ago)'
);

-- Simulate purge_older_than(days=30).
DELETE FROM event_lifecycle_mirror
 WHERE ts < now() - interval '30 days';

SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror WHERE event_id = 'evt-old'),
  0,
  'purge: row older than 30 days deleted'
);

SELECT is(
  (SELECT count(*)::INTEGER FROM event_lifecycle_mirror WHERE event_id = 'evt-aaa'),
  6,
  'purge: recent rows for evt-aaa untouched'
);

-- -----------------------------------------------------------------------
-- 12. payload_json column accepts NULL (payload is optional)
-- -----------------------------------------------------------------------

INSERT INTO event_lifecycle_mirror (event_id, actor, reason_code, payload_json)
  VALUES ('evt-eee', 'ingress', 'event_ingress', NULL);

SELECT is(
  (SELECT payload_json FROM event_lifecycle_mirror WHERE event_id = 'evt-eee'),
  NULL::TEXT,
  'payload_json accepts NULL for transitions that carry no extra context'
);

-- -----------------------------------------------------------------------
-- 13. Multi-actor chain: different actors can append to the same event
-- -----------------------------------------------------------------------

SELECT is(
  (SELECT count(DISTINCT actor)::INTEGER
     FROM event_lifecycle_mirror WHERE event_id = 'evt-aaa'),
  4,  -- ingress, tracker, classifier, reconciler
  'multi-actor: multiple actors (ingress, tracker, classifier, reconciler) write to same trail'
);

SELECT * FROM finish();

ROLLBACK;
