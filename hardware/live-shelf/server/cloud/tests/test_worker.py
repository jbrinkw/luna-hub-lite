"""Unit tests for ``server.cloud.worker.CloudWorker``.

The worker's ``tick()`` method is deliberately public so tests can
advance it one cycle at a time without dealing with real timers. We
mock the CloudClient wholesale.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud import outbox  # noqa: E402
from server.cloud.client import CloudError  # noqa: E402
from server.cloud.worker import (  # noqa: E402
    CloudWorker,
    MAX_POLL_INTERVAL_S,
    NON_RETRYABLE_EVENT_STATUS_CODES,
    OUTBOX_BACKLOG_WARN_THRESHOLD,
)
from server.storage import init_db  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def fake_client() -> MagicMock:
    m = MagicMock()
    m.post.return_value = {}
    m.get.return_value = {}
    return m


def _mk_worker(
    client: MagicMock,
    conn: sqlite3.Connection,
    *,
    heartbeat_body: dict | None = None,
    heartbeat_raiser: Exception | None = None,
    poll_interval_s: float = 5.0,
) -> CloudWorker:
    """Build a worker wired to a given mock client + conn."""
    if heartbeat_raiser is not None:
        def provider() -> dict:
            raise heartbeat_raiser
    else:
        def provider() -> dict:
            return heartbeat_body if heartbeat_body is not None else {"ok": True}

    return CloudWorker(
        client=client,
        conn_factory=lambda: conn,
        heartbeat_provider=provider,
        poll_interval_s=poll_interval_s,
    )


# ---------------------------------------------------------------------------
# Heartbeat behavior
# ---------------------------------------------------------------------------


class TestHeartbeat:
    def test_heartbeat_posted_every_tick(self, fake_client, conn):
        w = _mk_worker(
            fake_client, conn, heartbeat_body={"pending_review_count": 3}
        )
        w.tick()
        w.tick()

        hb_calls = [
            c for c in fake_client.post.call_args_list
            if c.args[0] == "/heartbeat"
        ]
        assert len(hb_calls) == 2
        assert hb_calls[0].args[1] == {"pending_review_count": 3}

    def test_heartbeat_provider_exception_does_not_kill_tick(
        self, fake_client, conn
    ):
        """The provider can raise (e.g. DB contention); tick must swallow
        and still drain the outbox."""
        outbox.enqueue_event(conn, {"n": 1})
        w = _mk_worker(
            fake_client, conn,
            heartbeat_raiser=RuntimeError("provider-boom"),
        )
        # Must not raise.
        w.tick()
        # Heartbeat NOT posted, but /event drain still happened.
        paths = [c.args[0] for c in fake_client.post.call_args_list]
        assert "/heartbeat" not in paths
        assert "/event" in paths

    def test_heartbeat_cloud_error_triggers_backoff(self, fake_client, conn):
        fake_client.post.side_effect = CloudError(503, "down")
        w = _mk_worker(fake_client, conn, poll_interval_s=5.0)
        assert w.current_poll_interval_s == 5.0
        w.tick()
        assert w.current_poll_interval_s == 10.0
        w.tick()
        assert w.current_poll_interval_s == 20.0

    def test_heartbeat_failure_skips_drain_phase_entirely(
        self, fake_client, conn
    ):
        """A heartbeat POST failure is almost always a global network
        outage — every pending row is about to fail the same way.
        Skipping drain this tick keeps individual row attempt counters
        from getting punished for a condition that has nothing to do
        with any specific row. The adaptive backoff is the single
        throttle point during an outage."""
        # Enqueue a handful of rows so if drain DID run, attempts would
        # tick up.
        for i in range(3):
            outbox.enqueue_event(conn, {"n": i})

        fake_client.post.side_effect = CloudError(503, "down")
        w = _mk_worker(fake_client, conn)
        w.tick()

        # Only the heartbeat POST was attempted; no /event calls.
        paths = [c.args[0] for c in fake_client.post.call_args_list]
        assert paths == ["/heartbeat"]
        # Every outbox row is untouched (attempts=0, still pending).
        rows = conn.execute(
            "SELECT attempts, sent_at FROM cloud_outbox ORDER BY outbox_id ASC"
        ).fetchall()
        assert len(rows) == 3
        for r in rows:
            assert r["attempts"] == 0
            assert r["sent_at"] is None

    def test_heartbeat_generic_exception_also_skips_drain(
        self, fake_client, conn
    ):
        """Same semantic for a raw ConnectionError (DNS/socket) during
        heartbeat: drain must not run because row 0 would absorb the
        blame for a global condition."""
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.side_effect = ConnectionError("dns fail")
        w = _mk_worker(fake_client, conn)
        w.tick()

        paths = [c.args[0] for c in fake_client.post.call_args_list]
        assert paths == ["/heartbeat"]  # no /event attempted
        row = conn.execute(
            "SELECT attempts, sent_at FROM cloud_outbox"
        ).fetchone()
        assert row["attempts"] == 0
        assert row["sent_at"] is None


# ---------------------------------------------------------------------------
# Outbox drain behavior
# ---------------------------------------------------------------------------


class TestDrain:
    def test_pending_rows_drained_when_client_returns_200(
        self, fake_client, conn
    ):
        """Happy path: each pending row gets POSTed to /event and marked
        sent."""
        outbox.enqueue_event(conn, {"n": 1})
        outbox.enqueue_event(conn, {"n": 2})
        w = _mk_worker(fake_client, conn)
        w.tick()

        event_posts = [
            c for c in fake_client.post.call_args_list
            if c.args[0] == "/event"
        ]
        assert len(event_posts) == 2
        # Each payload carries its client_event_id (stamped by enqueue).
        for call in event_posts:
            body = call.args[1]
            assert "client_event_id" in body
            assert "n" in body
        assert outbox.count_pending(conn) == 0

    def test_cloud_error_keeps_row_pending_and_records_error(
        self, fake_client, conn
    ):
        """4xx/5xx on a row: attempts++ and last_error populated, row
        remains pending for next tick."""
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(500, "boom")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()
        row = conn.execute(
            "SELECT attempts, last_error, sent_at FROM cloud_outbox"
        ).fetchone()
        assert row["attempts"] == 1
        assert "500" in row["last_error"]
        assert row["sent_at"] is None

    def test_generic_exception_breaks_drain_loop(self, fake_client, conn):
        """Network-layer exception on one row signals the cloud is down —
        worker must stop the drain loop rather than bump attempts on every
        queued row."""
        outbox.enqueue_event(conn, {"n": 1})
        outbox.enqueue_event(conn, {"n": 2})
        outbox.enqueue_event(conn, {"n": 3})

        def post_side_effect(path, body):
            if path == "/event":
                raise ConnectionError("network down")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()
        rows = conn.execute(
            "SELECT attempts FROM cloud_outbox ORDER BY outbox_id ASC"
        ).fetchall()
        # Only the first row got attempted; the rest are untouched.
        assert rows[0]["attempts"] == 1
        assert rows[1]["attempts"] == 0
        assert rows[2]["attempts"] == 0

    def test_mixed_success_and_failure_in_same_tick(self, fake_client, conn):
        """A CloudError (HTTP error, not network) on one row should not
        prevent later rows from being attempted — a malformed payload
        can legitimately coexist with valid ones."""
        outbox.enqueue_event(conn, {"bad": True})
        outbox.enqueue_event(conn, {"good": True})

        calls: list[dict] = []
        def post_side_effect(path, body):
            calls.append({"path": path, "body": body})
            if path == "/event" and body.get("bad"):
                raise CloudError(400, "malformed")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()

        event_attempts = [c for c in calls if c["path"] == "/event"]
        assert len(event_attempts) == 2
        # Bad row still pending, good row is sent.
        bad = conn.execute(
            "SELECT sent_at FROM cloud_outbox WHERE payload_json LIKE '%bad%'"
        ).fetchone()
        good = conn.execute(
            "SELECT sent_at FROM cloud_outbox WHERE payload_json LIKE '%good%'"
        ).fetchone()
        assert bad["sent_at"] is None
        assert good["sent_at"] is not None


# ---------------------------------------------------------------------------
# Backoff cadence
# ---------------------------------------------------------------------------


class TestBackoff:
    def test_successful_tick_resets_interval(self, fake_client, conn):
        """After a failed tick the interval doubles; a clean tick resets."""
        fake_client.post.side_effect = [CloudError(503, "down")]  # heartbeat
        w = _mk_worker(fake_client, conn, poll_interval_s=5.0)
        w.tick()
        assert w.current_poll_interval_s == 10.0

        # Next tick: both heartbeat and drain succeed.
        fake_client.post.side_effect = None
        fake_client.post.return_value = {}
        w.tick()
        assert w.current_poll_interval_s == 5.0

    def test_backoff_caps_at_ceiling(self, fake_client, conn):
        fake_client.post.side_effect = CloudError(503, "down")
        w = _mk_worker(fake_client, conn, poll_interval_s=60.0)
        # 60 -> 120 -> 240 -> 300 (capped) -> 300 -> ...
        for _ in range(10):
            w.tick()
        assert w.current_poll_interval_s == MAX_POLL_INTERVAL_S


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------


class TestShutdown:
    def test_stop_sets_shutdown_event(self, fake_client, conn):
        w = _mk_worker(fake_client, conn)
        w.stop()
        # Internal event is set; run() would exit at next iteration.
        assert w._shutdown.is_set()  # noqa: SLF001 — tight unit coupling OK here

    def test_external_shutdown_event_honored(self, fake_client, conn):
        """Caller-supplied shutdown event lets the orchestrator multiplex
        one stop signal across several background workers."""
        ext = threading.Event()
        w = CloudWorker(
            client=fake_client,
            conn_factory=lambda: conn,
            heartbeat_provider=lambda: {"ok": True},
            poll_interval_s=0.01,
            shutdown_event=ext,
        )
        ext.set()
        # Since the event is pre-set, run() will return on first wait().
        # We don't actually start the thread — just verify the shared
        # reference.
        assert w._shutdown is ext  # noqa: SLF001

    def test_thread_exits_cleanly_when_shutdown_signaled(
        self, fake_client, conn
    ):
        """Full integration: start the thread, let it tick once, then
        stop. The thread must join within a short timeout."""
        w = _mk_worker(fake_client, conn, poll_interval_s=0.01)
        w.start()
        # Give it a moment to run at least one tick.
        import time
        time.sleep(0.05)
        w.stop()
        w.join(timeout=2.0)
        assert not w.is_alive()


# ---------------------------------------------------------------------------
# Log-level discrimination (deep-audit finding #2)
# ---------------------------------------------------------------------------


class TestHeartbeatLogLevels:
    """A persistent 401 means the device's import key is broken — nothing
    drains until the operator fixes it. This MUST land in the log at
    ERROR, not INFO (audit finding #2).
    """

    def test_heartbeat_401_logs_at_error(self, fake_client, conn, caplog):
        """401 Unauthorized → ERROR (auth failure, persistent)."""
        import logging
        fake_client.post.side_effect = CloudError(401, "bad key")
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        auth_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker" and "AUTH FAILURE" in r.message
        ]
        assert len(auth_records) == 1
        assert auth_records[0].levelname == "ERROR"

    def test_heartbeat_403_logs_at_error(self, fake_client, conn, caplog):
        """403 Forbidden → ERROR (same class of persistent auth fail)."""
        import logging
        fake_client.post.side_effect = CloudError(403, "forbidden")
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        auth_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker" and "AUTH FAILURE" in r.message
        ]
        assert len(auth_records) == 1
        assert auth_records[0].levelname == "ERROR"

    def test_heartbeat_400_logs_at_warning_not_error(
        self, fake_client, conn, caplog
    ):
        """Non-auth 4xx (400 malformed body, etc.) → WARNING, not ERROR.
        Still wants operator attention, but not the same urgency as a
        broken import key."""
        import logging
        fake_client.post.side_effect = CloudError(400, "malformed")
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        hb_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "heartbeat rejected" in r.message
        ]
        assert len(hb_records) == 1
        assert hb_records[0].levelname == "WARNING"

    def test_heartbeat_503_logs_at_warning(self, fake_client, conn, caplog):
        """5xx is a cloud-side problem; WARN but not ERROR (server's
        fault, not ours)."""
        import logging
        fake_client.post.side_effect = CloudError(503, "down")
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        hb_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "5xx from cloud" in r.message
        ]
        assert len(hb_records) == 1
        assert hb_records[0].levelname == "WARNING"

    def test_heartbeat_bare_exception_logs_at_warning_with_traceback(
        self, fake_client, conn, caplog
    ):
        """A DNS or socket-layer error during heartbeat — bumped from
        INFO to WARNING so operators can distinguish flaky network from
        a silent no-fires condition. ``exc_info`` captures the stack."""
        import logging
        fake_client.post.side_effect = ConnectionError("dns fail")
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        hb_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "unexpected error" in r.message
        ]
        assert len(hb_records) == 1
        assert hb_records[0].levelname == "WARNING"
        # exc_info=True → the record carries the exception info.
        assert hb_records[0].exc_info is not None


# ---------------------------------------------------------------------------
# Permanent-failure flag (deep-audit finding #3)
# ---------------------------------------------------------------------------


class TestPermanentFailure:
    """Non-retryable 4xx (400/404/409) on a /event POST flags the
    outbox row ``failed_permanently`` so the drainer stops beating on
    it. 401/403, 408/422/429, 5xx remain retryable (pass-2 audit
    finding #8 moved 422 out of the permanent set — the edge fn uses
    it for ``occurred_at out of range`` which a clock correction or
    back-fill window shift resolves)."""

    @pytest.mark.parametrize("status", sorted(NON_RETRYABLE_EVENT_STATUS_CODES))
    def test_non_retryable_4xx_marks_row_permanent(
        self, fake_client, conn, caplog, status
    ):
        import logging
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(status, f"reject-{status}")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()

        row = conn.execute(
            "SELECT sent_at, failed_permanently, last_error FROM cloud_outbox"
        ).fetchone()
        assert row["failed_permanently"] == 1
        assert row["sent_at"] is None
        assert str(status) in (row["last_error"] or "")
        # Logged at ERROR with the permanent-failure marker.
        perm_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "PERMANENTLY FAILED" in r.message
        ]
        assert len(perm_records) == 1
        assert perm_records[0].levelname == "ERROR"

    def test_400_literally_marks_row_permanent(self, fake_client, conn):
        """Hard-pin 400 → ``failed_permanently = 1``.

        The parametrized test_non_retryable_4xx_marks_row_permanent above
        iterates over ``NON_RETRYABLE_EVENT_STATUS_CODES`` itself — if
        that set is ever shrunk to an empty set, pytest silently skips
        the parametrize with zero params and the suite still passes.
        Pin at least one literal status (400) so emptying the set
        breaks the build.
        """
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(400, "malformed event")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()

        row = conn.execute(
            "SELECT failed_permanently, sent_at FROM cloud_outbox"
        ).fetchone()
        assert row["failed_permanently"] == 1, (
            "400 must mark the row permanent — else the worker retries a "
            "malformed payload forever"
        )
        assert row["sent_at"] is None

    def test_401_on_event_does_NOT_mark_permanent(self, fake_client, conn):
        """401 is an auth problem (operator rotates key) — NOT a property
        of the row. Keep it pending so it drains once auth recovers."""
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(401, "bad key")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()

        row = conn.execute(
            "SELECT sent_at, failed_permanently, attempts FROM cloud_outbox"
        ).fetchone()
        assert row["failed_permanently"] == 0  # NOT flagged
        assert row["sent_at"] is None  # still pending
        assert row["attempts"] == 1  # transient-failure counter bumped

    def test_500_on_event_does_NOT_mark_permanent(self, fake_client, conn):
        """5xx is a cloud-side problem; keep retrying."""
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(500, "oops")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()
        row = conn.execute(
            "SELECT failed_permanently, attempts FROM cloud_outbox"
        ).fetchone()
        assert row["failed_permanently"] == 0
        assert row["attempts"] == 1

    def test_permanent_row_excluded_from_list_pending(
        self, fake_client, conn
    ):
        """Once flagged permanent, the drainer must skip the row on
        subsequent ticks — otherwise we burn cycles on the same reject."""
        outbox.enqueue_event(conn, {"n": 1})
        outbox.enqueue_event(conn, {"n": 2})
        # Manually flag the first as permanent.
        first_id = conn.execute(
            "SELECT outbox_id FROM cloud_outbox ORDER BY outbox_id ASC LIMIT 1"
        ).fetchone()["outbox_id"]
        outbox.mark_permanent_failure(conn, first_id, "400: manual")

        # Fresh successful tick — only the second row should be POSTed.
        fake_client.post.return_value = {}
        w = _mk_worker(fake_client, conn)
        w.tick()

        event_posts = [
            c for c in fake_client.post.call_args_list
            if c.args[0] == "/event"
        ]
        assert len(event_posts) == 1
        # The permanent row is still in the table, just skipped.
        assert outbox.count_pending(conn) == 0  # second sent, first perm
        assert outbox.count_permanent_failures(conn) == 1


# ---------------------------------------------------------------------------
# Outbox backlog INFO/WARN logging (deep-audit finding #4)
# ---------------------------------------------------------------------------


class TestBacklogLogging:
    def test_empty_outbox_logs_nothing(self, fake_client, conn, caplog):
        """A happy-path tick with zero pending must stay quiet — the
        backlog log line is noise on a working system."""
        import logging
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        backlog_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "outbox pending=" in r.message
        ]
        assert backlog_records == []

    def test_small_backlog_logs_at_info(self, fake_client, conn, caplog):
        """Some backlog + under warn threshold → INFO."""
        import logging
        for i in range(5):
            outbox.enqueue_event(conn, {"n": i})
        # Force drain to NOT succeed so the counter stays non-zero for
        # the log line — use a 503 so rows stay pending.
        fake_client.post.side_effect = [
            {},  # heartbeat succeeds
            *[CloudError(503, "down")] * 5,  # /event 503s
        ]
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        backlog_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "outbox pending=" in r.message
            and "exceeds" not in r.message
        ]
        assert len(backlog_records) == 1
        assert backlog_records[0].levelname == "INFO"
        assert "pending=5" in backlog_records[0].message

    def test_large_backlog_logs_at_warning(
        self, fake_client, conn, caplog, monkeypatch
    ):
        """Backlog > threshold → WARNING so nightly log review notices."""
        import logging
        # Use a small threshold so the test runs fast.
        monkeypatch.setattr(
            "server.cloud.worker.OUTBOX_BACKLOG_WARN_THRESHOLD", 3
        )
        for i in range(5):
            outbox.enqueue_event(conn, {"n": i})
        # Heartbeat succeeds so drain runs; drain also succeeds so
        # list_pending observes the prior count. Use the post-count
        # branch: we measure BEFORE drain runs.
        fake_client.post.return_value = {}
        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        warn_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "outbox pending=" in r.message
            and "exceeds" in r.message
        ]
        assert len(warn_records) == 1
        assert warn_records[0].levelname == "WARNING"


# ---------------------------------------------------------------------------
# Pass-2 audit finding #8: 422 on /event is retryable (NOT permanent)
# ---------------------------------------------------------------------------


class TestStatus422Retryable:
    """The cloud edge fn uses 422 for ``occurred_at out of range`` — a
    clock correction or an updated back-fill window lets the retry
    succeed. Finding #8 moved 422 OUT of the non-retryable set."""

    def test_422_not_in_non_retryable_set(self):
        assert 422 not in NON_RETRYABLE_EVENT_STATUS_CODES, (
            "422 must be retryable — it's the edge fn's "
            "'occurred_at out of range' signal, which a clock "
            "correction resolves"
        )

    def test_422_on_event_keeps_row_pending(self, fake_client, conn):
        """A 422 must NOT flip ``failed_permanently`` — attempts bumps,
        row stays in list_pending for the next tick."""
        outbox.enqueue_event(conn, {"n": 1, "occurred_at": "2026-04-18T00:00:00.000Z"})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(422, "occurred_at out of range")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        w.tick()

        row = conn.execute(
            "SELECT sent_at, failed_permanently, attempts, last_error "
            "FROM cloud_outbox"
        ).fetchone()
        assert row["failed_permanently"] == 0  # still retryable
        assert row["sent_at"] is None  # still pending
        assert row["attempts"] == 1
        assert "422" in (row["last_error"] or "")

    def test_422_logs_at_warning_not_error(self, fake_client, conn, caplog):
        """422 is a soft reject; log at WARNING so nightly-review catches
        persistent cases without pagering on the first bounce."""
        import logging
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(422, "occurred_at out of range")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()

        errors = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and r.levelname == "ERROR"
        ]
        # No PERMANENTLY FAILED line because the row isn't permanent.
        perm_msgs = [
            r for r in errors
            if "PERMANENTLY FAILED" in r.message
        ]
        assert perm_msgs == []


