"""Tests for the catch-all classifier-dispatch unblocker (2026-04-27).

Pre-fix bugs the redesign closes:
  1. ``_capture_catch_all_frames`` wrote JPEGs to disk but the
     ``scale_events.before_frame_path`` / ``.after_frame_path`` columns
     stayed NULL. Without persistence, the cloud event viewer + the
     local /event/<id> page rendered placeholder tiles forever.
  2. The classifier-dispatch lookup at handle_scale_event went through
     ``session_capture.get_frames_for_event`` which ALWAYS misses for
     catch-all events (the catch-all camera daemon is registered with
     ``brightness_detection_enabled=False`` and has no session_capture
     hookup). Result: every catch-all event sat at
     ``classifier_status='pending'`` until the sweeper marked it failed.
  3. The sweeper had no recovery path for catch-all events that already
     had inline-captured frames on disk — it deferred to a close-hook
     that would never fire.

These tests use a stub ``ScaleHandler._dispatch_classification`` to
record dispatch invocations rather than actually running the classifier
(which would call into the Anthropic SDK).
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import cv2  # noqa: F401  (cv2 import keeps numpy linked for ring frames)
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import CameraDaemon, DaemonConfig  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_frame(idx: int) -> np.ndarray:
    frame = np.full((32, 32, 3), 128, dtype=np.uint8)
    frame[0, 0, 0] = idx & 0xFF
    return frame


def _iso(ms: datetime) -> str:
    return (
        ms.strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{ms.microsecond // 1000:03d}Z"
    )


def _seed_ring(daemon: CameraDaemon, n: int, fps: int, start: datetime) -> list[str]:
    period = timedelta(seconds=1.0 / fps)
    timestamps: list[str] = []
    for i in range(n):
        ts = _iso(start + period * i)
        daemon._ring.append((ts, _make_frame(i)))  # type: ignore[attr-defined]
        daemon.last_frame_ts = ts
        timestamps.append(ts)
    return timestamps


def _make_handler(
    conn: sqlite3.Connection,
    tmp_path: Path,
    *,
    catch_all_camera: Optional[CameraDaemon] = None,
) -> ScaleHandler:
    cfg = AppConfig()
    cfg.catch_all_enabled = True
    registry = build_registry_from_config(cfg)
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
        catch_all_enabled=True,
        shelf_registry_override=registry,
        catch_all_camera=catch_all_camera,
        catch_all_photo_delay_s=0.0,
    )


# ---------------------------------------------------------------------------
# Layer 1: persistence — the inline-captured frame paths land on the row
# ---------------------------------------------------------------------------


def test_catch_all_ingress_persists_frame_paths_on_scale_events(tmp_path: Path):
    """Pre-fix: before_frame_path / after_frame_path stayed NULL even
    though the JPEGs were on disk. Without the row update the local
    /event/<id> page can't serve the images and the cloud viewer shows
    placeholder tiles forever.

    Mutation guard: removing the UPDATE statement from
    handle_scale_event leaves before_frame_path / after_frame_path NULL,
    which makes this assertion fail.
    """
    conn = init_db(":memory:")
    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    timestamps = _seed_ring(daemon, 30, 10, base)
    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)
    # Stub the classifier dispatcher so the test doesn't need the
    # Anthropic SDK / fake. We only care that the path was triggered.
    handler._dispatch_classification = lambda *args, **kwargs: None  # type: ignore[assignment]

    resp, status = handler.handle_scale_event({
        "ts": timestamps[15],
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200, resp
    event_id = resp["event_id"]

    row = conn.execute(
        "SELECT before_frame_path, after_frame_path "
        "FROM scale_events WHERE event_id = ?",
        (event_id,),
    ).fetchone()
    assert row is not None
    assert row[0] is not None and row[0].endswith("before.jpg")
    assert row[1] is not None and row[1].endswith("after.jpg")
    # Both paths point at real files on disk.
    assert Path(row[0]).is_file()
    assert Path(row[1]).is_file()


# ---------------------------------------------------------------------------
# Layer 1: dispatch — classifier fires inline for catch-all events
# ---------------------------------------------------------------------------


def test_catch_all_ingress_dispatches_classifier_inline(tmp_path: Path):
    """Pre-fix: classifier dispatch went through
    session_capture.get_frames_for_event which ALWAYS missed for
    catch-all (no session_capture registration). Result: every event
    sat at status='pending' until the sweeper failed it ~62s later.

    Mutation guard: removing the inline dispatch + early return from
    the catch-all branch in handle_scale_event makes the
    `dispatched` flag stay False — assertion fails.
    """
    conn = init_db(":memory:")
    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    timestamps = _seed_ring(daemon, 30, 10, base)
    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    dispatch_calls: list[dict[str, Any]] = []

    def _stub_dispatch(event_id: str, session: dict[str, Any]) -> None:
        dispatch_calls.append({"event_id": event_id, "session": session})

    handler._dispatch_classification = _stub_dispatch  # type: ignore[assignment]

    resp, status = handler.handle_scale_event({
        "ts": timestamps[15],
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200, resp
    event_id = resp["event_id"]

    # Dispatch was invoked exactly once with the synthetic session
    # carrying the inline-captured frame paths.
    assert len(dispatch_calls) == 1
    call = dispatch_calls[0]
    assert call["event_id"] == event_id
    sess = call["session"]
    assert sess["shelf_id"] == "catch_all"
    assert sess["before_path"] is not None
    assert sess["after_path"] is not None
    assert Path(sess["before_path"]).is_file()
    assert Path(sess["after_path"]).is_file()


def test_live_shelf_ingress_does_not_use_catch_all_dispatch_path(tmp_path: Path):
    """Live-shelf events must NOT take the inline catch-all dispatch path —
    they route through session_capture as before. We verify by ensuring
    the synthetic session isn't built for a scale-01 ingress.

    Mutation guard: removing the ``shelf_id == 'catch_all'`` gate on the
    inline-dispatch block would make this test catch live_shelf events
    incorrectly going through the catch-all path.
    """
    conn = init_db(":memory:")
    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    _seed_ring(daemon, 30, 10, base)
    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    dispatch_calls: list[dict[str, Any]] = []

    def _stub_dispatch(event_id: str, session: dict[str, Any]) -> None:
        dispatch_calls.append({"event_id": event_id, "session": session})

    handler._dispatch_classification = _stub_dispatch  # type: ignore[assignment]

    resp, status = handler.handle_scale_event({
        "ts": _iso(datetime.now(timezone.utc)),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200, resp

    # Either no dispatch happened at all (most likely — live_shelf
    # session_capture won't match without a real session running) OR
    # the dispatch session lacks the catch_all marker. Either way the
    # synthetic-session shape is NOT what got passed in.
    for call in dispatch_calls:
        sess = call["session"]
        assert sess.get("shelf_id") != "catch_all", (
            "live_shelf ingress should not take the inline catch-all path"
        )


# ---------------------------------------------------------------------------
# Layer 1: sweeper recovery — re-dispatch when frames are persisted
# ---------------------------------------------------------------------------


def test_sweeper_recovers_catch_all_event_with_persisted_frames(tmp_path: Path):
    """When a catch-all event has frame paths persisted but is still
    pending (e.g. inline dispatch threw, or a Pi restart interrupted
    the dispatch), the sweeper must re-dispatch — not log
    "no_camera_session" and mark it failed.

    Mutation guard: removing the catch-all recovery branch in
    sweep_orphans drops this back to the pre-fix behavior — the event
    falls through to the "mark failed" branch instead.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_camera=None)

    # Manually seed a catch-all scale_events row with the persisted
    # frame paths (simulating a Pi restart between capture + dispatch).
    events_root = tmp_path / "events"
    event_dir = events_root / "synthetic-event-id"
    event_dir.mkdir()
    before_path = event_dir / "before.jpg"
    after_path = event_dir / "after.jpg"
    # Real JPEG bytes don't matter here — the sweeper just hands the
    # paths to the classifier dispatch which we'll stub.
    before_path.write_bytes(b"\xff\xd8\xff\xd9")  # minimal JPEG
    after_path.write_bytes(b"\xff\xd8\xff\xd9")

    # Insert a row aged enough to be eligible for the sweeper but not
    # marked failed yet.
    old_pi_ts = (
        datetime.now(timezone.utc) - timedelta(seconds=30)
    ).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    conn.execute(
        """
        INSERT INTO scale_events (
            event_id, ts, delta_g, before_weight_g, after_weight_g,
            direction, classifier_status, shelf_id, pi_received_ts,
            before_frame_path, after_frame_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-30 seconds'))
        """,
        (
            "synthetic-event-id", old_pi_ts, 120.0, 0.0, 120.0,
            "add", "pending", "catch_all", old_pi_ts,
            str(before_path), str(after_path),
        ),
    )
    conn.commit()

    dispatch_calls: list[dict[str, Any]] = []

    def _stub_classify_recorded_event(
        event_id: str, session: dict[str, Any]
    ) -> None:
        # Mark as classified so we don't loop on the next sweep pass.
        with conn:
            conn.execute(
                "UPDATE scale_events SET classifier_status = 'classified' "
                "WHERE event_id = ?",
                (event_id,),
            )
        dispatch_calls.append({"event_id": event_id, "session": session})

    handler._classify_recorded_event = (  # type: ignore[assignment]
        _stub_classify_recorded_event
    )

    touched = handler.sweep_orphans(min_age_seconds=5, max_age_seconds=300)
    assert touched == 1, (
        "sweeper recovery branch should classify the event with persisted "
        "frames"
    )
    assert len(dispatch_calls) == 1
    sess = dispatch_calls[0]["session"]
    assert sess["shelf_id"] == "catch_all"
    assert sess["before_path"] == str(before_path)
    assert sess["after_path"] == str(after_path)

    # Row should be classified now (not failed).
    row = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        ("synthetic-event-id",),
    ).fetchone()
    assert row[0] == "classified"
