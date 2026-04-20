"""Unit tests for ``server.camera.session_capture``.

The module tracks open/closed sessions via module-level globals
(``_CURRENT``, ``_CLOSED``, ``_LOCK``). Every test resets state via
``session_capture.reset()`` in setup/teardown to isolate globals.

Coverage focuses on:
    * ``_select_before_frame`` — skip overexposed burst + apply settle delay
    * ``_select_after_frame``  — walk back from end by settle delay, never
      equal to before frame unless session is single-frame
    * ``get_frames_for_event`` — closed-first priority, current-waits,
      timeout behavior, newest-first disambiguation
    * ``_handle_open`` / ``_handle_close`` lifecycle, including orphan
      replacement and no-op close with no active session
    * ``reset()`` clears both ``_CURRENT`` and ``_CLOSED``

These tests build tiny synthetic ``lit`` lists and mock the daemon —
no webcam, no threading for normal paths.
"""

from __future__ import annotations

import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pytest

# Make ``server.camera.session_capture`` importable when running pytest from
# the repo root. Mirrors the pattern in reconciler/tests/test_reconcile.py.
ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.camera import session_capture  # noqa: E402
from server.camera.daemon import BrightnessTransition  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_session_state():
    """Each test starts + ends with a clean ``_CURRENT`` / ``_CLOSED``."""
    session_capture.reset()
    yield
    session_capture.reset()


class _FakeDaemon:
    """Daemon stand-in with a settable ring snapshot + subscriber list."""

    def __init__(self, ring: Optional[list[tuple[str, np.ndarray]]] = None):
        self._ring: list[tuple[str, np.ndarray]] = ring or []
        self._subs: list = []

    def on_brightness_transition(self, cb):
        self._subs.append(cb)

    def emit(self, transition: BrightnessTransition) -> None:
        for cb in list(self._subs):
            cb(transition)

    def snapshot_ring(self):
        return list(self._ring)

    def set_ring(self, ring: list[tuple[str, np.ndarray]]):
        self._ring = ring


def _iso(dt: datetime) -> str:
    """Render a datetime as the project's ms-precision UTC ISO string."""
    ms = dt.microsecond // 1000
    return dt.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


def _base_dt() -> datetime:
    """Deterministic anchor time (no wall-clock dependency)."""
    return datetime(2026, 4, 15, 12, 0, 0, tzinfo=timezone.utc)


def _frame(brightness: float = 120.0) -> np.ndarray:
    """Build a 2x2 RGB frame whose mean luma ≈ ``brightness``.

    Using a uniform gray value keeps ``compute_brightness`` deterministic.
    The exact value shouldn't matter for tests that use ``lit`` directly,
    but for snapshot_ring-based tests ``compute_brightness`` is called.
    """
    v = int(max(0, min(255, round(brightness))))
    return np.full((2, 2, 3), v, dtype=np.uint8)


def _build_lit(
    timestamps_s: list[float],
    brightnesses: list[float],
    start: Optional[datetime] = None,
) -> list[tuple[str, np.ndarray, float]]:
    """Construct an ``lit`` list aligned with the module's internal shape."""
    assert len(timestamps_s) == len(brightnesses)
    base = start or _base_dt()
    out: list[tuple[str, np.ndarray, float]] = []
    for offset_s, b in zip(timestamps_s, brightnesses):
        dt = base + timedelta(seconds=offset_s)
        out.append((_iso(dt), _frame(b), float(b)))
    return out


# ---------------------------------------------------------------------------
# _select_before_frame
# ---------------------------------------------------------------------------


def test_select_before_frame_skips_overexposed_burst():
    """Regression guard: the initial overexposed burst (brightness ≥ 240)
    must be skipped, and the pick must advance by FRAME_SETTLE_DELAY_S
    past the first well-exposed frame so auto-exposure has fully settled.
    """
    # 3 overexposed frames at 0.0, 0.1, 0.2s followed by 10 normal frames
    # at 0.3..1.2s (100ms spacing).
    ts = [i * 0.1 for i in range(13)]
    brights = [245.0, 250.0, 242.0] + [150.0] * 10
    lit = _build_lit(ts, brights)

    idx, ts_pick, frame = session_capture._select_before_frame(lit)

    # First well-exposed frame is at index 3 (t=0.3s). Settle delay 0.2s
    # lands target at 0.5s → first frame with dt ≥ target is index 5.
    assert idx == 5
    assert ts_pick == lit[5][0]
    assert np.array_equal(frame, lit[5][1])


