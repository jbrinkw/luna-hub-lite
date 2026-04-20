"""Tests for ``ScaleHandler.sweep_orphans``.

Covers the three branches the audit flagged:

1. Events still inside the currently-open session must NOT be age-failed
   (long door-open sessions otherwise lose their early events).

2. Events older than ``max_age_seconds`` with no session ever match get
   marked ``classifier_status='failed'`` AND enqueue a
   ``sensor_anomaly`` row.

3. Mid-loop wipe-epoch changes must abort the per-row writeback so the
   sweeper can't reinstate rows referencing a just-wiped event.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import session_capture  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ScaleEventIn  # noqa: E402


def _make_handler(conn: sqlite3.Connection, tmp_path: Path) -> ScaleHandler:
    class _NullCandidateSource:
        def get_on_shelf_lots(self):
            return []

        def get_recently_out_lots(self, window_seconds):
            return []

        def get_certified_not_on_shelf(self):
            return []

    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )


def _backdate_event_created_at(
    conn: sqlite3.Connection, event_id: str, minutes_ago: float
) -> None:
    """Force ``created_at`` to ``now - minutes_ago`` so the sweeper's
    age calculation fires."""
    backdated = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    # SQLite's datetime('now') format: 'YYYY-MM-DD HH:MM:SS' (space sep).
    iso_space = backdated.strftime("%Y-%m-%d %H:%M:%S")
    with conn:
        conn.execute(
            "UPDATE scale_events SET created_at = ? WHERE event_id = ?",
            (iso_space, event_id),
        )


@pytest.fixture(autouse=True)
def _reset_session_state():
    session_capture.reset()
    yield
    session_capture.reset()


# ---------------------------------------------------------------------------
# 1. Event inside currently-open session is NOT aged out
# ---------------------------------------------------------------------------


def test_sweep_orphans_respects_current_open_session(tmp_path: Path):
    """An event whose ``created_at`` is inside a long-running open
    session must be left as ``pending`` rather than being stamped failed,
    even if it's older than ``max_age_seconds``.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Insert an event (pending, REMOVE).
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-15T12:00:00.000Z",
            delta_g=-100.0,
            before_weight_g=500.0,
            after_weight_g=400.0,
            direction="remove",
            session_id=None,
            classifier_status="pending",
        ),
    )
    # Backdate so age > max_age (default 60s).
    _backdate_event_created_at(conn, ev.event_id, minutes_ago=5.0)

    # Install a fake open session whose open_ts precedes the backdated
    # created_at. The sweeper peeks _CURRENT under _LOCK and skips
    # age-failure when the event is inside the open window.
    backdated_row = conn.execute(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', created_at) "
        "FROM scale_events WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()
    backdated_iso = backdated_row[0]
    # Set open_ts BEFORE the event's created_at so age-check matches.
    open_dt = datetime.fromisoformat(backdated_iso.replace("Z", "+00:00")) - timedelta(seconds=30)
    open_ts = open_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    with session_capture._LOCK:
        session_capture._CURRENT = {
            "open_ts": open_ts,
            "close_ts": None,
            "before_path": None,
            "after_path": None,
            "video_path": None,
        }

    touched = handler.sweep_orphans()

    status = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()[0]
    assert status == "pending", (
        f"event inside currently-open session must stay pending; got {status!r}"
    )
    # And NO sensor_anomaly review row should have been enqueued.
    reviews = conn.execute(
        "SELECT COUNT(*) FROM review_queue WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()[0]
    assert reviews == 0


# ---------------------------------------------------------------------------
# 2. Old orphan with no session gets failed + anomaly
# ---------------------------------------------------------------------------


def test_sweep_orphans_marks_old_orphan_failed(tmp_path: Path):
    """An event older than 60s with NO matching session window must
    transition to ``classifier_status='failed'`` and enqueue a
    ``sensor_anomaly`` review row.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-15T12:00:00.000Z",
            delta_g=-100.0,
            before_weight_g=500.0,
            after_weight_g=400.0,
            direction="remove",
            session_id=None,
            classifier_status="pending",
        ),
    )
    # Age > 60s.
    _backdate_event_created_at(conn, ev.event_id, minutes_ago=5.0)

    # No current session, no closed sessions.
    assert session_capture._CURRENT is None

    touched = handler.sweep_orphans()

    row = conn.execute(
        "SELECT classifier_status, classification FROM scale_events "
        "WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()
    assert row[0] == "failed"
    payload = json.loads(row[1] or "{}")
    assert payload.get("item_id") == "UNKNOWN"

    kind = conn.execute(
        "SELECT kind FROM review_queue WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()
    assert kind is not None and kind[0] == "sensor_anomaly"


# ---------------------------------------------------------------------------
# 3. Wipe epoch change mid-loop skips writeback
# ---------------------------------------------------------------------------


def test_sweep_orphans_skips_when_wipe_epoch_changes_mid_loop(
    tmp_path: Path, monkeypatch
):
    """When the wipe epoch flips between the first and second rows, the
    first row is still written back (it captured the old epoch at the
    top of its iteration) but the second row's post-read epoch comparison
    must fail and skip the writeback.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Insert TWO pending REMOVE events, both aged > 60s.
    ev1 = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-15T12:00:00.000Z",
            delta_g=-100.0,
            before_weight_g=500.0,
            after_weight_g=400.0,
            direction="remove",
            session_id=None,
            classifier_status="pending",
        ),
    )
    ev2 = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-15T12:00:05.000Z",
            delta_g=-120.0,
            before_weight_g=400.0,
            after_weight_g=280.0,
            direction="remove",
            session_id=None,
            classifier_status="pending",
        ),
    )
    # ev1 older than ev2 so the sweeper (ORDER BY created_at ASC)
    # processes ev1 first, then ev2 — matches the fake-epoch call
    # counter below (row 1 = ev1, row 2 = ev2).
    _backdate_event_created_at(conn, ev1.event_id, minutes_ago=5.1)
    _backdate_event_created_at(conn, ev2.event_id, minutes_ago=5.0)

    # Monkeypatch _current_wipe_epoch so it bumps between rows. Row 1
    # sees epoch 0 at start AND at the write check (same value); row 2
    # sees epoch 0 at start but epoch 1 by the time its write check
    # runs — so row 2 must be skipped.
    call_counter = {"n": 0}
    real_method = handler._current_wipe_epoch

    def _fake_epoch() -> int:
        call_counter["n"] += 1
        # Calls 1+2 → epoch 0 (row 1 start + row 1 write check)
        # Call 3 → epoch 0 (row 2 start)
        # Call 4+ → epoch 1 (row 2 write check + beyond)
        if call_counter["n"] <= 3:
            return 0
        return 1

    monkeypatch.setattr(handler, "_current_wipe_epoch", _fake_epoch)

    handler.sweep_orphans()

    # Row 1: written back (failed).
    s1 = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev1.event_id,),
    ).fetchone()[0]
    # Row 2: still pending because the wipe-epoch guard aborted the write.
    s2 = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev2.event_id,),
    ).fetchone()[0]

    assert s1 == "failed", f"row 1 should be failed; got {s1}"
    assert s2 == "pending", (
        f"row 2 should be skipped (epoch bumped mid-loop); got {s2}"
    )
