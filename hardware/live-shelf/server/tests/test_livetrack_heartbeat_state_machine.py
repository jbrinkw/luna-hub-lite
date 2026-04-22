"""Multi-call state-machine tests for the LiveTrack heartbeat bridge.

Context (2026-04-21 retrospective):

The livetrack heartbeat→session bridge had a bug that physical testing
surfaced but NO existing unit test would have caught: on the very first
stable heartbeat while ``livetrack_import_sessions.state == 'waiting_scale'``
the Pi POSTed ``scale_reading_g`` AND flipped ``state`` to
``scale_reading_received``; the GUARD on subsequent heartbeats was
``state == 'waiting_scale'``, so heartbeats #2..N returned without
posting — the user was stuck with whatever weight was on the scale
at the moment of the *first* post (usually empty-scale drift before
the container settled). Fix ``a375b9d`` broadened the guard to
``{waiting_scale, scale_reading_received}`` so subsequent heartbeats
keep streaming until the user accepts. That fix cannot be verified by
a single-call heartbeat test.

This test exercises ``ScaleHandler.handle_heartbeat`` across multiple
invocations with live state transitions between calls:

  1. Arm a session in ``waiting_scale`` state (poller snapshot).
  2. Heartbeat #1 → one POST lands, carries weight=500g.
  3. Simulate the cloud flipping state to ``scale_reading_received``
     (via a tiny mutable poller) — heartbeat #2 must STILL post
     weight=520g (the bug this guards against).
  4. Transition snapshot state to ``ai_tare_ready``; heartbeat #3
     must NOT post (user has accepted; reading is frozen).
  5. Fresh session (different session_id) replaces snapshot;
     heartbeat #4 posts for the new session without bleeding state
     from the previous.

The test also covers the negative-space conditions inline:
unstable heartbeats, out-of-range weights, snapshot==None, non-catch-all
device_ids — none of these should trigger a POST even across multiple
calls.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.config import AppConfig  # noqa: E402
from server.handlers import scale_events as scale_events_mod  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures / doubles
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_runtime_state():
    """Heartbeats populate module-level ``_SCALE_RUNTIME_STATE`` and
    ``_WEIGHT_TRACE``. Reset between tests so one test's writes don't
    bleed into another's assertions.
    """
    scale_events_mod._SCALE_RUNTIME_STATE.clear()
    scale_events_mod._WEIGHT_TRACE.clear()
    yield
    scale_events_mod._SCALE_RUNTIME_STATE.clear()
    scale_events_mod._WEIGHT_TRACE.clear()


class _NullCandidateSource:
    """No-op candidate source for tests that don't exercise matching."""

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


class _MutablePoller:
    """LiveTrack poller stand-in whose snapshot can be updated between
    heartbeats. Mirrors the ``snapshot()`` contract only — the scale-
    event handler never touches the other poller methods during
    ``handle_heartbeat``.

    Tests call :meth:`set_snapshot` to simulate the cloud's Realtime
    state transitions landing in the next poll tick, WITHOUT running
    the real poll thread (which would require a HTTP fake and wall-
    clock pacing).
    """

    def __init__(self, snap):
        self._snap = snap

    def set_snapshot(self, snap):
        self._snap = snap

    def snapshot(self):
        if self._snap is None:
            return None
        return dict(self._snap)


class _FakeCloudClient:
    """Records every ``post_livetrack_session_update`` call.

    The Pi's heartbeat handler calls this method when a stable heartbeat
    lands on the catch-all scale while the livetrack wizard is awaiting
    a reading. This fake is the "cloud outbox" the tests assert
    against — count the entries, inspect per-call fields, verify
    isolation across sessions.
    """

    def __init__(self, *, raise_on_update: bool = False) -> None:
        self.updates: list[tuple[str, dict]] = []
        self.raise_on_update = raise_on_update

    def post_livetrack_session_update(self, session_id, **fields):
        self.updates.append((session_id, dict(fields)))
        if self.raise_on_update:
            raise RuntimeError("cloud down")
        return {"session_id": session_id, **fields}

    # Provide neighbour APIs so the handler's other branches (tare push-
    # back, etc.) don't attribute-error if reached. Not exercised here.
    def post_product_tare(self, *, product_id, tare_g):
        return {"ok": True}


def _make_handler(
    conn,
    tmp_path,
    *,
    cloud_client,
    poller,
    catch_all_enabled: bool = True,
) -> ScaleHandler:
    """Mirror ``test_livetrack_intercept._make_handler`` — build a
    ScaleHandler wired to the fake cloud client + the given poller
    snapshot. Every other subsystem is nulled out because the heartbeat
    path doesn't touch the classifier, camera, or reconciler."""
    cfg = AppConfig()
    cfg.catch_all_enabled = catch_all_enabled
    registry = build_registry_from_config(cfg)
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    handler = ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=catch_all_enabled,
        shelf_registry_override=registry,
        cloud_client=cloud_client,
    )
    handler.set_livetrack_poller(poller)
    return handler


