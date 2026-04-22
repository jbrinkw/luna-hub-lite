"""Unit tests for the unified disk-retention / cloud_outbox janitor.

Covers the two storage bugs fixed on 2026-04-22:

  * **Bug 2 — event-frame directories never GC'd.**
    ``data/events/<event_id>/{before,after}.jpg`` accumulated forever,
    filling the Pi's SD card linearly with every classifier event.
    The sweep now deletes ``<event_id>`` dirs older than 14 days IFF
    the matching ``scale_events`` row is in a terminal status
    (``classified`` / ``failed`` / ``review``). ``pending`` and
    ``classifying`` rows keep their frames; the classifier still
    needs them.

  * **Bug 1 — cloud_outbox grew unbounded.**
    ``cloud_outbox`` rows were only pruned by a 10k-cap helper that
    nothing called. The same janitor now runs
    :func:`outbox.prune_sent_older_than` every tick, deleting sent
    rows older than 7 days while preserving pending and
    ``failed_permanently`` rows.

The tests drive multi-call sequences (seed various rows / dirs → run
sweep → inspect the before/after state) rather than asserting a
single-step property, per the test-fidelity audit.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.app import (  # noqa: E402
    DISK_RETENTION_MAX_AGE_SECONDS,
    OUTBOX_RETENTION_DAYS,
    _load_terminal_event_ids,
    _prune_cloud_outbox,
    _sweep_old_run_artifacts,
)
from server.cloud import outbox  # noqa: E402
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
def db_lock() -> threading.RLock:
    return threading.RLock()


def _make_event_dir(
    root: Path, event_id: str, *, age_days: float,
) -> Path:
    """Create ``<root>/events/<event_id>/{before,after}.jpg`` and back-
    date the directory's mtime by ``age_days``. Returns the dir path."""
    d = root / "events" / event_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "before.jpg").write_bytes(b"JPEG-BEFORE-FIXTURE")
    (d / "after.jpg").write_bytes(b"JPEG-AFTER-FIXTURE")
    mtime = time.time() - age_days * 86_400
    os.utime(d, (mtime, mtime))
    return d


