"""Extra session_capture edge-cases beyond test_session_capture.py.

Three scenarios the audit flagged:

1. _handle_close filters out frames captured AFTER close_ts so the
   after-pick can never land on a post-close frame (AGC would be
   mid-reacting, and the door is physically closing).

2. get_frames_for_event's video-poll loop must re-scan _CLOSED under
   the lock and rebind ``match`` — otherwise its stale copy's
   video_path stays None forever.

3. _select_after_frame walks back exactly FRAME_SETTLE_DELAY_S (200ms)
   from the last lit frame.
"""

from __future__ import annotations

import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import session_capture  # noqa: E402
from server.camera.daemon import BrightnessTransition  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_session_state():
    session_capture.reset()
    yield
    session_capture.reset()


def _iso(dt: datetime) -> str:
    ms = dt.microsecond // 1000
    return dt.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


def _base_dt() -> datetime:
    return datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)


def _frame(brightness: float = 120.0) -> np.ndarray:
    v = int(max(0, min(255, round(brightness))))
    return np.full((2, 2, 3), v, dtype=np.uint8)


class _FakeDaemon:
    def __init__(self, ring):
        self._ring = list(ring)
        self._subs = []

    def on_brightness_transition(self, cb):
        self._subs.append(cb)

    def emit(self, transition: BrightnessTransition) -> None:
        for cb in list(self._subs):
            cb(transition)

    def snapshot_ring(self):
        return list(self._ring)


# ---------------------------------------------------------------------------
# 1. Post-close frames filtered from the after-pick
# ---------------------------------------------------------------------------


def test_handle_close_filters_out_post_close_frames(tmp_path: Path):
    """Ring buffer has 20 frames spanning 1s; the LAST 2 are 0.8s AFTER
    close_ts. _handle_close must filter those out so the after-pick
    lands on a pre-close frame, never a frame captured during the door's
    closing motion.
    """
    base = _base_dt()
    open_dt = base
    close_dt = base + timedelta(seconds=1.0)
    # 20 frames: 18 pre-close, 2 post-close (at +1.7s and +1.8s, both well
    # beyond FRAME_CLOSE_TOLERANCE_S = 0.5).
    ring = []
    for i in range(18):
        t = base + timedelta(seconds=i * 0.055)  # ~0 .. 0.94s
        ring.append((_iso(t), _frame(120.0)))
    for i in range(2):
        t = close_dt + timedelta(seconds=0.7 + i * 0.1)
        ring.append((_iso(t), _frame(120.0)))

    daemon = _FakeDaemon(ring)
    session_capture.register(daemon, tmp_path)

    daemon.emit(BrightnessTransition("open", _iso(open_dt), 120.0))
    daemon.emit(BrightnessTransition("close", _iso(close_dt), 5.0))

    with session_capture._LOCK:
        assert len(session_capture._CLOSED) == 1
        closed = dict(session_capture._CLOSED[-1])

    # Parse the after_ts; it must be BEFORE the post-close frames.
    after_dt = datetime.fromisoformat(closed["after_ts"].replace("Z", "+00:00"))
    last_post_close = close_dt + timedelta(seconds=0.8)
    assert after_dt < last_post_close, (
        f"after_ts must be before any post-close frame; "
        f"after_ts={after_dt} last_post_close={last_post_close}"
    )
    # Also must be <= close_dt + FRAME_CLOSE_TOLERANCE_S (0.5s).
    bound = close_dt + timedelta(seconds=session_capture.FRAME_CLOSE_TOLERANCE_S)
    assert after_dt <= bound


# ---------------------------------------------------------------------------
# 2. get_frames_for_event observes video_path mutation
# ---------------------------------------------------------------------------


def test_get_frames_for_event_observes_encoder_video_path_mutation():
    """Install a closed session with video_path=None. Spawn a helper
    thread that mutates the ORIGINAL dict in _CLOSED to set video_path
    after a short delay. get_frames_for_event with wait_for_video_s=1.0
    must return the session with the populated video_path.
    """
    base = _base_dt()
    # Install by direct _CLOSED append so we hold a reference to the
    # ORIGINAL dict (same one the "encoder thread" mutates).
    original = {
        "open_ts": _iso(base),
        "close_ts": _iso(base + timedelta(seconds=5.0)),
        "before_path": "/tmp/before.jpg",
        "after_path": "/tmp/after.jpg",
        "video_path": None,
        "before_ts": _iso(base + timedelta(seconds=0.5)),
        "after_ts": _iso(base + timedelta(seconds=4.5)),
    }
    with session_capture._LOCK:
        session_capture._CLOSED.append(original)

    # Thread that imitates the encoder finishing after 50ms.
    encoder_started = threading.Event()

    def _encoder() -> None:
        encoder_started.set()
        # Use an Event with short timeout rather than sleep for determinism
        # — but we actually need a small delay. A threading.Event wait
        # of 0.05s that never fires is the deterministic-equivalent.
        threading.Event().wait(0.05)
        with session_capture._LOCK:
            original["video_path"] = "/tmp/session.mp4"

    t = threading.Thread(target=_encoder, daemon=True)
    t.start()
    encoder_started.wait(timeout=1.0)

    event_ts = _iso(base + timedelta(seconds=2.5))
    session, matched = session_capture.get_frames_for_event(
        event_ts,
        wait_for_close_s=0.0,
        wait_for_video_s=1.0,
    )
    t.join(timeout=2.0)

    assert matched is True
    assert session is not None
    assert session["video_path"] == "/tmp/session.mp4", (
        "get_frames_for_event must re-scan _CLOSED to see the encoder's "
        "video_path mutation"
    )


# ---------------------------------------------------------------------------
# 3. _select_after_frame walk-back
# ---------------------------------------------------------------------------


def test_select_after_frame_walks_back_over_settle_delay():
    """10 frames at 100ms spacing (0.0..0.9s). before_idx=0. Walk-back
    target = 0.9 - 0.2 = 0.7s. First frame ≤ 0.7s starting from the end
    is index 7 (0.7s exactly).
    """
    base = _base_dt()
    lit = []
    for i in range(10):
        t = base + timedelta(seconds=i * 0.1)
        ms = t.microsecond // 1000
        iso = t.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")
        lit.append((iso, _frame(120.0), 120.0))

    idx, ts_pick, _ = session_capture._select_after_frame(lit, before_idx=0)
    assert idx == 7, f"walk-back should land at index 7 (0.7s); got {idx}"