def _heartbeat(
    *,
    ts: str,
    weight_g: float,
    stable: bool = True,
    device_id: str = "scale-02",
    uptime_s: int = 60,
) -> dict:
    """Shape a heartbeat POST payload. scale-02 is the catch-all
    device_id from :func:`server.shelves.build_registry_from_config`."""
    return {
        "ts": ts,
        "device_id": device_id,
        "weight_g": float(weight_g),
        "stable": bool(stable),
        "uptime_s": int(uptime_s),
    }


# ---------------------------------------------------------------------------
# Core regression: MULTI-CALL state machine
# ---------------------------------------------------------------------------


def test_multi_call_waiting_scale_then_scale_reading_received_keeps_posting(tmp_path):
    """Full happy-path state machine across 4 heartbeats.

    Steps:
      1. Arm session in ``waiting_scale`` → heartbeat #1 with weight=500g
         POSTs once and carries ``state='scale_reading_received'``.
      2. Flip snapshot state to ``scale_reading_received`` (simulating the
         cloud Realtime update landing in the next poll) → heartbeat #2
         with weight=520g MUST still POST (bug was: guard refused here,
         user stuck at 500g).
      3. Flip snapshot state to ``ai_tare_ready`` (simulating user
         clicking "Use this reading") → heartbeat #3 with weight=540g
         MUST NOT POST (reading is frozen).
      4. Replace snapshot with a brand-new session in ``waiting_scale``
         → heartbeat #4 MUST POST against the new session_id with
         no cross-session state bleed.
    """
    conn = init_db(":memory:")
    poller = _MutablePoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _FakeCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    # ---- 1. First heartbeat in waiting_scale --------------------------
    resp, status = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:00:00.000Z", weight_g=500.0)
    )
    assert status == 200, resp
    assert len(cloud.updates) == 1, (
        f"first stable heartbeat in waiting_scale must POST once; "
        f"got {len(cloud.updates)} POSTs: {cloud.updates}"
    )
    session_id_1, fields_1 = cloud.updates[0]
    assert session_id_1 == "sess-1"
    assert fields_1["scale_reading_g"] == pytest.approx(500.0)
    assert fields_1["state"] == "scale_reading_received"
    assert "scale_reading_ts" in fields_1

    # ---- 2. Second heartbeat after state flipped to scale_reading_received -
    # This is the regression guard. The 2026-04-21 bug: the Pi refused to
    # POST when state != 'waiting_scale', so the first post's state-flip
    # locked in whatever weight was on the scale at that moment. With
    # fix a375b9d the guard is {waiting_scale, scale_reading_received}
    # so subsequent heartbeats keep streaming until the user accepts.
    poller.set_snapshot({"session_id": "sess-1", "state": "scale_reading_received"})
    resp, status = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:00:01.000Z", weight_g=520.0)
    )
    assert status == 200, resp
    assert len(cloud.updates) == 2, (
        f"a375b9d regression: heartbeat in scale_reading_received state "
        f"must STILL post (user may still be adjusting the container). "
        f"Got {len(cloud.updates)} POSTs total; expected 2. "
        f"Updates: {cloud.updates}"
    )
    session_id_2, fields_2 = cloud.updates[1]
    assert session_id_2 == "sess-1"
    assert fields_2["scale_reading_g"] == pytest.approx(520.0)
    assert fields_2["state"] == "scale_reading_received"

    # ---- 3. User accepted (state=ai_tare_ready) — no further POSTs --------
    # Once the wizard has moved past scale_reading_received, the committed
    # reading is frozen. Further heartbeats must be no-ops.
    poller.set_snapshot({"session_id": "sess-1", "state": "ai_tare_ready"})
    resp, status = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:00:02.000Z", weight_g=540.0)
    )
    assert status == 200, resp
    assert len(cloud.updates) == 2, (
        f"heartbeat while state=ai_tare_ready must NOT post (user has "
        f"accepted; reading is frozen). Got {len(cloud.updates)} total; "
        f"last extra update: {cloud.updates[-1] if cloud.updates else None}"
    )

    # ---- 4. Cross-session isolation ---------------------------------------
    # Session 1 is gone; a fresh arm replaces the snapshot. Next heartbeat
    # must post against sess-2, not sess-1.
    poller.set_snapshot({"session_id": "sess-2", "state": "waiting_scale"})
    resp, status = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:01:00.000Z", weight_g=314.0)
    )
    assert status == 200, resp
    assert len(cloud.updates) == 3, (
        f"heartbeat in a fresh session must post; got {len(cloud.updates)}"
    )
    session_id_3, fields_3 = cloud.updates[2]
    assert session_id_3 == "sess-2", (
        f"cross-session bleed: expected post for sess-2, got {session_id_3}"
    )
    assert fields_3["scale_reading_g"] == pytest.approx(314.0)

    # Sanity: earlier sessions' post records are intact (order preserved).
    assert [u[0] for u in cloud.updates] == ["sess-1", "sess-1", "sess-2"]


# ---------------------------------------------------------------------------
# Each guard in the POST branch, exercised with multiple calls
# ---------------------------------------------------------------------------


