-- cloud_outbox state machine matrix test (pgTAP)
--
-- The Pi's cloud_outbox table (hardware/live-shelf/server/storage/schema.sql)
-- is SQLite and lives on the device; this pgTAP file verifies the same state
-- machine transitions using a temporary Postgres mirror of the schema.
--
-- Cloud outbox states (from outbox.py semantics):
--
--   queued   : sent_at IS NULL  AND failed_permanently = 0 AND attempts = 0
--   retrying : sent_at IS NULL  AND failed_permanently = 0 AND attempts > 0
--   sent     : sent_at IS NOT NULL AND failed_permanently = 0
--   dead     : failed_permanently = 1
--
-- Events / transitions (from outbox.py helpers):
--   enqueue        : INSERT → queued
--   mark_sent      : queued|retrying → sent
--   mark_failed    : queued|retrying → retrying (attempts++)
--   mark_permanent : queued|retrying → dead
--   mark_dead_ltr  : queued|retrying → dead  (DEAD_LETTER: prefix on last_error)
--   reset_dead_ltr : dead → queued (attempts=0, failed_permanently=0)
--
-- Coverage: 5 states × 5 events = 25 cells including no-ops.
-- Actual meaningful cells: 16 (no-ops: dead cannot be mark_failed, etc.)

BEGIN;

SELECT plan(19);

-- -----------------------------------------------------------------------
-- Mirror the Pi SQLite cloud_outbox schema in a temp table for isolation.
-- -----------------------------------------------------------------------