def test_select_before_frame_falls_back_if_all_overexposed():
    """If every frame is ≥ OVEREXPOSED_THRESHOLD we degrade gracefully to
    ``lit[0]`` rather than crashing or returning garbage.
    """
    ts = [i * 0.1 for i in range(5)]
    brights = [245.0, 248.0, 250.0, 255.0, 244.0]  # all overexposed
    lit = _build_lit(ts, brights)

    idx, ts_pick, frame = session_capture._select_before_frame(lit)

    assert idx == 0
    assert ts_pick == lit[0][0]
    assert np.array_equal(frame, lit[0][1])


def test_select_before_frame_short_session_falls_back_to_last():
    """If the session is shorter than FRAME_SETTLE_DELAY_S we don't have
    a frame at or after the advance target; the helper must fall back to
    the last lit frame rather than returning the still-overexposed first.
    """
    # First frame well-exposed at 0.0s; only 100ms of frames total (< 200ms
    # settle delay), so the advance target is past the end of the list.
    ts = [0.0, 0.05, 0.1]
    brights = [150.0, 160.0, 170.0]
    lit = _build_lit(ts, brights)

    idx, ts_pick, _ = session_capture._select_before_frame(lit)

    # last_idx = 2
    assert idx == 2
    assert ts_pick == lit[2][0]


# ---------------------------------------------------------------------------
# _select_after_frame
# ---------------------------------------------------------------------------


def test_select_after_frame_steps_back_by_settle_delay():
    """The after-pick must be FRAME_SETTLE_DELAY_S (0.2s) before the last
    lit frame. For 11 frames at 100ms spacing (last at 1.0s), the target
    is 0.8s and the matching index is 8.
    """
    ts = [i * 0.1 for i in range(11)]  # 0.0 .. 1.0s
    brights = [150.0] * 11
    lit = _build_lit(ts, brights)

    idx, ts_pick, _ = session_capture._select_after_frame(lit, before_idx=0)

    assert idx == 8
    assert ts_pick == lit[8][0]


def test_select_after_frame_never_equals_before_when_multiple_frames():
    """Two-frame session with before_idx=0: the walk-back target lands at
    or before before_idx, so the fallback must pick ``before_idx + 1`` to
    guarantee classifier never sees before == after.
    """
    ts = [0.0, 0.05]
    brights = [150.0, 155.0]
    lit = _build_lit(ts, brights)

    idx, _ts, _frame = session_capture._select_after_frame(lit, before_idx=0)

    assert idx == 1
    assert idx != 0  # explicit — distinct from before_idx


def test_select_after_frame_returns_same_as_before_when_only_one_frame(caplog):
    """Degenerate single-frame session: the helper can only return the
    same frame for after as for before — log a warning and do so rather
    than crashing.
    """
    ts = [0.0]
    brights = [150.0]
    lit = _build_lit(ts, brights)

    with caplog.at_level("WARNING"):
        idx, ts_pick, _ = session_capture._select_after_frame(
            lit, before_idx=0
        )

    assert idx == 0
    assert ts_pick == lit[0][0]
    # A warning must be emitted so the operator knows the session was
    # too short for distinct before/after.
    assert any(
        "too short" in rec.getMessage() for rec in caplog.records
    ), "expected a 'too short' warning on single-frame session"


# ---------------------------------------------------------------------------
# get_frames_for_event
# ---------------------------------------------------------------------------


