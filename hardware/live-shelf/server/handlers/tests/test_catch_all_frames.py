"""Regression tests for catch-all inline frame capture.

Covers the bug where every catch-all event ended up with no
``events/<event_id>/before.jpg`` + ``after.jpg`` on disk, so the local
``/event`` page and the cloud event viewer both rendered placeholder
tiles forever. Root cause: the catch-all camera daemon is wired
without ``session_capture``, and nothing else wrote per-event JPEGs
for catch-all. Fix: ``ScaleHandler._capture_catch_all_frames`` grabs
a frame from the catch-all daemon's ring buffer at ingress and copies
it to ``before.jpg`` + ``after.jpg`` in the event directory.

These tests drive ``ScaleHandler.handle_scale_event`` with:

  * a pre-seeded catch-all camera daemon (10 fps, ~3 s of fake frames)
  * a non-noise scale-02 ingress
  * and assert that ``<events_root>/<event_id>/before.jpg`` +
    ``after.jpg`` exist on disk + decode as JPEGs.

Also covers the sweeper's infinite-defer bug: when a catch-all DB
session existed for the event, the sweeper used to log
"waiting for close-hook" forever because the predicate was anchored
to the event's ``created_at`` rather than wall-clock. The close-hook
for catch-all sessions doesn't exist (no ``session_capture`` hookup).
The fix bounds the grace to 60 s of wall-clock AND gates it on
``shelf_id='live_shelf'``; catch-all events age through to the
"mark failed" branch as expected.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import CameraDaemon, DaemonConfig  # noqa: E402
from server.camera.daemon import now_iso_utc_ms  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db, repo as storage_repo  # noqa: E402
from server.storage.models import ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers — fake camera daemon with a seeded ring, minimal candidate source
# ---------------------------------------------------------------------------


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
    """Build a BGR frame that encodes ``idx`` in pixel (0, 0, 0)."""
    frame = np.full((32, 32, 3), 128, dtype=np.uint8)
    frame[0, 0, 0] = idx & 0xFF
    return frame


def _iso(ms: datetime) -> str:
    return (
        ms.strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{ms.microsecond // 1000:03d}Z"
    )


def _seed_ring(daemon: CameraDaemon, n: int, fps: int, start: datetime) -> list[str]:
    """Pre-populate the daemon's ring without starting a capture thread."""
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
    catch_all_photo_delay_s: float = 0.0,
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
        catch_all_photo_delay_s=catch_all_photo_delay_s,
    )


# ---------------------------------------------------------------------------
# Inline frame capture — the core bug fix
# ---------------------------------------------------------------------------


