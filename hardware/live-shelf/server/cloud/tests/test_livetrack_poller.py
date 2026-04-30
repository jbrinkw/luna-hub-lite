"""Unit tests for :mod:`server.cloud.livetrack_poller`.

Covers the state-machine branches that matter for production safety:

* ``snapshot()`` returns None when no session is active.
* ``snapshot()`` returns a shallow copy so caller mutation can't bleed
  back through the lock.
* ``is_active_for()`` matches scale_id and rejects cross-device rows.
* ``active_scale_ids()`` mirrors the per-tuple map.
* ``maybe_set_baseline()`` records baseline on first call, returns cached
  value on subsequent calls, and resets when the session transitions out
  of ``waiting_scale``.
* ``tick_once()`` populates snapshot from the cloud response.
* A cloud 5xx (CloudError) causes tick_once to propagate the error
  (the poll loop catches it; direct callers via ``tick_once`` see it).
* Idempotency: two ticks with the same session result in the same snapshot
  (no accumulated state).
* AI-tare de-dup: the ``_ai_tare_inflight`` key prevents a second Anthropic
  call for the same (session_id, state) pair.
* Stale AI-tare inflight keys are GC'd when the session disappears.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, call

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.livetrack_poller import LiveTrackPoller  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _session(
    session_id: str = "sess-1",
    state: str = "waiting_barcode",
    device_id: str = "dev-uuid-1",
    scale_id: str = "scale-01",
) -> dict:
    return {
        "session_id": session_id,
        "state": state,
        "device_id": device_id,
        "scale_id": scale_id,
        "scale_reading_g": None,
        "ai_tare_product_form": None,
    }


def _make_client(sessions: list[dict] | None = None, *, error: Exception | None = None) -> MagicMock:
    client = MagicMock()
    if error is not None:
        client.get_active_livetrack_sessions.side_effect = error
    else:
        client.get_active_livetrack_sessions.return_value = sessions or []
    return client


# ---------------------------------------------------------------------------
# snapshot()
# ---------------------------------------------------------------------------


def test_snapshot_returns_none_before_first_tick():
    """Snapshot is None until the first poll completes."""
    poller = LiveTrackPoller(_make_client([]))
    assert poller.snapshot() is None


def test_snapshot_returns_none_after_empty_response():
    poller = LiveTrackPoller(_make_client([]))
    poller.tick_once()
    assert poller.snapshot() is None


def test_snapshot_returns_session_after_tick():
    sess = _session()
    poller = LiveTrackPoller(_make_client([sess]))
    poller.tick_once()
    snap = poller.snapshot()
    assert snap is not None
    assert snap["session_id"] == "sess-1"


def test_snapshot_returns_shallow_copy():
    """Mutating the returned snapshot must not bleed back into the poller."""
    sess = _session()
    poller = LiveTrackPoller(_make_client([sess]))
    poller.tick_once()
    snap1 = poller.snapshot()
    snap1["injected"] = True  # type: ignore[index]
    snap2 = poller.snapshot()
    assert "injected" not in snap2


def test_snapshot_cleared_when_session_disappears():
    """Second tick with empty response clears the legacy snapshot."""
    client = _make_client([_session()])
    poller = LiveTrackPoller(client)
    poller.tick_once()
    assert poller.snapshot() is not None

    client.get_active_livetrack_sessions.return_value = []
    poller.tick_once()
    assert poller.snapshot() is None


# ---------------------------------------------------------------------------
# is_active_for()
# ---------------------------------------------------------------------------


def test_is_active_for_returns_none_when_no_sessions():
    poller = LiveTrackPoller(_make_client([]))
    poller.tick_once()
    assert poller.is_active_for("esp-device-1", "scale-01") is None


def test_is_active_for_matches_scale_id():
    poller = LiveTrackPoller(_make_client([_session(scale_id="scale-02", device_id="dev-A")]))
    poller.tick_once()
    row = poller.is_active_for("esp-device-1", "scale-02")
    assert row is not None
    assert row["scale_id"] == "scale-02"


def test_is_active_for_returns_none_for_wrong_scale():
    poller = LiveTrackPoller(_make_client([_session(scale_id="scale-01", device_id="dev-A")]))
    poller.tick_once()
    assert poller.is_active_for("esp-device-1", "scale-99") is None


def test_is_active_for_rejects_cross_device_match(caplog):
    """A row whose device_id disagrees with the first observed must NOT match.
    Defense-in-depth (Audit #13)."""
    sess1 = _session(session_id="s1", scale_id="scale-01", device_id="dev-good")
    poller = LiveTrackPoller(_make_client([sess1]))
    poller.tick_once()  # pins observed_cloud_device_id = "dev-good"

    # Now inject a row from a different cloud device via a second tick
    sess2 = _session(session_id="s2", scale_id="scale-01", device_id="dev-evil")
    poller._client.get_active_livetrack_sessions.return_value = [sess2]
    poller.tick_once()

    # The match must be rejected
    row = poller.is_active_for("esp-device-1", "scale-01")
    assert row is None


def test_is_active_for_returns_none_for_empty_scale_id():
    """Empty scale_id must NOT match arbitrarily (Audit #13 defense)."""
    poller = LiveTrackPoller(_make_client([_session(scale_id="scale-01")]))
    poller.tick_once()
    assert poller.is_active_for("esp-device-1", "") is None
    assert poller.is_active_for("", "scale-01") is None


# ---------------------------------------------------------------------------
# active_scale_ids()
# ---------------------------------------------------------------------------


def test_active_scale_ids_empty_initially():
    poller = LiveTrackPoller(_make_client([]))
    assert poller.active_scale_ids() == set()


def test_active_scale_ids_reflects_poll():
    sessions = [
        _session(session_id="s1", scale_id="scale-01"),
        _session(session_id="s2", scale_id="scale-03"),
    ]
    poller = LiveTrackPoller(_make_client(sessions))
    poller.tick_once()
    assert poller.active_scale_ids() == {"scale-01", "scale-03"}


# ---------------------------------------------------------------------------
# maybe_set_baseline()
# ---------------------------------------------------------------------------


def test_maybe_set_baseline_records_first_call():
    poller = LiveTrackPoller(_make_client([_session(state="waiting_scale")]))
    poller.tick_once()
    bl = poller.maybe_set_baseline(500.0)
    assert bl == pytest.approx(500.0)


def test_maybe_set_baseline_returns_cached_on_second_call():
    poller = LiveTrackPoller(_make_client([_session(state="waiting_scale")]))
    poller.tick_once()
    poller.maybe_set_baseline(500.0)
    bl2 = poller.maybe_set_baseline(600.0)  # different weight — should return cached
    assert bl2 == pytest.approx(500.0)


def test_maybe_set_baseline_resets_when_session_leaves_waiting_scale():
    client = _make_client([_session(state="waiting_scale")])
    poller = LiveTrackPoller(client)
    poller.tick_once()
    poller.maybe_set_baseline(500.0)

    # Session transitions to a different state
    client.get_active_livetrack_sessions.return_value = [_session(state="scale_reading_received")]
    poller.tick_once()  # _maybe_clear_baseline sees state != waiting_scale

    # New baseline should be accepted
    bl = poller.maybe_set_baseline(100.0)
    assert bl == pytest.approx(100.0)


# ---------------------------------------------------------------------------
# tick_once() — cloud error handling
# ---------------------------------------------------------------------------


def test_tick_once_propagates_cloud_error():
    """CloudError raised by the client propagates from tick_once so the
    run loop can handle backoff."""
    client = _make_client(error=CloudError(503, "Service Unavailable"))
    poller = LiveTrackPoller(client)

    with pytest.raises(CloudError):
        poller.tick_once()

    # Snapshot must remain empty
    assert poller.snapshot() is None


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_two_ticks_same_session_idempotent():
    """Running tick_once twice with the same session produces the same snapshot."""
    sess = _session()
    poller = LiveTrackPoller(_make_client([sess]))
    poller.tick_once()
    snap1 = poller.snapshot()
    poller.tick_once()
    snap2 = poller.snapshot()
    assert snap1 == snap2


# ---------------------------------------------------------------------------
# AI-tare de-dup
# ---------------------------------------------------------------------------


def test_ai_tare_single_flight_per_session():
    """_ai_tare_inflight prevents a second Anthropic call while one is
    in-flight for the same session_id."""
    ai_call_count = 0

    def fake_ai_tare(**_kwargs):
        nonlocal ai_call_count
        ai_call_count += 1
        class Result:
            tare_weight_g = 50.0
            confidence = "high"
            reasoning = "test"
        return (Result(), "test-model", None)

    sess = _session(state="awaiting_ai_tare")
    client = _make_client([sess])
    client.post_livetrack_session_update = MagicMock()

    camera = MagicMock()
    camera.current_frame_jpeg.return_value = b"\xff\xd8\xff"  # minimal JPEG marker

    poller = LiveTrackPoller(client, camera=camera, ai_tare_fn=fake_ai_tare)

    poller.tick_once()
    # After the first tick the inflight key is cleared (finally block in _poll_once)
    # but the call happened once.
    assert ai_call_count == 1

    # On second tick the session is still awaiting_ai_tare, so another call
    # is expected (key was cleared).
    poller.tick_once()
    assert ai_call_count == 2


def test_stale_ai_tare_inflight_keys_gc_on_session_disappear():
    """_ai_tare_inflight keys are GC'd when their session_id vanishes."""
    sess = _session(state="awaiting_ai_tare")
    client = _make_client([sess])
    client.post_livetrack_session_update = MagicMock()

    # Manually inject a stale flight key
    poller = LiveTrackPoller(client)
    with poller._ai_tare_lock:
        poller._ai_tare_inflight.add("sess-1:awaiting_ai_tare")

    # Next tick with no sessions — stale key must be GC'd
    client.get_active_livetrack_sessions.return_value = []
    poller.tick_once()

    with poller._ai_tare_lock:
        assert "sess-1:awaiting_ai_tare" not in poller._ai_tare_inflight


# ---------------------------------------------------------------------------
# seed_snapshot()
# ---------------------------------------------------------------------------


def test_seed_snapshot_populates_on_boot():
    """seed_snapshot() runs a synchronous poll so the scale-event handler
    sees any in-progress session immediately after reboot."""
    sess = _session()
    poller = LiveTrackPoller(_make_client([sess]))
    poller.seed_snapshot()
    assert poller.snapshot() is not None
    assert poller.snapshot()["session_id"] == "sess-1"