def _install_closed(
    open_s: float,
    close_s: float,
    *,
    base: Optional[datetime] = None,
    video_path: Optional[str] = "ok.mp4",
    before_path: str = "/tmp/before.jpg",
    after_path: str = "/tmp/after.jpg",
) -> dict:
    """Append a synthetic closed session to ``_CLOSED`` and return it."""
    base = base or _base_dt()
    sess = {
        "open_ts": _iso(base + timedelta(seconds=open_s)),
        "close_ts": _iso(base + timedelta(seconds=close_s)),
        "before_path": before_path,
        "after_path": after_path,
        # video_path=None simulates the encode-in-flight case; passing a
        # non-None string lets get_frames_for_event return immediately
        # without burning the full wait_for_video_s budget.
        "video_path": video_path,
        "before_ts": _iso(base + timedelta(seconds=open_s + 0.2)),
        "after_ts": _iso(base + timedelta(seconds=close_s - 0.2)),
    }
    with session_capture._LOCK:
        session_capture._CLOSED.append(sess)
    return sess


def test_get_frames_for_event_closed_session_match():
    """A closed session whose [open_ts, close_ts+grace] covers the event
    timestamp must be returned with matched=True.
    """
    base = _base_dt()
    _install_closed(0.0, 5.0, base=base)
    event_ts = _iso(base + timedelta(seconds=2.5))

    session, matched = session_capture.get_frames_for_event(
        event_ts,
        wait_for_close_s=0.0,
        wait_for_video_s=0.0,
    )

    assert matched is True
    assert session is not None
    # Returned record is a copy of the published dict.
    assert session["open_ts"] == _iso(base)
    assert session["close_ts"] == _iso(base + timedelta(seconds=5.0))


def test_get_frames_for_event_no_match_returns_false():
    """With no sessions at all the function must return (None, False)
    rather than fabricating a fallback. Prior behavior of returning the
    most-recent session regardless of timestamp was the old bug.
    """
    session, matched = session_capture.get_frames_for_event(
        _iso(_base_dt()),
        wait_for_close_s=0.0,
        wait_for_video_s=0.0,
    )

    assert session is None
    assert matched is False


def test_get_frames_for_event_current_session_contains_event_waits():
    """If _CURRENT is open and covers event_dt but no closed match
    exists, the function polls until wait_for_close_s expires. Without a
    close it must return (None, False) at the timeout — NOT a hang.
    """
    base = _base_dt()
    # Install a pseudo-open current session (directly, skipping register()).
    with session_capture._LOCK:
        session_capture._CURRENT = {
            "open_ts": _iso(base),
            "close_ts": None,
            "before_path": None,
            "after_path": None,
            "video_path": None,
        }
    event_ts = _iso(base + timedelta(seconds=1.0))

    session, matched = session_capture.get_frames_for_event(
        event_ts,
        wait_for_close_s=0.1,  # short — no close will happen
        wait_for_video_s=0.0,
    )

    assert session is None
    assert matched is False


def test_get_frames_for_event_current_beats_closed_grace():
    """When a currently-open session AND a just-closed session's grace
    window both cover event_dt, the CURRENT session wins — the event
    physically happened during the newer session, not during the
    previous session's grace period.

    Regression guard for a real bug: a REMOVE session's video was
    attached to an ADD event that fired ~30s later inside a newer
    session, because get_frames_for_event was scanning _CLOSED first
    and matching the stale grace window.
    """
    base = _base_dt()
    # Closed session 0..5s, grace extends to 35s.
    _install_closed(0.0, 5.0, base=base)
    # New open session at 10s.
    with session_capture._LOCK:
        session_capture._CURRENT = {
            "open_ts": _iso(base + timedelta(seconds=10.0)),
            "close_ts": None,
            "before_path": None,
            "after_path": None,
            "video_path": None,
        }
    # Event at 12s: inside current's open window AND inside the prior
    # closed session's grace window (5 + 30 = 35).
    event_ts = _iso(base + timedelta(seconds=12.0))

    session, matched = session_capture.get_frames_for_event(
        event_ts,
        wait_for_close_s=0.0,
        wait_for_video_s=0.0,
    )

    # The current session is still open so we can't return frames for
    # it yet — expect (None, False). The key invariant: we do NOT match
    # the closed session's grace window when a newer open session also
    # contains the event.
    assert matched is False
    assert session is None


