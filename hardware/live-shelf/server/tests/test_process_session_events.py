"""Tests for ``ScaleHandler.process_session_events`` close-hook grace.

The close callback classifies every ``pending`` event whose Pi-clock
``created_at`` falls inside ``[open_ts, close_ts + POST_CLOSE_GRACE_S]``.

Three behaviors audited:

1. Event whose ``created_at`` is 20s after close_ts (within 30s grace)
   → classified.

2. Event whose ``created_at`` is 35s after close_ts (past 30s grace)
   → NOT classified.

3. Correlation uses Pi-clock ``created_at``, NOT the ESP's ``ts`` field —
   an event with an ESP ts far outside the window but a created_at
   inside must still be picked up.
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

from server.classifier.anthropic_client import ClassifierCallResult  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ScaleEventIn  # noqa: E402


class _CountingClassifier:
    """Records every send() call so tests can assert on classifier activity."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send(self, payload, *, model=None, max_tokens=512):
        self.calls.append({"payload": payload, "model": model})
        return ClassifierCallResult(
            text=json.dumps({
                "item_id": "UNKNOWN",
                "action": "unknown",
                "confidence": 0.0,
                "reasoning": "",
                "multi_match": [],
            }),
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 1, "output_tokens": 1},
            raw=None,
        )


def _make_handler(
    conn: sqlite3.Connection, client: Any, tmp_path: Path
) -> ScaleHandler:
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
        classifier_client=client,
    )


def _set_created_at(
    conn: sqlite3.Connection, event_id: str, dt: datetime
) -> None:
    """Override created_at for an inserted row. SQLite default format is
    'YYYY-MM-DD HH:MM:SS' (space-separated)."""
    iso_space = dt.strftime("%Y-%m-%d %H:%M:%S")
    with conn:
        conn.execute(
            "UPDATE scale_events SET created_at = ? WHERE event_id = ?",
            (iso_space, event_id),
        )


def _seed_frames(tmp_path: Path) -> tuple[str, str]:
    before = tmp_path / "before.jpg"
    after = tmp_path / "after.jpg"
    before.write_bytes(b"\xff\xd8\xff\xd9")
    after.write_bytes(b"\xff\xd8\xff\xd9")
    return str(before), str(after)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_process_session_events_picks_up_event_within_30s_grace(tmp_path: Path):
    """Event 20s after close_ts (grace = 30s) must be picked up by the
    close callback and transition to classified/failed/review.
    """
    conn = init_db(":memory:")
    client = _CountingClassifier()
    handler = _make_handler(conn, client, tmp_path)
    before, after = _seed_frames(tmp_path)

    open_dt = datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)
    close_dt = open_dt + timedelta(seconds=10)
    event_created_dt = close_dt + timedelta(seconds=20)  # inside 30s grace

    # Use ADD direction — pool_for_add always appends the UNKNOWN
    # sentinel so classify_event reliably calls client.send() even
    # with a null candidate source.
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=open_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            delta_g=100.0,
            before_weight_g=400.0,
            after_weight_g=500.0,
            direction="add",
            session_id=None,
            classifier_status="pending",
        ),
    )
    _set_created_at(conn, ev.event_id, event_created_dt)

    session = {
        "open_ts": open_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "close_ts": close_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "before_path": before,
        "after_path": after,
        "video_path": None,
    }
    processed = handler.process_session_events(session)
    assert processed == 1

    status = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()[0]
    assert status in ("classified", "review", "failed")
    assert len(client.calls) == 1


def test_process_session_events_skips_event_past_grace(tmp_path: Path):
    """Event 35s after close_ts (past 30s grace) must NOT be classified
    by the close hook.
    """
    conn = init_db(":memory:")
    client = _CountingClassifier()
    handler = _make_handler(conn, client, tmp_path)
    before, after = _seed_frames(tmp_path)

    open_dt = datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)
    close_dt = open_dt + timedelta(seconds=10)
    event_created_dt = close_dt + timedelta(seconds=35)  # outside grace

    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=open_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            delta_g=-100.0,
            before_weight_g=500.0,
            after_weight_g=400.0,
            direction="remove",
            session_id=None,
            classifier_status="pending",
        ),
    )
    _set_created_at(conn, ev.event_id, event_created_dt)

    session = {
        "open_ts": open_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "close_ts": close_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "before_path": before,
        "after_path": after,
        "video_path": None,
    }
    processed = handler.process_session_events(session)
    assert processed == 0

    status = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev.event_id,),
    ).fetchone()[0]
    assert status == "pending"
    assert client.calls == []


def test_process_session_events_uses_pi_clock_created_at_not_esp_ts(tmp_path: Path):
    """Event whose ESP ``ts`` is miles outside the session window, but
    whose Pi-clock ``created_at`` is inside, must be picked up.
    """
    conn = init_db(":memory:")
    client = _CountingClassifier()
    handler = _make_handler(conn, client, tmp_path)
    before, after = _seed_frames(tmp_path)

    open_dt = datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)
    close_dt = open_dt + timedelta(seconds=10)
    # ESP ts is 3 hours off — simulating un-synced ESP clock.
    bad_esp_ts = (open_dt - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    # created_at (Pi clock) is squarely inside the session window.
    event_created_dt = open_dt + timedelta(seconds=5)

    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=bad_esp_ts,
            delta_g=100.0,
            before_weight_g=400.0,
            after_weight_g=500.0,
            direction="add",
            session_id=None,
            classifier_status="pending",
        ),
    )
    _set_created_at(conn, ev.event_id, event_created_dt)

    session = {
        "open_ts": open_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "close_ts": close_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "before_path": before,
        "after_path": after,
        "video_path": None,
    }
    processed = handler.process_session_events(session)
    assert processed == 1, (
        "event with bad ESP ts but good Pi created_at must be classified"
    )
    assert len(client.calls) == 1
