"""Tests for server.cloud.livetrack_poller.LiveTrackPoller.

Scope: exercise the snapshot / state-machine contract via ``tick_once``.
The timing loop itself (``_run``) is not covered here — it's a thin
``_stop.wait(...)`` wrapper whose cadences are asserted indirectly via
the sleep-arg computation being exercised here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.livetrack_poller import (  # noqa: E402
    ACTIVE_POLL_S,
    IDLE_POLL_S,
    LiveTrackPoller,
)


class _StubClient:
    """Minimal CloudClient stub with scripted responses."""

    def __init__(self) -> None:
        self.sessions_to_return: list = []  # FIFO
        self.updates: list[tuple[str, dict]] = []

    def get_active_livetrack_session(self):
        if not self.sessions_to_return:
            return None
        nxt = self.sessions_to_return.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def post_livetrack_session_update(self, session_id, **fields):
        self.updates.append((session_id, dict(fields)))
        return {"session_id": session_id, **fields}


# ---------------------------------------------------------------------------
# Snapshot contract
# ---------------------------------------------------------------------------


def test_snapshot_none_before_any_poll():
    poller = LiveTrackPoller(_StubClient())
    assert poller.snapshot() is None


def test_snapshot_reflects_last_poll_result():
    client = _StubClient()
    client.sessions_to_return = [
        {"session_id": "s1", "state": "waiting_scale"},
    ]
    poller = LiveTrackPoller(client)

    poller.tick_once()

    snap = poller.snapshot()
    assert snap is not None
    assert snap["session_id"] == "s1"
    assert snap["state"] == "waiting_scale"


def test_snapshot_returns_shallow_copy():
    """Mutating the returned snapshot must not bleed back into the poller."""
    client = _StubClient()
    client.sessions_to_return = [
        {"session_id": "s1", "state": "waiting_scale"},
    ]
    poller = LiveTrackPoller(client)
    poller.tick_once()

    snap = poller.snapshot()
    assert snap is not None
    snap["state"] = "mutated"

    snap2 = poller.snapshot()
    assert snap2["state"] == "waiting_scale"


def test_snapshot_clears_when_session_goes_away():
    """Two ticks: first returns a session, second returns None → snapshot None."""
    client = _StubClient()
    client.sessions_to_return = [
        {"session_id": "s1", "state": "waiting_barcode"},
        # Second tick_once: no scripted response → stub returns None.
    ]
    poller = LiveTrackPoller(client)

    poller.tick_once()
    assert poller.snapshot() is not None

    poller.tick_once()
    assert poller.snapshot() is None


# ---------------------------------------------------------------------------
# Cadence (read the computed sleep directly, don't actually sleep)
# ---------------------------------------------------------------------------


def test_poll_cadence_active_vs_idle():
    """``_poll_once`` returns True iff a session was returned.

    The loop in ``_run`` uses that bool to pick between ACTIVE_POLL_S
    (500ms) and IDLE_POLL_S (2s). Verify the boolean contract + the
    module-level constants so a regression in either surfaces.
    """
    client = _StubClient()
    client.sessions_to_return = [
        {"session_id": "s1", "state": "waiting_barcode"},
    ]
    poller = LiveTrackPoller(client)

    # First tick — active.
    assert poller._poll_once() is True
    # Next tick — stub is empty → idle.
    assert poller._poll_once() is False

    # Sanity: the module-level constants match the plan. IDLE_POLL_S was bumped
    # 2s -> 30s in POLLING_REFACTOR_PLAN.md §0 to cut the edge-fn quota burn
    # (the idle pairing-poll was ~43K calls/day); ACTIVE stays 0.5s.
    assert ACTIVE_POLL_S == pytest.approx(0.5)
    assert IDLE_POLL_S == pytest.approx(30.0)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


def test_cloud_error_propagates_to_caller():
    """``_poll_once`` raises on HTTP error — the loop catches + backs off."""
    client = _StubClient()
    client.sessions_to_return = [CloudError(502, "bad gateway")]
    poller = LiveTrackPoller(client)

    with pytest.raises(CloudError):
        poller._poll_once()
    # Snapshot must remain None when the poll failed.
    assert poller.snapshot() is None


def test_seed_snapshot_populates_without_starting_thread():
    client = _StubClient()
    client.sessions_to_return = [
        {"session_id": "s1", "state": "waiting_scale"},
    ]
    poller = LiveTrackPoller(client)

    poller.seed_snapshot()

    snap = poller.snapshot()
    assert snap is not None
    assert snap["session_id"] == "s1"


def test_seed_snapshot_swallows_errors():
    """Seed must never raise — a transient outage at boot can't kill app.py."""
    client = _StubClient()
    client.sessions_to_return = [CloudError(500, "boom")]
    poller = LiveTrackPoller(client)

    poller.seed_snapshot()  # does not raise
    assert poller.snapshot() is None