def test_get_frames_for_event_closed_priority_with_overlapping_grace():
    """Two back-to-back closed sessions whose grace windows BOTH cover
    event_dt: the newest-first scan must return the more recent one so
    adjacent sessions disambiguate correctly.
    """
    base = _base_dt()
    # First session: open 0s, close 5s. Grace runs to 5 + 30 = 35s.
    _install_closed(0.0, 5.0, base=base)
    # Second session: open 10s, close 15s. Grace runs to 15 + 30 = 45s.
    _install_closed(10.0, 15.0, base=base)
    # Event at 20s falls inside the second session (open 10 ≤ 20 ≤ 45) AND
    # inside the first session's grace (0 ≤ 20 ≤ 35). Newest-first scan
    # must return the second.
    event_ts = _iso(base + timedelta(seconds=20.0))

    session, matched = session_capture.get_frames_for_event(
        event_ts,
        wait_for_close_s=0.0,
        wait_for_video_s=0.0,
    )

    assert matched is True
    assert session is not None
    assert session["open_ts"] == _iso(base + timedelta(seconds=10.0))


def test_get_frames_for_event_event_before_any_session_returns_no_match():
    """An event whose timestamp is before every session's open_ts must
    NOT match the earliest session (prevents "most recent" fallback bug).
    """
    base = _base_dt()
    _install_closed(10.0, 15.0, base=base)
    # Event well before the session opened.
    event_ts = _iso(base + timedelta(seconds=-5.0))

    session, matched = session_capture.get_frames_for_event(
        event_ts,
        wait_for_close_s=0.0,
        wait_for_video_s=0.0,
    )

    assert session is None
    assert matched is False


def test_get_frames_for_event_unparseable_ts_returns_no_match():
    """A malformed event timestamp must return (None, False) without
    crashing — we log and drop rather than raising.
    """
    # Seed a valid session so any fallback path would produce a match.
    _install_closed(0.0, 5.0)

    session, matched = session_capture.get_frames_for_event(
        "not-an-iso-timestamp",
        wait_for_close_s=0.0,
        wait_for_video_s=0.0,
    )

    assert session is None
    assert matched is False


# ---------------------------------------------------------------------------
# reset()
# ---------------------------------------------------------------------------


def test_reset_clears_current_and_closed():
    """reset() must empty both the in-progress current session and the
    ring of published closed sessions — called by the admin wipe path
    so in-memory references don't outlive their on-disk frames.
    """
    base = _base_dt()
    # Install both a current session and a closed one.
    with session_capture._LOCK:
        session_capture._CURRENT = {
            "open_ts": _iso(base),
            "close_ts": None,
            "before_path": None,
            "after_path": None,
            "video_path": None,
        }
    _install_closed(0.0, 5.0, base=base)
    # Sanity check: state is populated.
    with session_capture._LOCK:
        assert session_capture._CURRENT is not None
        assert len(session_capture._CLOSED) == 1

    session_capture.reset()

    with session_capture._LOCK:
        assert session_capture._CURRENT is None
        assert len(session_capture._CLOSED) == 0


def test_reset_alias_for_tests_clears_state():
    """Backward-compat alias ``_reset_for_tests`` must behave identically
    to ``reset()`` so old call sites keep working.
    """
    _install_closed(0.0, 5.0)
    with session_capture._LOCK:
        assert len(session_capture._CLOSED) == 1

    session_capture._reset_for_tests()

    with session_capture._LOCK:
        assert session_capture._CURRENT is None
        assert len(session_capture._CLOSED) == 0


# ---------------------------------------------------------------------------
# _handle_open / _handle_close lifecycle (via register())
# ---------------------------------------------------------------------------


def test_handle_open_installs_current_session(tmp_path: Path):
    """A single brightness 'open' transition must set _CURRENT with the
    correct open_ts and clear close/before/after/video paths.
    """
    daemon = _FakeDaemon(ring=[])
    session_capture.register(daemon, tmp_path)

    ts_open = _iso(_base_dt())
    daemon.emit(BrightnessTransition("open", ts_open, 120.0))

    with session_capture._LOCK:
        assert session_capture._CURRENT is not None
        assert session_capture._CURRENT["open_ts"] == ts_open
        assert session_capture._CURRENT["close_ts"] is None
        assert session_capture._CURRENT["before_path"] is None