def _insert_scale_event(
    conn: sqlite3.Connection,
    *,
    event_id: str,
    status: str | None,
) -> None:
    """Minimal insert for the GC test — we only need event_id +
    classifier_status; delta + frame paths don't matter here."""
    with conn:
        conn.execute(
            """
            INSERT INTO scale_events (
                event_id, ts, delta_g, before_weight_g, after_weight_g,
                direction, classifier_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (event_id, "2026-04-01T00:00:00.000Z", -100.0, 500.0, 400.0,
             "remove", status),
        )


# ---------------------------------------------------------------------------
# Bug 2: event-frame GC — terminal vs non-terminal vs orphan dirs
# ---------------------------------------------------------------------------


class TestEventFrameGc:
    def test_terminal_old_events_get_frames_deleted(
        self, tmp_path: Path, conn, db_lock,
    ):
        """All three terminal statuses (classified, failed, review)
        MUST get their old frame dirs swept. Seed one dir per status,
        age each past the cutoff, run the sweep, assert all three are
        gone."""
        dirs: dict[str, Path] = {}
        for status in ("classified", "failed", "review"):
            eid = f"evt-{status}"
            dirs[status] = _make_event_dir(
                tmp_path, eid, age_days=20,  # > 14d cutoff
            )
            _insert_scale_event(conn, event_id=eid, status=status)

        summary = _sweep_old_run_artifacts(
            tmp_path, conn=conn, db_lock=db_lock,
        )

        assert summary["dirs_deleted"] >= 3
        for status, path in dirs.items():
            assert not path.exists(), (
                f"terminal status={status!r} dir must be GC'd; still exists"
            )

    def test_pending_event_frames_are_preserved_even_when_old(
        self, tmp_path: Path, conn, db_lock,
    ):
        """The classifier might still pick up a 20-day-old pending row
        (e.g. Pi was offline for 3 weeks). Frames MUST survive so the
        retry can classify."""
        eid = "evt-stale-pending"
        frame_dir = _make_event_dir(tmp_path, eid, age_days=20)
        _insert_scale_event(conn, event_id=eid, status="pending")

        summary = _sweep_old_run_artifacts(
            tmp_path, conn=conn, db_lock=db_lock,
        )

        assert frame_dir.exists(), (
            "pending event's frame dir must be preserved regardless of age"
        )
        assert (frame_dir / "before.jpg").exists()
        assert summary["events_skipped_pending"] >= 1

    def test_classifying_event_frames_are_preserved(
        self, tmp_path: Path, conn, db_lock,
    ):
        """A ``classifying`` row is mid-Anthropic-call; its frames must
        not be swept out from under the in-flight API request."""
        eid = "evt-in-flight"
        frame_dir = _make_event_dir(tmp_path, eid, age_days=20)
        _insert_scale_event(conn, event_id=eid, status="classifying")

        _sweep_old_run_artifacts(tmp_path, conn=conn, db_lock=db_lock)

        assert frame_dir.exists(), (
            "classifying event's frames must never be GC'd"
        )

    def test_orphan_dir_without_scale_event_row_is_preserved(
        self, tmp_path: Path, conn, db_lock,
    ):
        """A dir that doesn't match any ``scale_events`` row is kept —
        it's either from a non-scale_events code path (intake, etc.)
        or a partially-migrated legacy write. Losing it is cheaper than
        breaking an unknown producer."""
        frame_dir = _make_event_dir(tmp_path, "evt-orphan", age_days=20)
        # No INSERT into scale_events — dir is on disk but not in DB.

        _sweep_old_run_artifacts(tmp_path, conn=conn, db_lock=db_lock)

        assert frame_dir.exists(), (
            "orphan dirs (no scale_events row) must be preserved"
        )

    def test_young_terminal_event_frames_are_preserved(
        self, tmp_path: Path, conn, db_lock,
    ):
        """A freshly-classified event is within the cloud-viewer
        window; the cloud event viewer LAN-streams its frames. Must
        not be swept even though the status is terminal."""
        eid = "evt-fresh-classified"
        frame_dir = _make_event_dir(tmp_path, eid, age_days=1)
        _insert_scale_event(conn, event_id=eid, status="classified")

        _sweep_old_run_artifacts(tmp_path, conn=conn, db_lock=db_lock)

        assert frame_dir.exists(), (
            "young terminal dirs must stay available to the cloud viewer"
        )

    def test_db_read_failure_skips_events_sweep_entirely(
        self, tmp_path: Path, conn, db_lock,
    ):
        """When ``_load_terminal_event_ids`` can't read the DB (schema
        mismatch, permissions, whatever), the sweep MUST skip events/
        rather than fall back to mtime-only — that would GC pending
        rows we can't see. Sessions + diag are OK to mtime-sweep."""
        # Create an old events dir for a classified event that WOULD be
        # GC'd on a good read.
        eid = "evt-would-gc"
        events_dir = _make_event_dir(tmp_path, eid, age_days=30)
        _insert_scale_event(conn, event_id=eid, status="classified")

        # Also seed an old sessions dir — must still be swept via mtime.
        sessions_dir = tmp_path / "sessions" / "sess-old"
        sessions_dir.mkdir(parents=True)
        (sessions_dir / "x.bin").write_bytes(b"x")
        mtime = time.time() - 30 * 86_400
        os.utime(sessions_dir, (mtime, mtime))

        # Break the scale_events table so _load_terminal_event_ids
        # raises. Dropping the table is a heavy-handed way to simulate
        # "can't read status" without monkeypatching internals.
        with conn:
            conn.execute("DROP TABLE scale_events")

        summary = _sweep_old_run_artifacts(
            tmp_path, conn=conn, db_lock=db_lock,
        )

        assert events_dir.exists(), (
            "DB read failure must skip events/ sweep — pending rows safe"
        )
        assert not sessions_dir.exists(), (
            "sessions/ sweep must still run (mtime-only, no DB dep)"
        )
        # Sessions dir was 1, but events sweep skipped entirely.
        assert summary["dirs_deleted"] == 1


# ---------------------------------------------------------------------------
# _load_terminal_event_ids — isolation test for the helper
# ---------------------------------------------------------------------------