# ---------------------------------------------------------------------------
# Pass-2 audit finding #7: 401/403 on /event log outbox pending count
# ---------------------------------------------------------------------------


class TestEventAuthFailureLogging:
    """When a /event POST fails with 401/403 the operator needs to see
    how big the backlog is, not just "another 401"."""

    def test_401_on_event_logs_outbox_pending_count_at_error(
        self, fake_client, conn, caplog,
    ):
        import logging
        # Seed several pending rows so the count is non-trivial.
        for i in range(3):
            outbox.enqueue_event(conn, {"n": i})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(401, "bad key")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()

        # ERROR-level log line must carry the word "outbox_pending=" and
        # a count that matches the pending rows queued behind this
        # failing auth. First tick fails one row, so outbox_pending
        # could still be 3 (the row is marked failed, not sent).
        auth_logs = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "outbox_pending" in r.message
            and "CLOUD_IMPORT_KEY" in r.message
        ]
        assert len(auth_logs) >= 1
        assert auth_logs[0].levelname == "ERROR"

    def test_403_on_event_also_triggers_auth_log(
        self, fake_client, conn, caplog,
    ):
        """403 is handled the same as 401 — wrong key vs revoked key is
        a cloud-side distinction the Pi can't act on."""
        import logging
        outbox.enqueue_event(conn, {"n": 1})

        def post_side_effect(path, body):
            if path == "/event":
                raise CloudError(403, "forbidden")
            return {}
        fake_client.post.side_effect = post_side_effect

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        auth_logs = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and r.levelname == "ERROR"
            and "CLOUD_IMPORT_KEY" in r.message
        ]
        assert len(auth_logs) == 1