def test_handle_open_replaces_orphan_current(tmp_path: Path, caplog):
    """Two consecutive opens (no close between) must drop the orphan
    and install the newer session. A warning must be logged so the issue
    is visible in production logs.
    """
    daemon = _FakeDaemon(ring=[])
    session_capture.register(daemon, tmp_path)

    ts_first = _iso(_base_dt())
    ts_second = _iso(_base_dt() + timedelta(seconds=5.0))

    with caplog.at_level("WARNING"):
        daemon.emit(BrightnessTransition("open", ts_first, 120.0))
        daemon.emit(BrightnessTransition("open", ts_second, 130.0))

    with session_capture._LOCK:
        assert session_capture._CURRENT is not None
        # The newer open_ts replaces the orphan.
        assert session_capture._CURRENT["open_ts"] == ts_second

    # The orphan-drop must be logged so the operator sees the missed close.
    assert any(
        "orphan" in rec.getMessage().lower() for rec in caplog.records
    ), "expected an orphan warning when a second open replaces _CURRENT"


def test_handle_close_without_open_is_no_op(tmp_path: Path, caplog):
    """A close transition with no active _CURRENT must log a warning
    but must not crash, mutate _CLOSED, or touch disk.
    """
    daemon = _FakeDaemon(ring=[])
    session_capture.register(daemon, tmp_path)

    # Precondition: state is empty.
    with session_capture._LOCK:
        assert session_capture._CURRENT is None
        assert len(session_capture._CLOSED) == 0

    with caplog.at_level("WARNING"):
        daemon.emit(BrightnessTransition(
            "close", _iso(_base_dt()), 5.0
        ))

    # Post-condition: still empty.
    with session_capture._LOCK:
        assert session_capture._CURRENT is None
        assert len(session_capture._CLOSED) == 0

    assert any(
        "no open session" in rec.getMessage()
        for rec in caplog.records
    ), "expected 'no open session' warning on stray close"


def test_handle_close_with_no_lit_frames_drops_session(tmp_path: Path):
    """Close handler must silently drop a session whose ring snapshot
    produces zero lit frames (no before/after can be picked). _CURRENT
    is cleared; _CLOSED gets nothing; the (empty) session dir is removed.
    """
    # Empty ring → no lit frames survive the filter.
    daemon = _FakeDaemon(ring=[])
    session_capture.register(daemon, tmp_path)

    base = _base_dt()
    ts_open = _iso(base)
    ts_close = _iso(base + timedelta(seconds=2.0))

    daemon.emit(BrightnessTransition("open", ts_open, 120.0))
    daemon.emit(BrightnessTransition("close", ts_close, 5.0))

    # _CURRENT is cleared, no closed session published.
    with session_capture._LOCK:
        assert session_capture._CURRENT is None
        assert len(session_capture._CLOSED) == 0


# ---------------------------------------------------------------------------
# pick_event_frames — invariants from the B1/B2 bug forensics
# ---------------------------------------------------------------------------


def _build_lit_frames(
    timestamps_s: list[float],
    brightnesses: Optional[list[float]] = None,
    *,
    base: Optional[datetime] = None,
) -> list[tuple[str, str, float]]:
    """Return a ``lit_frames`` list in the on-disk shape (ts, path, bright).

    Paths are synthetic — ``pick_event_frames`` only uses them as opaque
    returns. Brightness defaults to a uniform 200 which is >= 0.8*peak
    so the peak cutoff doesn't filter anything.
    """
    base = base or _base_dt()
    brights = brightnesses if brightnesses is not None else [200.0] * len(timestamps_s)
    assert len(timestamps_s) == len(brights)
    return [
        (
            _iso(base + timedelta(seconds=ts)),
            f"/tmp/frames/f{i:04d}.jpg",
            float(brights[i]),
        )
        for i, ts in enumerate(timestamps_s)
    ]