def test_unstable_heartbeats_never_post_even_across_many_calls(tmp_path):
    """``stable=false`` short-circuits the POST branch. Verify across
    multiple sequential unstable heartbeats (the scale is often noisy
    before settle)."""
    conn = init_db(":memory:")
    poller = _MutablePoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _FakeCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    for i, w in enumerate([100.0, 500.0, 520.0, 540.0]):
        resp, status = handler.handle_heartbeat(
            _heartbeat(
                ts=f"2026-04-21T12:00:0{i}.000Z",
                weight_g=w,
                stable=False,
            )
        )
        assert status == 200

    assert cloud.updates == [], (
        f"unstable heartbeats must never post; got {cloud.updates}"
    )


def test_snapshot_none_blocks_post_across_calls(tmp_path):
    """Before the livetrack poller has seen its first active session
    (or when no session is armed) the snapshot is None. The POST branch
    must be a no-op regardless of how many heartbeats arrive."""
    conn = init_db(":memory:")
    poller = _MutablePoller(None)
    cloud = _FakeCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    for i in range(3):
        resp, status = handler.handle_heartbeat(
            _heartbeat(ts=f"2026-04-21T12:00:0{i}.000Z", weight_g=500.0 + i)
        )
        assert status == 200

    assert cloud.updates == []


def test_non_catch_all_device_does_not_post_across_calls(tmp_path):
    """The heartbeat→livetrack bridge is catch-all specific. Heartbeats
    from the live-shelf device (scale-01) must not intercept, even when
    a livetrack session is armed."""
    conn = init_db(":memory:")
    poller = _MutablePoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _FakeCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    for i in range(3):
        resp, status = handler.handle_heartbeat(
            _heartbeat(
                ts=f"2026-04-21T12:00:0{i}.000Z",
                weight_g=500.0,
                device_id="scale-01",  # live-shelf, NOT catch-all
            )
        )
        assert status == 200

    assert cloud.updates == [], (
        f"live-shelf heartbeats must not post to livetrack; got {cloud.updates}"
    )


def test_out_of_range_weight_filters_across_calls(tmp_path):
    """The POST branch requires ``5g < weight_g < 5000g`` — too light
    (hand flutter) and too heavy (finger press / bad reading) must be
    filtered. Verify the filter holds across multiple sequential
    heartbeats so we don't mistakenly post a transient noise spike."""
    conn = init_db(":memory:")
    poller = _MutablePoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _FakeCloudClient()
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    # Sub-threshold chain (empty scale noise).
    for i, w in enumerate([0.1, 1.0, 4.9, 5.0]):
        resp, status = handler.handle_heartbeat(
            _heartbeat(ts=f"2026-04-21T12:00:0{i}.000Z", weight_g=w)
        )
        assert status == 200
    assert cloud.updates == [], (
        f"weights <= 5g must not post; got {cloud.updates}"
    )

    # Over-threshold chain (something crushing the scale / bad reading).
    for i, w in enumerate([5001.0, 10000.0]):
        resp, status = handler.handle_heartbeat(
            _heartbeat(ts=f"2026-04-21T12:00:1{i}.000Z", weight_g=w)
        )
        assert status == 200
    assert cloud.updates == [], (
        f"weights >= 5000g must not post; got {cloud.updates}"
    )

    # Sanity check: a valid weight in the same handler/poller DOES post —
    # proves the filter above is weight-specific, not a general block.
    resp, status = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:00:30.000Z", weight_g=500.0)
    )
    assert status == 200
    assert len(cloud.updates) == 1


def test_cloud_post_failure_does_not_block_subsequent_heartbeats(tmp_path):
    """If the cloud is down, one POST raises — but the next heartbeat
    MUST still try. The heartbeat path swallows exceptions internally
    (wrapped in ``try/except Exception``) so a transient cloud outage
    doesn't kill the heartbeat endpoint."""
    conn = init_db(":memory:")
    poller = _MutablePoller({"session_id": "sess-1", "state": "waiting_scale"})
    cloud = _FakeCloudClient(raise_on_update=True)
    handler = _make_handler(conn, tmp_path, cloud_client=cloud, poller=poller)

    # First heartbeat: cloud raises. Handler must return 200 (not 500 —
    # the ESP would retry on 500 and flood us).
    resp1, status1 = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:00:00.000Z", weight_g=500.0)
    )
    assert status1 == 200, resp1

    # Second heartbeat: still raises, but still attempted.
    resp2, status2 = handler.handle_heartbeat(
        _heartbeat(ts="2026-04-21T12:00:01.000Z", weight_g=520.0)
    )
    assert status2 == 200, resp2

    # Both attempts recorded in the fake outbox (the raise happens AFTER
    # append, mimicking a request that reaches the server but errors out).
    assert len(cloud.updates) == 2
    # Fake's raise behavior guarantees the handler caught it — if it
    # hadn't, the second call wouldn't have returned 200.
    assert [u[1]["scale_reading_g"] for u in cloud.updates] == [
        pytest.approx(500.0),
        pytest.approx(520.0),
    ]