class TestLoadTerminalEventIds:
    def test_returns_only_terminal_rows(self, conn, db_lock):
        """Pending + classifying rows are excluded; classified, failed,
        and review are included."""
        rows = {
            "evt-a": "pending",
            "evt-b": "classifying",
            "evt-c": "classified",
            "evt-d": "failed",
            "evt-e": "review",
        }
        for eid, status in rows.items():
            _insert_scale_event(conn, event_id=eid, status=status)

        ids = _load_terminal_event_ids(conn, db_lock)
        assert ids == {"evt-c", "evt-d", "evt-e"}

    def test_returns_none_when_conn_missing(self, db_lock):
        """Callers without a DB (early startup) get None → sweep skipped."""
        assert _load_terminal_event_ids(None, db_lock) is None


# ---------------------------------------------------------------------------
# Bug 1: cloud_outbox prune driven through the app-level helper
# ---------------------------------------------------------------------------


class TestCloudOutboxPruneThroughApp:
    def _backdate_sent(
        self, conn: sqlite3.Connection, outbox_id: int, days_ago: float,
    ) -> None:
        with conn:
            conn.execute(
                "UPDATE cloud_outbox SET sent_at = datetime('now', ?) "
                "WHERE outbox_id = ?",
                (f"-{days_ago} days", outbox_id),
            )

    def test_old_sent_rows_are_pruned(self, conn, db_lock):
        """End-to-end through ``_prune_cloud_outbox``: seed three rows,
        age two of them past the 7-day cutoff, run the app helper,
        assert the old rows are gone and the young one stays."""
        id_old = outbox.enqueue_event(conn, {"k": "old"})
        id_also_old = outbox.enqueue_event(conn, {"k": "also_old"})
        id_young = outbox.enqueue_event(conn, {"k": "young"})

        def row_id(cid: str) -> int:
            return conn.execute(
                "SELECT outbox_id FROM cloud_outbox "
                "WHERE client_event_id = ?", (cid,),
            ).fetchone()["outbox_id"]

        outbox.mark_sent(conn, row_id(id_old))
        outbox.mark_sent(conn, row_id(id_also_old))
        outbox.mark_sent(conn, row_id(id_young))
        self._backdate_sent(conn, row_id(id_old), days_ago=10)
        self._backdate_sent(conn, row_id(id_also_old), days_ago=15)
        self._backdate_sent(conn, row_id(id_young), days_ago=2)

        deleted = _prune_cloud_outbox(
            conn, db_lock, days=OUTBOX_RETENTION_DAYS,
        )

        assert deleted == 2
        remaining = {
            r["client_event_id"] for r in conn.execute(
                "SELECT client_event_id FROM cloud_outbox"
            ).fetchall()
        }
        assert remaining == {id_young}

    def test_prune_is_noop_when_conn_is_none(self, db_lock):
        """Cloud disabled / pre-storage path — must not raise."""
        assert _prune_cloud_outbox(None, db_lock, days=7) == 0

    def test_prune_never_deletes_pending_rows(self, conn, db_lock):
        """Any number of pending rows (even ancient ones) MUST survive
        the prune — losing a pending event is data loss."""
        # Pre-existing rows that are OLD but still pending.
        for i in range(3):
            eid = outbox.enqueue_event(conn, {"i": i})
            # Backdate enqueued_at far in the past. sent_at stays NULL.
            with conn:
                conn.execute(
                    "UPDATE cloud_outbox SET enqueued_at = datetime('now', ?) "
                    "WHERE client_event_id = ?",
                    ("-30 days", eid),
                )

        deleted = _prune_cloud_outbox(conn, db_lock, days=7)
        assert deleted == 0
        assert outbox.count_pending(conn) == 3

    def test_prune_preserves_failed_permanently_forensic_trail(
        self, conn, db_lock,
    ):
        """A failed-permanently row is forensic evidence of a 4xx
        rejection. Operators might diff the payload against the cloud
        schema weeks later. Never delete these via age."""
        eid = outbox.enqueue_event(conn, {"k": "bad_payload"})
        row_id = conn.execute(
            "SELECT outbox_id FROM cloud_outbox WHERE client_event_id = ?",
            (eid,),
        ).fetchone()["outbox_id"]
        outbox.mark_permanent_failure(conn, row_id, "400: bad shape")

        deleted = _prune_cloud_outbox(conn, db_lock, days=7)
        assert deleted == 0
        # Row is still there, still flagged.
        assert outbox.count_permanent_failures(conn) == 1