def test_catch_all_ingress_writes_before_and_after_jpgs(tmp_path: Path):
    """A scale-02 non-noise ingress must produce before.jpg + after.jpg
    in the event dir; before the fix neither existed and the UI showed
    placeholder tiles forever."""
    conn = init_db(":memory:")

    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    # Seed ~3 s of frames ending "now"-ish so the ingress ts lands in the ring.
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    timestamps = _seed_ring(daemon, 30, 10, base)

    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    # ts anchor: use a ring-range timestamp so frame_at_with hits the happy
    # path (target within slop). The ESP's ts and Pi's ts are equal here —
    # the Pi uses its own now() at ingress, so the ring must cover that
    # moment. We seed frames relative to datetime.now() so the Pi clock
    # lookup always lands inside the ring.
    event_ts = timestamps[15]  # middle of the ring
    resp, status = handler.handle_scale_event({
        "ts": event_ts,
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200, resp
    event_id = resp["event_id"]

    # Row stamped as catch_all.
    row = conn.execute(
        "SELECT shelf_id FROM scale_events WHERE event_id = ?",
        (event_id,),
    ).fetchone()
    assert row is not None
    assert row[0] == "catch_all"

    # Core assertion: both JPEGs exist on disk at the canonical path the
    # web UI + cloud viewer serve from.
    events_root = tmp_path / "events"
    before = events_root / event_id / "before.jpg"
    after = events_root / event_id / "after.jpg"
    assert before.is_file(), f"before.jpg missing at {before}"
    assert after.is_file(), f"after.jpg missing at {after}"
    # Decode so we know they're not zero-byte / corrupt.
    assert cv2.imread(str(before)) is not None
    assert cv2.imread(str(after)) is not None
    # The two files share bytes (single-frame model — see docstring on
    # ScaleHandler._capture_catch_all_frames).
    assert before.read_bytes() == after.read_bytes()


def test_catch_all_ingress_falls_back_to_current_frame_when_ring_miss(tmp_path: Path):
    """When pi_received_ts is outside the ring's slop window, the helper
    must fall back to ``current_frame_jpeg()`` rather than leaving the
    event with no images. Better a stale frame than a placeholder tile."""
    conn = init_db(":memory:")

    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    # Seed frames 5 minutes in the past — any ingress ts anchored to
    # now() will blow past the 2.0 s slop and force the fallback.
    past = datetime.now(timezone.utc) - timedelta(minutes=5)
    _seed_ring(daemon, 30, 10, past)

    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    resp, status = handler.handle_scale_event({
        "ts": now_iso_utc_ms(),
        "device_id": "scale-02",
        "event_seq": 2,
        "delta_g": 80.0,
        "before_weight_g": 0.0,
        "after_weight_g": 80.0,
    })
    assert status == 200, resp
    event_id = resp["event_id"]

    events_root = tmp_path / "events"
    before = events_root / event_id / "before.jpg"
    after = events_root / event_id / "after.jpg"
    assert before.is_file(), "fallback current_frame should still write before.jpg"
    assert after.is_file(), "fallback current_frame should still write after.jpg"


def test_catch_all_ingress_without_camera_does_not_block(tmp_path: Path):
    """When ``catch_all_camera`` is None (USB camera unplugged / disabled),
    the ingress path must still return 200 + stamp the row. The event
    just has no frames on disk — same as the pre-fix behavior."""
    conn = init_db(":memory:")

    handler = _make_handler(conn, tmp_path, catch_all_camera=None)

    resp, status = handler.handle_scale_event({
        "ts": now_iso_utc_ms(),
        "device_id": "scale-02",
        "event_seq": 3,
        "delta_g": 50.0,
        "before_weight_g": 0.0,
        "after_weight_g": 50.0,
    })
    assert status == 200, resp
    event_id = resp["event_id"]

    events_root = tmp_path / "events"
    # No frames — that's expected when the camera is absent.
    assert not (events_root / event_id / "before.jpg").exists()
    assert not (events_root / event_id / "after.jpg").exists()


def test_catch_all_ingress_does_not_affect_live_shelf(tmp_path: Path):
    """A ``device_id='scale-01'`` (live-shelf) ingress must NOT write
    catch-all frames — those events go through the existing
    brightness/session_capture pipeline and would double-stamp here."""
    conn = init_db(":memory:")

    daemon = CameraDaemon(DaemonConfig(capture_fps=10, ring_seconds=30))
    base = datetime.now(timezone.utc) - timedelta(seconds=3)
    _seed_ring(daemon, 30, 10, base)

    handler = _make_handler(conn, tmp_path, catch_all_camera=daemon)

    resp, status = handler.handle_scale_event({
        "ts": now_iso_utc_ms(),
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200, resp
    event_id = resp["event_id"]

    events_root = tmp_path / "events"
    # Live-shelf events use the session_capture → _classify_recorded_event
    # path. The catch-all helper must NOT run for them.
    assert not (events_root / event_id / "before.jpg").exists()
    assert not (events_root / event_id / "after.jpg").exists()


# ---------------------------------------------------------------------------
# Sweeper defer fix — catch-all events must not get stuck forever
# ---------------------------------------------------------------------------


def test_sweeper_does_not_defer_catch_all_events_with_old_closed_session(tmp_path: Path):
    """Before the fix, the sweeper's 'recently closed session' check
    used the event's ``created_at`` as both sides of the SQL predicate,
    so any session that bracketed the event kept deferring the event
    forever. For catch-all events this meant events from closed
    sessions hours ago stayed in ``pending`` indefinitely, with the
    sweeper logging 'waiting for close-hook' every tick. The fix
    anchors the grace to wall-clock AND skips catch-all sessions
    entirely (no close-hook exists for them).
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_camera=None)

    # Insert a closed catch-all session that started before "now" and
    # ended well over 60 s ago — outside the fix's wall-clock grace.
    sid = "cafebabe-0000-0000-0000-000000000001"
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, ended_at, shelf_id, reconciled) "
        "VALUES (?, datetime('now', '-10 minutes'), datetime('now', '-5 minutes'), 'catch_all', 1)",
        (sid,),
    )
    # Insert a pending catch-all event created inside that session window,
    # aged older than the sweeper's default max_age_seconds so it's eligible
    # to be failed.
    ev_id = "deadbeef-0000-0000-0000-000000000001"
    conn.execute(
        """
        INSERT INTO scale_events (
            event_id, ts, direction, delta_g, before_weight_g, after_weight_g,
            session_id, classifier_status, shelf_id, created_at, pi_received_ts
        ) VALUES (?, datetime('now', '-8 minutes'), 'add', 120.0, 0.0, 120.0,
                  NULL, 'pending', 'catch_all',
                  datetime('now', '-8 minutes'),
                  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-8 minutes'))
        """,
        (ev_id,),
    )
    conn.commit()

    # max_age_seconds=60 so the 8-minute-old event is well past the
    # threshold. Before the fix, sweep_orphans would log
    # "waiting for close-hook" and leave the row pending. After the
    # fix, the row should transition to 'failed' (no live-shelf session
    # + catch-all session doesn't block).
    handler.sweep_orphans(max_age_seconds=60, min_age_seconds=5)

    row = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev_id,),
    ).fetchone()
    assert row is not None
    assert row[0] == "failed", (
        f"catch-all event with stale closed session should be marked failed, "
        f"got {row[0]!r} — sweeper is still deferring (regression)"
    )


def test_sweeper_still_defers_live_shelf_event_in_recent_close_window(tmp_path: Path):
    """The live-shelf defer path must still work — we only changed the
    window bound (now wall-clock, 60 s) and added a shelf_id gate.
    A live-shelf session closed 5 s ago should still defer its events
    because ``session_capture._handle_close`` may not have populated
    the in-memory ``_CLOSED`` deque yet."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_camera=None)

    sid = "cafebabe-0000-0000-0000-000000000002"
    conn.execute(
        "INSERT INTO sessions (session_id, started_at, ended_at, shelf_id, reconciled) "
        "VALUES (?, datetime('now', '-2 minutes'), datetime('now', '-5 seconds'), 'live_shelf', 0)",
        (sid,),
    )
    ev_id = "deadbeef-0000-0000-0000-000000000002"
    conn.execute(
        """
        INSERT INTO scale_events (
            event_id, ts, direction, delta_g, before_weight_g, after_weight_g,
            session_id, classifier_status, shelf_id, created_at, pi_received_ts
        ) VALUES (?, datetime('now', '-90 seconds'), 'add', 120.0, 0.0, 120.0,
                  NULL, 'pending', 'live_shelf',
                  datetime('now', '-90 seconds'),
                  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 seconds'))
        """,
        (ev_id,),
    )
    conn.commit()

    handler.sweep_orphans(max_age_seconds=60, min_age_seconds=5)

    row = conn.execute(
        "SELECT classifier_status FROM scale_events WHERE event_id = ?",
        (ev_id,),
    ).fetchone()
    assert row is not None
    assert row[0] == "pending", (
        f"live-shelf event in fresh close window should still defer, "
        f"got {row[0]!r} — we over-corrected and broke the race window"
    )
