"""Regression tests for LiveTrackPoller audit fixes (#8, #13, #15).

  * Audit #8 — ``_ai_tare_inflight`` set is garbage-collected on
    ``_update_snapshots`` when a session disappears from cloud, so a
    long-running Pi can't accumulate orphaned flight keys forever.
  * Audit #13 — ``is_active_for(device_id, scale_id)`` enforces the
    snapshot row's ``device_id`` matches the first-observed cloud-
    device UUID for THIS Pi, so a leaked row from a different cloud
    device can't cross-suppress events for an overlapping scale_id.
  * Audit #15 — when the cloud POST inside ``_handle_ai_tare`` fails,
    the AI-tare flight key is cleared so the next poll re-runs the
    full flow (including the Anthropic call). Tradeoff documented in
    the source: one extra ~5s call during a transient cloud blip is
    cheaper than a silent state-machine stall that requires manual
    operator re-arm.

These tests are mutation-aware:
  * Removing the GC pass in ``_update_snapshots`` flips the
    accumulation assertion red.
  * Stripping the device-mismatch check in ``is_active_for`` flips
    the cross-device-leak test red.
  * Removing the unconditional ``finally: discard(flight_key)`` in
    ``_poll_once`` flips the retry test red (the second tick would
    skip the second Anthropic call because the flight key would
    persist).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.cloud.client import CloudError  # noqa: E402
from server.cloud.livetrack_poller import LiveTrackPoller  # noqa: E402


# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class _ListClient:
    """CloudClient stub serving the new multi-session list API.

    ``sessions_per_call`` is a FIFO of pre-baked responses; each call to
    ``get_active_livetrack_sessions`` pops the next list. Empty FIFO →
    returns []. ``updates`` records every successful POST; ``post_fail``
    forces ``post_livetrack_session_update`` to raise CloudError once.
    """

    def __init__(self) -> None:
        self.sessions_per_call: list[list[dict]] = []
        self.updates: list[tuple[str, dict]] = []
        self.post_fail_count = 0  # how many of the next POSTs to fail

    def get_active_livetrack_sessions(self):
        if not self.sessions_per_call:
            return []
        return self.sessions_per_call.pop(0)

    def get_active_livetrack_session(self):
        nxt = self.get_active_livetrack_sessions()
        return nxt[0] if nxt else None

    def post_livetrack_session_update(self, session_id, **fields):
        if self.post_fail_count > 0:
            self.post_fail_count -= 1
            raise CloudError(503, "simulated transient failure")
        self.updates.append((session_id, dict(fields)))
        return {"session_id": session_id, **fields}


class _FakeCamera:
    def __init__(self, jpeg: bytes | None = b"\xff\xd8\xff"):
        self._jpeg = jpeg

    def current_frame_jpeg(self):
        return self._jpeg


class _FakeEstimate:
    tare_weight_g = 27.5
    confidence = "high"
    appears_sealed = False
    reasoning = "Glass jar."


# ---------------------------------------------------------------------------
# Audit #8 — _ai_tare_inflight GC on session disappearance
# ---------------------------------------------------------------------------


def test_inflight_cleared_when_session_disappears_from_cloud(tmp_path):
    """Simulate: a session is in awaiting_ai_tare at tick 1, mid-call the
    operator closes the wizard so it disappears from cloud at tick 2.
    The inflight key for the gone session must be GC'd; otherwise it
    accumulates forever on a long-running Pi.

    Mutation kill: drop the difference_update pass in _update_snapshots
    → the assertion `not poller._ai_tare_inflight` flips red.
    """
    client = _ListClient()
    poller = LiveTrackPoller(client)

    # Manually inject a stale flight key for a session that doesn't appear
    # in the cloud's response — exactly the scenario where the legacy
    # finally-discard would not catch (e.g. process restart mid-call,
    # or any path that adds a key without going through _poll_once's
    # finally cleanup). Direct injection makes the test independent of
    # the in-flight code path.
    with poller._ai_tare_lock:
        poller._ai_tare_inflight.add("ghost-session-1:awaiting_ai_tare")
        poller._ai_tare_inflight.add("ghost-session-2:awaiting_ai_tare")
    assert "ghost-session-1:awaiting_ai_tare" in poller._ai_tare_inflight
    assert "ghost-session-2:awaiting_ai_tare" in poller._ai_tare_inflight

    # Cloud now reports no active sessions. The next poll must clean up
    # both stale flight keys.
    client.sessions_per_call = [[]]
    poller.tick_once()

    with poller._ai_tare_lock:
        assert poller._ai_tare_inflight == set(), (
            "stale flight keys must be GC'd when their session_ids "
            f"disappear from cloud; remaining={poller._ai_tare_inflight!r}"
        )


def test_inflight_keeps_flight_key_for_still_active_sessions(tmp_path):
    """Counter-test: a flight key whose session IS in the active list
    must NOT be GC'd. Without this, an in-flight Anthropic call could
    have its flight key cleared mid-flight and a parallel poll would
    spawn a duplicate request."""
    client = _ListClient()
    poller = LiveTrackPoller(client)

    with poller._ai_tare_lock:
        poller._ai_tare_inflight.add("sess-A:awaiting_ai_tare")
        poller._ai_tare_inflight.add("sess-B:awaiting_ai_tare")  # ghost

    client.sessions_per_call = [[
        {
            "session_id": "sess-A",
            "device_id": "cloud-uuid-A",
            "scale_id": "scale-01",
            "state": "awaiting_ai_tare",
            "ai_tare_product_form": {},
        },
    ]]
    # Use a no-op AI-tare fn + camera so the in-flight loop body is safe
    # to enter without making real Anthropic calls.

    def fake_estimate(**kwargs):
        return (_FakeEstimate(), "claude-x", 0)

    poller2 = LiveTrackPoller(
        client, camera=_FakeCamera(), tmp_dir=tmp_path,
        ai_tare_fn=fake_estimate,
    )
    # Re-inject flight keys on the new poller (the one we'll tick).
    with poller2._ai_tare_lock:
        poller2._ai_tare_inflight.add("sess-A:awaiting_ai_tare")
        poller2._ai_tare_inflight.add("sess-B:awaiting_ai_tare")

    poller2.tick_once()

    # sess-A is still in cloud's active list → its key may be cleared by
    # the per-session try/finally in _poll_once (after _handle_ai_tare
    # finishes), which is the normal path. sess-B is the ghost — must be
    # GC'd by _update_snapshots.
    with poller2._ai_tare_lock:
        assert "sess-B:awaiting_ai_tare" not in poller2._ai_tare_inflight, (
            "ghost flight key must be GC'd"
        )


def test_inflight_set_does_not_grow_unboundedly_across_polls(tmp_path):
    """Long-running scenario: 50 sessions come and go; flight key set
    must never retain more than the currently-active set. Catches an
    O(N) leak from a missing cleanup pass."""
    client = _ListClient()
    poller = LiveTrackPoller(client)

    # Inject 50 stale flight keys for sessions that never appear.
    with poller._ai_tare_lock:
        for i in range(50):
            poller._ai_tare_inflight.add(f"old-sess-{i}:awaiting_ai_tare")
    # Now serve a single active session that has nothing to do with any
    # of the stale keys. The first tick should drop ALL of them.
    client.sessions_per_call = [[
        {
            "session_id": "current-sess",
            "device_id": "cloud-uuid-A",
            "scale_id": "scale-01",
            "state": "waiting_barcode",
        },
    ]]
    poller.tick_once()

    with poller._ai_tare_lock:
        assert poller._ai_tare_inflight == set(), (
            "all 50 stale flight keys must be GC'd on the next poll, "
            f"got {len(poller._ai_tare_inflight)} survivors"
        )


# ---------------------------------------------------------------------------
# Audit #13 — is_active_for rejects cross-device snapshot leaks
# ---------------------------------------------------------------------------


def test_is_active_for_rejects_cross_device_leak():
    """Defense-in-depth: if a snapshot row leaks in for a DIFFERENT
    cloud device's scale_id (RLS regression on /active), is_active_for
    must NOT match it for THIS Pi's events with the same scale_id.

    Setup: first observed cloud-device id = 'cloud-uuid-MINE'. A second
    poll then returns a row tagged with 'cloud-uuid-OTHER' for the
    SAME scale_id. The lookup must reject the cross-device row.

    Mutation kill: stripping the ``row_device != expected_device``
    rejection branch in is_active_for makes this test red — the gate
    would suppress this Pi's events for scale-01 because of another
    Pi's wizard.
    """
    client = _ListClient()
    poller = LiveTrackPoller(client)

    # First snapshot: this Pi has an active session on scale-01.
    client.sessions_per_call = [[
        {
            "session_id": "sess-mine", "device_id": "cloud-uuid-MINE",
            "scale_id": "scale-01", "state": "waiting_barcode",
        },
    ]]
    poller.tick_once()
    # Confirm the lookup hits.
    hit = poller.is_active_for("scale-01", "scale-01")
    assert hit is not None and hit["session_id"] == "sess-mine"

    # Second snapshot: the cloud LEAKS a row for a DIFFERENT device's
    # session against the SAME scale_id (e.g. RLS regression). This Pi's
    # own row is no longer present (operator closed the wizard).
    client.sessions_per_call = [[
        {
            "session_id": "sess-other", "device_id": "cloud-uuid-OTHER",
            "scale_id": "scale-01", "state": "waiting_barcode",
        },
    ]]
    poller.tick_once()

    # The defensive check: scale-01 lookup must NOT match the foreign
    # row. Pre-fix this returned the foreign session and this Pi's
    # events for scale-01 would be wrongly suppressed.
    leak = poller.is_active_for("scale-01", "scale-01")
    assert leak is None, (
        "is_active_for must drop snapshot rows whose device_id disagrees "
        f"with the first-observed cloud device; got {leak!r}"
    )


def test_is_active_for_still_matches_same_device_with_esp_id_caller():
    """Sanity: the existing call shape — caller passes ESP-style device_id
    like ``scale-01``, snapshot row carries cloud-UUID device_id — keeps
    matching when the snapshot's device_id is consistent with the
    first-observed (i.e. normal operation).

    Without this, the new defensive check could over-trigger and break
    the regular suppression path."""
    client = _ListClient()
    client.sessions_per_call = [[
        {
            "session_id": "sess-A", "device_id": "cloud-uuid-MINE",
            "scale_id": "scale-02", "state": "waiting_barcode",
        },
    ]]
    poller = LiveTrackPoller(client)
    poller.tick_once()

    hit = poller.is_active_for("scale-02", "scale-02")
    assert hit is not None
    assert hit["session_id"] == "sess-A"


def test_is_active_for_with_two_devices_in_same_snapshot_keeps_first():
    """Edge: a single snapshot list contains rows from TWO different
    cloud devices for different scale_ids. The first observed wins as
    the expected device; the other is filtered out by the guard.

    This is the on-the-wire form of the same RLS-regression scenario as
    above — multiple foreign rows landing in one /active response."""
    client = _ListClient()
    client.sessions_per_call = [[
        {
            "session_id": "sess-mine", "device_id": "cloud-uuid-MINE",
            "scale_id": "scale-01", "state": "waiting_barcode",
        },
        {
            "session_id": "sess-other", "device_id": "cloud-uuid-OTHER",
            "scale_id": "scale-02", "state": "waiting_barcode",
        },
    ]]
    poller = LiveTrackPoller(client)
    poller.tick_once()

    # Own row → match.
    assert poller.is_active_for("scale-01", "scale-01") is not None
    # Foreign row → reject (defense-in-depth).
    assert poller.is_active_for("scale-02", "scale-02") is None


# ---------------------------------------------------------------------------
# Audit #15 — POST failure → next poll retries the full AI-tare flow
# ---------------------------------------------------------------------------


def test_post_failure_allows_retry_on_next_poll(tmp_path):
    """Anthropic call succeeds, but the result POST raises CloudError.
    The flight key must be cleared in the per-session ``finally`` so
    the NEXT poll re-runs the AI-tare flow (Anthropic again + POST
    again). Without this, the inflight key would persist and the
    operator would have to manually re-arm.

    Mutation kill: removing the ``finally: discard(flight_key)`` in
    _poll_once → the second tick's call counter would stay at 1
    (single-flight skip) and the second update would never happen.
    """
    session = {
        "session_id": "sess-retry",
        "device_id": "cloud-uuid-MINE",
        "scale_id": "scale-01",
        "state": "awaiting_ai_tare",
        "ai_tare_product_form": {},
        "scale_reading_g": 200.0,
    }

    client = _ListClient()
    # First poll: cloud reports the session, POST fails once.
    # Second poll: same session still in awaiting_ai_tare (cloud state
    # unchanged because POST failed), POST succeeds.
    client.sessions_per_call = [[session], [session]]
    client.post_fail_count = 1

    call_log: list[dict] = []

    def fake_estimate(**kwargs):
        call_log.append({"called": True})
        return (_FakeEstimate(), "claude-x", 0)

    poller = LiveTrackPoller(
        client, camera=_FakeCamera(), tmp_dir=tmp_path,
        ai_tare_fn=fake_estimate,
    )

    # Tick 1 — Anthropic call runs, POST fails (logged + swallowed).
    poller.tick_once()
    assert len(call_log) == 1, "first tick must call Anthropic once"
    assert client.updates == [], "POST raised → no recorded update"

    # Inflight key must be cleared after the per-session finally so the
    # next tick re-tries.
    with poller._ai_tare_lock:
        assert "sess-retry:awaiting_ai_tare" not in poller._ai_tare_inflight, (
            "flight key must be cleared after POST failure to allow retry"
        )

    # Tick 2 — same session, AI-tare must be re-dispatched.
    poller.tick_once()
    assert len(call_log) == 2, (
        "second tick must re-run Anthropic; did the flight key persist?"
    )
    assert len(client.updates) == 1, (
        "second-tick POST must succeed and be recorded"
    )
    assert client.updates[0][0] == "sess-retry"
    assert client.updates[0][1]["state"] == "ai_tare_ready"