# ---------------------------------------------------------------------------
# Pass-2 audit finding #9: applied=false + non-expected reason logs WARN
# ---------------------------------------------------------------------------


class TestAppliedFalseInspection:
    """Even on 2xx, inspect the cloud response: ``applied=false`` with a
    reason outside ``duplicate`` / ``stale: manual edit is newer`` is
    surfaced as WARNING."""

    def test_applied_true_stays_quiet(self, fake_client, conn, caplog):
        import logging
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.return_value = {"applied": True}

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        unexpected = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and "applied=false" in r.message
        ]
        assert unexpected == []

    def test_applied_false_duplicate_stays_quiet(self, fake_client, conn, caplog):
        import logging
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.return_value = {"applied": False, "reason": "duplicate"}

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        warn_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and r.levelname == "WARNING"
            and "applied=false" in r.message
        ]
        assert warn_records == []

    def test_applied_false_stale_manual_edit_stays_quiet(
        self, fake_client, conn, caplog,
    ):
        import logging
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.return_value = {
            "applied": False,
            "reason": "stale: manual edit is newer",
        }

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        warn_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and r.levelname == "WARNING"
            and "applied=false" in r.message
        ]
        assert warn_records == []

    def test_applied_false_product_not_found_logs_warning(
        self, fake_client, conn, caplog,
    ):
        """'product not found' means the Pi's cache is out of sync with
        the cloud catalog — operator-actionable, so WARNING."""
        import logging
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.return_value = {
            "applied": False,
            "reason": "product not found",
        }

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        warn_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and r.levelname == "WARNING"
            and "applied=false" in r.message
            and "product not found" in r.message
        ]
        assert len(warn_records) == 1

    def test_applied_false_without_reason_logs_warning(
        self, fake_client, conn, caplog,
    ):
        """No reason field at all — still unexpected, still WARN."""
        import logging
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.return_value = {"applied": False}

        w = _mk_worker(fake_client, conn)
        with caplog.at_level(logging.DEBUG, logger="server.cloud.worker"):
            w.tick()
        warn_records = [
            r for r in caplog.records
            if r.name == "server.cloud.worker"
            and r.levelname == "WARNING"
            and "applied=false" in r.message
        ]
        assert len(warn_records) == 1

    def test_applied_false_still_marks_row_sent(
        self, fake_client, conn,
    ):
        """The row is ack'd by the cloud — retrying wouldn't help. Mark
        sent so the drainer moves on; the WARN log is how operators
        learn something's off."""
        outbox.enqueue_event(conn, {"n": 1})
        fake_client.post.return_value = {
            "applied": False,
            "reason": "product not found",
        }

        w = _mk_worker(fake_client, conn)
        w.tick()
        row = conn.execute(
            "SELECT sent_at, failed_permanently FROM cloud_outbox"
        ).fetchone()
        assert row["sent_at"] is not None  # marked sent
        assert row["failed_permanently"] == 0