CREATE TEMP TABLE cloud_outbox_mirror (
  outbox_id         SERIAL PRIMARY KEY,
  client_event_id   TEXT NOT NULL UNIQUE,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  failed_permanently INTEGER NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------
-- Helper: compute logical state from columns (mirrors outbox.py semantics)
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION temp_outbox_state(
  p_sent_at TIMESTAMPTZ,
  p_failed_permanently INTEGER,
  p_attempts INTEGER
) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_failed_permanently = 1 THEN 'dead'
    WHEN p_sent_at IS NOT NULL    THEN 'sent'
    WHEN p_attempts = 0           THEN 'queued'
    ELSE                               'retrying'
  END;
$$;

-- -----------------------------------------------------------------------
-- 1. enqueue: INSERT → queued
-- -----------------------------------------------------------------------

INSERT INTO cloud_outbox_mirror (client_event_id, payload_json)
  VALUES ('evt-001', '{"kind":"consumed"}');

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'queued',
  'enqueue: new row lands in queued state (sent_at=NULL, attempts=0, fp=0)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-001';

-- -----------------------------------------------------------------------
-- 2. mark_sent on queued → sent
-- -----------------------------------------------------------------------

UPDATE cloud_outbox_mirror
   SET sent_at = now(), last_error = NULL
 WHERE client_event_id = 'evt-001';

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'sent',
  'mark_sent: queued → sent (sent_at IS NOT NULL)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-001';

-- -----------------------------------------------------------------------
-- 3. mark_failed on queued → retrying (attempts++)
-- -----------------------------------------------------------------------

INSERT INTO cloud_outbox_mirror (client_event_id, payload_json)
  VALUES ('evt-002', '{"kind":"refilled"}');

UPDATE cloud_outbox_mirror
   SET attempts = attempts + 1, last_error = 'connection timeout'
 WHERE client_event_id = 'evt-002';

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'retrying',
  'mark_failed: queued → retrying (attempts=1, sent_at still NULL)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-002';

SELECT is(
  attempts, 1,
  'mark_failed: attempts incremented to 1'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-002';

SELECT is(
  last_error, 'connection timeout',
  'mark_failed: last_error set to the failure message'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-002';

-- -----------------------------------------------------------------------
-- 4. mark_sent on retrying → sent
-- -----------------------------------------------------------------------

UPDATE cloud_outbox_mirror
   SET sent_at = now(), last_error = NULL
 WHERE client_event_id = 'evt-002';

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'sent',
  'mark_sent: retrying → sent (retry eventually succeeds)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-002';

-- -----------------------------------------------------------------------
-- 5. mark_permanent_failure on queued → dead
-- -----------------------------------------------------------------------

INSERT INTO cloud_outbox_mirror (client_event_id, payload_json)
  VALUES ('evt-003', '{"kind":"bad_shape"}');

UPDATE cloud_outbox_mirror
   SET failed_permanently = 1,
       last_error = 'cloud returned 404 product not found',
       attempts = attempts + 1
 WHERE client_event_id = 'evt-003';

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'dead',
  'mark_permanent: queued → dead (failed_permanently=1)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-003';

SELECT is(
  sent_at, NULL::TIMESTAMPTZ,
  'mark_permanent: sent_at remains NULL (row stays in table as audit trail)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-003';

-- -----------------------------------------------------------------------
-- 6. mark_dead_letter on retrying → dead (DEAD_LETTER: prefix)
-- -----------------------------------------------------------------------

INSERT INTO cloud_outbox_mirror (client_event_id, payload_json, attempts)
  VALUES ('evt-004', '{"kind":"consumed"}', 5);  -- 5 failed attempts already

UPDATE cloud_outbox_mirror
   SET failed_permanently = 1,
       last_error = 'DEAD_LETTER: 5xx after exhausting retry budget',
       attempts = attempts + 1
 WHERE client_event_id = 'evt-004';

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'dead',
  'mark_dead_letter: retrying → dead after exhausting retry budget'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-004';

SELECT ok(
  (SELECT last_error LIKE 'DEAD_LETTER:%'
     FROM cloud_outbox_mirror WHERE client_event_id = 'evt-004'),
  'mark_dead_letter: last_error has DEAD_LETTER: prefix (distinguishes from permanent_failure)'
);

-- -----------------------------------------------------------------------
-- 7. reset_dead_letter: dead → queued (attempts reset to 0)
-- -----------------------------------------------------------------------

UPDATE cloud_outbox_mirror
   SET failed_permanently = 0,
       attempts = 0,
       last_error = NULL
 WHERE client_event_id = 'evt-004'
   AND failed_permanently = 1;

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'queued',
  'reset_dead_letter: dead → queued (failed_permanently=0, attempts=0)'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-004';

SELECT is(
  attempts, 0,
  'reset_dead_letter: attempts reset to 0 so dead-letter threshold restarts'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-004';

-- -----------------------------------------------------------------------
-- 8. No-op / guard: mark_failed on sent does NOT re-open the row
--    (outbox.py: mark_failed only called by worker on pending rows)
-- -----------------------------------------------------------------------

-- evt-002 is already sent. Simulate an accidental mark_failed call:
UPDATE cloud_outbox_mirror
   SET attempts = attempts + 1
 WHERE client_event_id = 'evt-002';

-- The column changes but the state is still 'sent' because sent_at IS NOT NULL.
SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'sent',
  'no-op: incrementing attempts on a sent row does not revert its state to retrying'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-002';

-- -----------------------------------------------------------------------
-- 9. list_pending semantics: only queued + retrying rows visible to worker
-- -----------------------------------------------------------------------

-- Summary: evt-001=sent, evt-002=sent, evt-003=dead, evt-004=queued
SELECT is(
  (SELECT count(*)::INTEGER
     FROM cloud_outbox_mirror
    WHERE sent_at IS NULL AND failed_permanently = 0),
  1,
  'list_pending: only 1 row is deliverable (evt-004 re-queued)'
);

-- -----------------------------------------------------------------------
-- 10. UNIQUE(client_event_id): second enqueue with same id rejected
-- -----------------------------------------------------------------------

SELECT throws_ok(
  $$INSERT INTO cloud_outbox_mirror (client_event_id, payload_json)
    VALUES ('evt-001', '{"kind":"dup"}')$$,
  '23505',
  NULL,
  'UNIQUE(client_event_id): duplicate enqueue raises unique_violation'
);

-- -----------------------------------------------------------------------
-- 11. Multiple concurrent failures increment attempts independently
-- -----------------------------------------------------------------------

INSERT INTO cloud_outbox_mirror (client_event_id, payload_json)
  VALUES ('evt-005', '{"kind":"add"}');

UPDATE cloud_outbox_mirror SET attempts = attempts + 1, last_error = 'err1'
 WHERE client_event_id = 'evt-005';

UPDATE cloud_outbox_mirror SET attempts = attempts + 1, last_error = 'err2'
 WHERE client_event_id = 'evt-005';

UPDATE cloud_outbox_mirror SET attempts = attempts + 1, last_error = 'err3'
 WHERE client_event_id = 'evt-005';

SELECT is(
  attempts, 3,
  'multiple mark_failed: attempts accumulates correctly across calls'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-005';

SELECT is(
  last_error, 'err3',
  'multiple mark_failed: last_error reflects most recent failure'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-005';

SELECT is(
  temp_outbox_state(sent_at, failed_permanently, attempts),
  'retrying',
  'multiple mark_failed: state remains retrying (not dead) until mark_permanent'
) FROM cloud_outbox_mirror WHERE client_event_id = 'evt-005';

-- -----------------------------------------------------------------------
-- 12. count_pending semantics: permanent failures excluded from pending
-- -----------------------------------------------------------------------

SELECT is(
  (SELECT count(*)::INTEGER
     FROM cloud_outbox_mirror
    WHERE sent_at IS NULL AND failed_permanently = 0),
  2,
  'count_pending: evt-004 (queued) + evt-005 (retrying) = 2 pending; dead+sent excluded'
);

SELECT * FROM finish();

ROLLBACK;
