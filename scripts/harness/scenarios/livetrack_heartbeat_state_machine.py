"""Scenario: livetrack heartbeat state machine — cloud round-trip.

Pins the 2026-04-21 regression (fix ``a375b9d``).

Bug replayed
------------
The Pi's ``handle_heartbeat`` had a guard ``state == 'waiting_scale'`` on
the heartbeat→session bridge. The very first heartbeat flipped state
to ``scale_reading_received``, so every subsequent heartbeat's guard
failed and no further ``scale_reading_g`` updates landed in the cloud.
The user was stuck with whatever weight the scale happened to read at
the moment of the first post (usually empty-scale drift). Fix a375b9d
broadened the guard to ``{waiting_scale, scale_reading_received}``.

Why this is a HARNESS scenario (not just a unit test)
-----------------------------------------------------
The existing unit test (``test_livetrack_heartbeat_state_machine.py``)
uses a ``_FakeCloudClient`` — it asserts that ``post_livetrack_session_
update`` was CALLED. It does NOT verify the cloud round-trip:
  * the edge function actually accepts the update
  * the row in ``chefbyte.livetrack_import_sessions`` reflects the
    final heartbeat's reading (not the first)
  * session state transitions are valid per the cloud's CHECK constraint
The harness exercises the real cloud path so a bug that's internal to
the edge function (missing column write, wrong state validation,
dropped field) would ALSO fail here even if the Pi-side mock-based
unit test passes.

Assertions walk-through (what would have caught the a375b9d bug)
----------------------------------------------------------------
After 3 heartbeats with weights 500 → 520 → 540:
  * PRE-FIX: cloud session.scale_reading_g == 500 (first post only)
  * POST-FIX: cloud session.scale_reading_g == 540 (each heartbeat
    updated it)

The final-value check below — ``scale_reading_g == 540`` — is the one
that flips from fail to pass across the a375b9d boundary. That's the
load-bearing assertion.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")

# Make the live-shelf server importable (the orchestrator already did
# this at module-load time — redo it here defensively in case a test
# harness imports this module in isolation).
REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))

from server.handlers import scale_events as scale_events_mod  # noqa: E402


class _MutablePoller:
    """Stand-in LiveTrackPoller whose snapshot is driven by the scenario.

    Mirrors the real ``snapshot()`` contract. The scenario advances the
    snapshot manually between heartbeats, rather than running the real
    poll thread — we get the same state transitions the cloud Realtime
    channel would deliver, without wall-clock pacing.

    ``maybe_set_baseline`` is exposed so the pre-a375b9d handler (which
    called into the poller for an empty-scale baseline gate) also works
    against this stub. Post-fix code never calls it, so it's a no-op
    either way — but the scenario's "would have failed pre-fix"
    property depends on the pre-fix code getting past the poller API
    surface to the actual buggy guard.
    """

    def __init__(self, snap):
        self._snap = snap
        self._baseline_g = None

    def set_snapshot(self, snap):
        self._snap = snap

    def snapshot(self):
        if self._snap is None:
            return None
        return dict(self._snap)

    def maybe_set_baseline(self, weight_g):
        # Matches the real LiveTrackPoller semantics: first call captures,
        # subsequent calls return the captured value.
        if self._baseline_g is None:
            self._baseline_g = float(weight_g)
        return self._baseline_g


@scenario("livetrack_heartbeat_state_machine")
def _livetrack_heartbeat(ctx: HarnessContext) -> None:
    # 1. Seed cloud: user + device + active waiting_scale session.
    ctx.seed_cloud_user()
    ctx.seed_device()
    session_id = ctx.seed_livetrack_session(state="waiting_scale")

    ctx.check(
        "cloud_session_seeded",
        True,
        evidence=f"session_id={session_id} state=waiting_scale",
    )

    # Reset scale_events module runtime state — heartbeats touch a
    # module-level dict so back-to-back scenarios could otherwise
    # interfere.
    scale_events_mod._SCALE_RUNTIME_STATE.clear()
    scale_events_mod._WEIGHT_TRACE.clear()

    # 2. Build Pi-side objects pointed at the REAL cloud livetrack edge
    # function. The catch-all shelf id is bound to ESP device_id
    # 'scale-02' per server/shelves.py::DEFAULT_REGISTRY.
    poller = _MutablePoller({"session_id": session_id, "state": "waiting_scale"})
    handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
    handler._livetrack_poller = poller

    # 3. Heartbeat #1 — state=waiting_scale, weight=500.
    resp1, status1 = handler.handle_heartbeat({
        "ts": _now_iso(),
        "device_id": "scale-02",  # catch-all
        "weight_g": 500.0,
        "stable": True,
        "uptime_s": 60,
    })
    ctx.check(
        "heartbeat_1_200",
        status1 == 200,
        evidence=f"status={status1} resp={resp1!r}",
    )

    # Cloud should reflect weight=500, state=scale_reading_received.
    row = ctx.q_one(
        "SELECT state, scale_reading_g::text "
        "  FROM chefbyte.livetrack_import_sessions "
        " WHERE session_id = %s",
        (session_id,),
    )
    ctx.check(
        "cloud_after_heartbeat_1_weight_500",
        row is not None and float(row[1] or 0) == 500.0,
        evidence=(
            f"expected scale_reading_g=500.0 "
            f"row={row!r}"
        ),
    )
    ctx.check(
        "cloud_after_heartbeat_1_state_reading_received",
        row is not None and row[0] == "scale_reading_received",
        evidence=f"expected state=scale_reading_received row={row!r}",
    )

    # 4. Simulate the cloud Realtime update landing on the Pi: snapshot
    # now reports state=scale_reading_received.
    poller.set_snapshot(
        {"session_id": session_id, "state": "scale_reading_received"}
    )

    # Heartbeat #2 — weight=520. This is the regression assertion:
    # pre-fix, the Pi's guard short-circuited here and the cloud row
    # would STILL read 500.
    resp2, status2 = handler.handle_heartbeat({
        "ts": _now_iso(offset_s=1.0),
        "device_id": "scale-02",
        "weight_g": 520.0,
        "stable": True,
        "uptime_s": 61,
    })
    ctx.check(
        "heartbeat_2_200",
        status2 == 200,
        evidence=f"status={status2} resp={resp2!r}",
    )

    row = ctx.q_one(
        "SELECT scale_reading_g::text "
        "  FROM chefbyte.livetrack_import_sessions "
        " WHERE session_id = %s",
        (session_id,),
    )
    ctx.check(
        "cloud_after_heartbeat_2_weight_520",
        row is not None and float(row[0] or 0) == 520.0,
        evidence=(
            f"a375b9d regression: post-fix, heartbeat #2 must UPDATE "
            f"scale_reading_g to 520. Pre-fix, it would still be 500 "
            f"because the Pi's guard rejected posts outside "
            f"state=waiting_scale. Got row={row!r}"
        ),
    )

    # 5. Heartbeat #3 — weight=540. Proves the stream keeps going as
    # long as the session hasn't advanced past scale_reading_received.
    resp3, status3 = handler.handle_heartbeat({
        "ts": _now_iso(offset_s=2.0),
        "device_id": "scale-02",
        "weight_g": 540.0,
        "stable": True,
        "uptime_s": 62,
    })
    ctx.check(
        "heartbeat_3_200",
        status3 == 200,
        evidence=f"status={status3} resp={resp3!r}",
    )
    row = ctx.q_one(
        "SELECT scale_reading_g::text, state "
        "  FROM chefbyte.livetrack_import_sessions "
        " WHERE session_id = %s",
        (session_id,),
    )
    ctx.check(
        "cloud_after_heartbeat_3_weight_540",
        row is not None and float(row[0] or 0) == 540.0,
        evidence=(
            f"final heartbeat must carry weight=540; got row={row!r}"
        ),
    )

    # 6. Post-accept no-op: simulate the user clicking "Use this reading"
    # — state transitions to ai_tare_ready. Subsequent heartbeats must
    # NOT further mutate scale_reading_g.
    poller.set_snapshot(
        {"session_id": session_id, "state": "ai_tare_ready"}
    )
    # Also reflect that in the cloud row so the Pi's snapshot and cloud
    # state agree. (In production, the browser's UPDATE triggers this;
    # here we inline.)
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.livetrack_import_sessions "
            "   SET state = 'ai_tare_ready', updated_at = now() "
            " WHERE session_id = %s",
            (session_id,),
        )

    resp4, status4 = handler.handle_heartbeat({
        "ts": _now_iso(offset_s=3.0),
        "device_id": "scale-02",
        # Valid weight (>5g, <5000g), but the poller snapshot says
        # state=ai_tare_ready → the handler's post-accept guard must
        # skip the update regardless of the weight value. If we used
        # an out-of-range weight the out-of-range filter might mask a
        # guard-failure bug.
        "weight_g": 550.0,
        "stable": True,
        "uptime_s": 63,
    })
    ctx.check(
        "heartbeat_4_200",
        status4 == 200,
        evidence=f"status={status4} resp={resp4!r}",
    )
    row = ctx.q_one(
        "SELECT scale_reading_g::text "
        "  FROM chefbyte.livetrack_import_sessions "
        " WHERE session_id = %s",
        (session_id,),
    )
    ctx.check(
        "cloud_post_accept_reading_frozen_at_540",
        row is not None and float(row[0] or 0) == 540.0,
        evidence=(
            f"post-accept heartbeat must NOT overwrite scale_reading_g "
            f"(user has committed 540). Got row={row!r}"
        ),
    )