def test_pick_event_frames_session_boundary_guard_rejects_pre_open():
    """B2 regression: when ``lit_frames`` contains frames from BEFORE the
    session's ``open_ts`` (e.g. leaked from a prior session's retained
    dicts during a back-compat walk), ``pick_event_frames`` must never
    return those frames. The "before" for event N in a brand-new session
    must fall inside the session window, not pick up a pre-open frame.
    """
    base = _base_dt()
    # lit_frames has 5 pre-open frames at t=-5..-1s and 3 in-session
    # frames at t=1..3s. Event fires at t=3s.
    timestamps = [-5.0, -4.0, -3.0, -2.0, -1.0, 1.0, 2.0, 3.0]
    lit_frames = _build_lit_frames(timestamps, base=base)

    session = {
        "open_ts": _iso(base),  # session opens at t=0
        "close_ts": _iso(base + timedelta(seconds=4.0)),
        "lit_frames": lit_frames,
    }
    event_pi_ts = _iso(base + timedelta(seconds=3.0))

    before_ts, before_path, after_ts, after_path = session_capture.pick_event_frames(
        session, event_pi_ts,
    )

    # Every returned ts must be at or after open_ts. The pre-open frames
    # at t=-5..-1 must NEVER appear in the output.
    for ts_out in (before_ts, after_ts):
        if ts_out is None:
            continue
        f_dt = datetime.fromisoformat(ts_out.replace("Z", "+00:00"))
        assert f_dt >= base, (
            f"frame ts {ts_out} precedes session open {_iso(base)} — "
            "session-boundary guard failed"
        )


def test_pick_event_frames_chain_forward_progress_for_rapid_events():
    """B1 regression: rapid back-to-back events (~3-4s apart) must each
    receive their OWN "after" frame. Without the MIN_AFTER_CHAIN_GAP_S
    clamp, event 2's ``after_target = event_2.ts - 1.0s`` can land
    before event 1's stability ts, returning the same (stale) frame for
    both events.
    """
    base = _base_dt()
    # 10 frames at 0.5s cadence covering 0..4.5s. Both events must
    # resolve to DIFFERENT frame indexes.
    timestamps = [i * 0.5 for i in range(10)]
    lit_frames = _build_lit_frames(timestamps, base=base)

    session = {
        "open_ts": _iso(base),
        "close_ts": _iso(base + timedelta(seconds=5.0)),
        "lit_frames": lit_frames,
    }
    # Event 1 at t=1.5s, Event 2 at t=2.2s (only 0.7s apart — narrower
    # than EVENT_AFTER_LOOKBACK_S=1.0s, so the naive "after_2 = t_2 -
    # 1.0s = 1.2s" would be BEFORE event 1's stability at t=1.5s).
    ev1_ts = _iso(base + timedelta(seconds=1.5))
    ev2_ts = _iso(base + timedelta(seconds=2.2))

    # Event 2's pick, chained off event 1:
    _b_ts, _b_path, after_ts, _a_path = session_capture.pick_event_frames(
        session, ev2_ts, prior_event_pi_ts=ev1_ts,
    )

    assert after_ts is not None
    after_dt = datetime.fromisoformat(after_ts.replace("Z", "+00:00"))
    ev1_dt = datetime.fromisoformat(ev1_ts.replace("Z", "+00:00"))
    # Chain invariant: event 2's "after" must be AFTER event 1's
    # stability ts (plus the minimum chain gap).
    assert after_dt >= ev1_dt + timedelta(
        seconds=session_capture.MIN_AFTER_CHAIN_GAP_S
    ), (
        f"after_ts {after_ts} precedes prior event ts + gap "
        f"{_iso(ev1_dt + timedelta(seconds=session_capture.MIN_AFTER_CHAIN_GAP_S))} "
        "— chain invariant failed"
    )
    # And before the event's own stability ts.
    ev2_dt = datetime.fromisoformat(ev2_ts.replace("Z", "+00:00"))
    assert after_dt <= ev2_dt, (
        f"after_ts {after_ts} is later than event's own ts {ev2_ts} — "
        "after frame must not include post-event activity"
    )


def test_pick_event_frames_before_never_precedes_session_open():
    """B2 regression (chain direction): the "before" anchor for event N
    is computed from ``prior_event_ts - EVENT_AFTER_LOOKBACK_S``. When
    the prior event fired within 1 second of session open, that
    subtraction can rewind past open_ts. The picker must clamp to the
    session floor instead of walking into the prior-session's frames.
    """
    base = _base_dt()
    # Lit frames cover only in-session timestamps.
    timestamps = [i * 0.2 for i in range(20)]  # 0..3.8s
    lit_frames = _build_lit_frames(timestamps, base=base)

    session = {
        "open_ts": _iso(base),
        "close_ts": _iso(base + timedelta(seconds=4.0)),
        "lit_frames": lit_frames,
    }
    # Prior event at t=0.3s (very soon after open). Current event at t=2.0s.
    prior_ts = _iso(base + timedelta(seconds=0.3))
    curr_ts = _iso(base + timedelta(seconds=2.0))

    before_ts, _b_path, _a_ts, _a_path = session_capture.pick_event_frames(
        session, curr_ts, prior_event_pi_ts=prior_ts,
    )

    # before_target would be t=-0.7s (prior_ts - 1.0s lookback), which
    # is pre-open. The clamp to session_floor_dt means the picked
    # before_ts must be inside the session.
    assert before_ts is not None
    before_dt = datetime.fromisoformat(before_ts.replace("Z", "+00:00"))
    assert before_dt >= base, (
        f"before_ts {before_ts} precedes session open {_iso(base)} — "
        "session-boundary clamp on before_target failed"
    )


def test_pick_event_frames_before_chain_floor_rejects_pre_prior_event_frames():
    """B1 (before-side) regression: event 2's ``before`` must never land
    on a frame captured BEFORE event 1's stability ts. Without the
    chain-floor clamp on ``before_target``, rapid back-to-back events
    (<2 * EVENT_AFTER_LOOKBACK_S apart) compute ``before_target =
    prior_ts - 1.0s`` which rewinds past event 1 itself — and the
    picker happily returns that pre-event-1 frame as event 2's
    "before". Observed 2026-04-16: 4-item back-to-back lift where
    event 2's before frame showed the full shelf (state from BEFORE
    event 1 removed 3 items), making the visual diff reflect both
    events combined instead of just event 2's removal.
    """
    base = _base_dt()
    # Dense frames: 0.1s cadence covering 0..4.0s.
    timestamps = [i * 0.1 for i in range(41)]
    lit_frames = _build_lit_frames(timestamps, base=base)

    session = {
        "open_ts": _iso(base),
        "close_ts": _iso(base + timedelta(seconds=5.0)),
        "lit_frames": lit_frames,
    }
    # Two events 0.96s apart (matches the observed production case).
    # With EVENT_AFTER_LOOKBACK_S=1.0s, naive before_target = 2.5 - 1.0
    # = 1.5s, which lands BEFORE event 1 at 2.5s. Chain clamp must push
    # it forward.
    ev1_ts = _iso(base + timedelta(seconds=2.5))
    ev2_ts = _iso(base + timedelta(seconds=3.46))

    before_ts, _b_path, _a_ts, _a_path = session_capture.pick_event_frames(
        session, ev2_ts, prior_event_pi_ts=ev1_ts,
    )

    assert before_ts is not None
    before_dt = datetime.fromisoformat(before_ts.replace("Z", "+00:00"))
    ev1_dt = datetime.fromisoformat(ev1_ts.replace("Z", "+00:00"))
    # Chain invariant: event 2's "before" must be AFTER event 1's
    # stability ts (plus the minimum chain gap). Otherwise the visual
    # diff silently includes event 1's removal.
    floor = ev1_dt + timedelta(seconds=session_capture.MIN_AFTER_CHAIN_GAP_S)
    assert before_dt >= floor, (
        f"before_ts {before_ts} precedes prior event ts + chain gap "
        f"{_iso(floor)} — event 2's before would falsely include event 1's"
        " removed items in the visual diff"
    )
