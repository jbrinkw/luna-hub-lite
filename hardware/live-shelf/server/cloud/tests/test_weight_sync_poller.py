"""Unit tests for ``server.cloud.weight_sync_poller.WeightSyncPoller``.

Covers the throttle policy described in the module docstring:
  * First observation always emits.
  * Significant change (>= MIN_DELTA_G) triggers an emit.
  * Sub-threshold drift suppresses the emit.
  * TTL re-emit fires for stable lots.
  * Catch-all + non-tracked lots are skipped (scope guarantee).
  * Disabled emitter short-circuits.

Uses an in-memory sqlite DB seeded with the same schema the production
Pi sees (via ``init_db``) so the SQL filter logic is exercised against
real schema constraints.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.weight_sync_poller import (  # noqa: E402
    DEFAULT_MIN_DELTA_G,
    DEFAULT_TTL_S,
    WeightSyncPoller,
)
from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.storage import init_db  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class _ManualClock:
    """Deterministic monotonic clock for TTL tests."""

    def __init__(self, start: float = 0.0) -> None:
        self._t = float(start)

    def monotonic(self) -> float:
        return self._t

    def advance(self, seconds: float) -> None:
        self._t += float(seconds)


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


def _seed_product(conn: sqlite3.Connection, *, name: str = "Test") -> str:
    pid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO products (product_id, name, certified) VALUES (?, ?, 1)",
        (pid, name),
    )
    conn.commit()
    return pid


def _seed_lot(
    conn: sqlite3.Connection,
    *,
    product_id: str,
    shelf_id: str = "live_shelf",
    status: str = "on_shelf",
    current_weight_g: float = 200.0,
    in_flight_since: str = None,
    pickup_weight_g: float = None,
    pickup_event_id: str = None,
) -> str:
    lot_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO lots (
          lot_id, product_id, status, current_weight_g, shelf_id,
          in_flight_since, pickup_weight_g, pickup_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            lot_id,
            product_id,
            status,
            current_weight_g,
            shelf_id,
            in_flight_since,
            pickup_weight_g,
            pickup_event_id,
        ),
    )
    conn.commit()
    return lot_id


def _make_poller(
    conn: sqlite3.Connection,
    *,
    enabled: bool = True,
    interval_s: float = 30.0,
    min_delta_g: float = DEFAULT_MIN_DELTA_G,
    ttl_s: float = DEFAULT_TTL_S,
    clock=None,
    runtime_state_provider=None,
) -> tuple[WeightSyncPoller, MagicMock]:
    """Build a poller with a mock emitter. Returns (poller, mock_emitter)."""
    emitter = MagicMock()
    emitter.enabled = enabled
    emitter.emit_live_weight_sync = MagicMock(
        return_value="cev-" + uuid.uuid4().hex[:8] if enabled else None,
    )
    poller = WeightSyncPoller(
        emitter,
        conn,
        interval_s=interval_s,
        min_delta_g=min_delta_g,
        ttl_s=ttl_s,
        clock=clock,
        runtime_state_provider=runtime_state_provider,
    )
    return poller, emitter


# ---------------------------------------------------------------------------
# First-observation path
# ---------------------------------------------------------------------------


def test_first_observation_emits_for_live_shelf_lot(conn):
    """Fresh poller with no memory must emit on the first scan."""
    pid = _seed_product(conn, name="P1")
    lot_id = _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=160.4,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    emitter.emit_live_weight_sync.assert_called_once()
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == lot_id
    assert kwargs["kind"] == "live_shelf"
    assert kwargs["scale_id"] == "scale-01"
    # delta_g is repurposed for live_weight_sync as absolute weight.
    assert kwargs["observed_weight_g"] == pytest.approx(160.4)


def test_first_observation_emits_for_live_scale_lot_using_pairing_device_id(
    conn,
):
    """live_scale (single_item) lot uses scale_pairings.device_id as scale_id."""
    pid = _seed_product(conn, name="P2")
    lot_id = _seed_lot(
        conn, product_id=pid, shelf_id="single_item", current_weight_g=85.0,
    )
    # Seed a paired ESP for this lot.
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-pi-3", "single_item", pid, lot_id),
    )
    conn.commit()
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == lot_id
    assert kwargs["kind"] == "live_scale"
    assert kwargs["scale_id"] == "scale-pi-3"
    assert kwargs["observed_weight_g"] == pytest.approx(85.0)


def test_live_weight_sync_outbox_payload_carries_observed_weight_from_lot(conn):
    """End-to-end: lot.current_weight_g must land in outbox JSON as
    observed_weight_g for live_weight_sync rows."""
    pid = _seed_product(conn, name="P2-outbox")
    lot_id = _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=160.4355,
    )
    emitter = CloudEventEmitter(conn, enabled=True)
    poller = WeightSyncPoller(emitter, conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    row = conn.execute(
        "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    payload = json.loads(row["payload_json"])
    assert payload["event_kind"] == "live_weight_sync"
    assert payload["pi_lot_id"] == lot_id
    assert payload["observed_weight_g"] == pytest.approx(160.4355)
    # Backward-compat payload key for the existing /event validator.
    assert payload["delta_g"] == pytest.approx(160.4355)


# ---------------------------------------------------------------------------
# Significant-change gate
# ---------------------------------------------------------------------------


def test_subthreshold_drift_does_not_re_emit_within_ttl(conn):
    """A 2g drift (below 5g default) must NOT re-emit before TTL elapses."""
    pid = _seed_product(conn, name="P3")
    lot_id = _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=160.4,
    )
    clock = _ManualClock()
    poller, emitter = _make_poller(conn, clock=clock)

    # First tick: emit.
    poller.tick_once()
    assert emitter.emit_live_weight_sync.call_count == 1

    # Drift 2g (below the 5g threshold). Advance clock by 60s — well
    # under the 300s default TTL.
    conn.execute(
        "UPDATE lots SET current_weight_g = ? WHERE lot_id = ?",
        (158.4, lot_id),
    )
    conn.commit()
    clock.advance(60.0)

    poller.tick_once()
    # Still 1 — the sub-threshold drift was suppressed.
    assert emitter.emit_live_weight_sync.call_count == 1


def test_significant_change_triggers_re_emit(conn):
    """A 10g delta (above 5g default) must re-emit even within TTL."""
    pid = _seed_product(conn, name="P4")
    lot_id = _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=200.0,
    )
    clock = _ManualClock()
    poller, emitter = _make_poller(conn, clock=clock)

    poller.tick_once()
    # Drop 10g — well above the 5g threshold.
    conn.execute(
        "UPDATE lots SET current_weight_g = ? WHERE lot_id = ?",
        (190.0, lot_id),
    )
    conn.commit()
    clock.advance(5.0)

    poller.tick_once()
    assert emitter.emit_live_weight_sync.call_count == 2
    # Last call has the new weight.
    last_kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert last_kwargs["observed_weight_g"] == pytest.approx(190.0)


# ---------------------------------------------------------------------------
# TTL gate
# ---------------------------------------------------------------------------


def test_ttl_re_emits_stable_lot(conn):
    """A lot whose weight hasn't drifted past the threshold must still
    re-emit after the TTL elapses so the cloud's last_observed_at stays
    fresh."""
    pid = _seed_product(conn, name="P5")
    _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=300.0,
    )
    clock = _ManualClock()
    # Use a small TTL so the test stays deterministic.
    poller, emitter = _make_poller(conn, clock=clock, ttl_s=120.0)

    poller.tick_once()
    assert emitter.emit_live_weight_sync.call_count == 1

    # Same weight, advance clock past TTL.
    clock.advance(125.0)
    poller.tick_once()
    assert emitter.emit_live_weight_sync.call_count == 2

    # Same weight again, well within TTL of the last emit. Skip.
    clock.advance(30.0)
    poller.tick_once()
    assert emitter.emit_live_weight_sync.call_count == 2


# ---------------------------------------------------------------------------
# Scope filters
# ---------------------------------------------------------------------------


def test_catch_all_lots_are_skipped(conn):
    """Catch-all lots have their own delta-capture stream — never emit
    live_weight_sync for them."""
    pid = _seed_product(conn, name="P6")
    _seed_lot(
        conn, product_id=pid, shelf_id="catch_all", current_weight_g=400.0,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_out_status_lots_are_skipped(conn):
    """Lots with status='out' or 'depleted' are not on the scale, so
    streaming their cached weight is meaningless."""
    pid = _seed_product(conn, name="P7")
    _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", status="out",
        current_weight_g=0.0,
    )
    _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", status="depleted",
        current_weight_g=5.0,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_in_flight_lots_are_emitted(conn):
    """An in_flight lot (off the shelf, expected back) still has a
    cached weight that's worth syncing — the catch-all-style "lot is
    in flight but has been re-measured" flow needs the observation.

    Note: in_flight requires non-NULL pickup_event_id + pickup_weight_g
    + in_flight_since per the lots CHECK constraint added by
    IN_FLIGHT_TRACKER_PLAN.
    """
    pid = _seed_product(conn, name="P8")
    _seed_lot(
        conn,
        product_id=pid,
        shelf_id="live_shelf",
        status="in_flight",
        current_weight_g=180.0,
        in_flight_since="2026-04-29T03:30:00Z",
        pickup_weight_g=200.0,
        pickup_event_id="evt-1",
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1


def test_null_current_weight_lots_are_skipped(conn):
    """A lot with no recorded weight has nothing to observe."""
    pid = _seed_product(conn, name="P9")
    lot_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "shelf_id) VALUES (?, ?, ?, NULL, ?)",
        (lot_id, pid, "on_shelf", "live_shelf"),
    )
    conn.commit()
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0


# ---------------------------------------------------------------------------
# Emitter integration
# ---------------------------------------------------------------------------


def test_disabled_emitter_short_circuits(conn):
    """Tick must do nothing when emitter.enabled is False."""
    pid = _seed_product(conn, name="P10")
    _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=100.0,
    )
    poller, emitter = _make_poller(conn, enabled=False, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_emit_failure_does_not_update_memory(conn):
    """When emit returns None (outbox insert failed) the throttle memory
    must NOT be updated, so the next tick retries."""
    pid = _seed_product(conn, name="P11")
    _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=150.0,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())
    # First emit fails.
    emitter.emit_live_weight_sync.return_value = None

    n = poller.tick_once()
    assert n == 0  # didn't count the failure as a successful emit

    # Retry path: make the emitter succeed; same weight + same clock,
    # but memory wasn't recorded so we should still emit.
    emitter.emit_live_weight_sync.return_value = "cev-retry"
    n = poller.tick_once()
    assert n == 1
    assert emitter.emit_live_weight_sync.call_count == 2


def test_negative_weight_is_skipped(conn):
    """Negative readings are sensor glitches — skip rather than emit
    something the cloud's >= 0 check would reject anyway."""
    pid = _seed_product(conn, name="P12")
    _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf",
        current_weight_g=-5.0,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()
    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


# ---------------------------------------------------------------------------
# live_scale via scale_pairings + heartbeat runtime state
# ---------------------------------------------------------------------------
#
# These cover the production live_scale path that the original module
# missed: live_scale (single_item) lots are NEVER inserted into the Pi's
# `lots` table — the live_scale event handler in `handlers/scale_events.py`
# emits cloud consumption events directly without lifecycle. The poller
# therefore must read the lot↔device binding from `scale_pairings` and
# the current weight from the in-memory heartbeat state populated by
# `/api/scale-heartbeat`.


def test_live_scale_pairing_emits_using_runtime_weight(conn):
    """Live_scale lot present ONLY in scale_pairings (production path)
    must emit using the heartbeat state weight."""
    pid = _seed_product(conn, name="MILK")
    lot_id = str(uuid.uuid4())
    # Insert the lot row WITHOUT a `lots` entry — production behavior
    # for live_scale (the lot exists in cloud but not in Pi `lots`).
    # Foreign key in scale_pairings.lot_id → lots.lot_id requires a
    # row, so seed a placeholder `lots` row but DON'T set shelf_id to
    # 'single_item' (so the live_shelf branch won't pick it up). The
    # placeholder mimics the cloud_lots mirror that real Pi has.
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, 'on_shelf')",
        (lot_id, pid),
    )
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-milk-1", "single_item", pid, lot_id),
    )
    conn.commit()

    runtime = {"scale-milk-1": {"weight_g": 3200.5, "stable": True}}
    poller, emitter = _make_poller(
        conn,
        clock=_ManualClock(),
        runtime_state_provider=lambda: runtime,
    )

    n = poller.tick_once()

    assert n == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == lot_id
    assert kwargs["kind"] == "live_scale"
    assert kwargs["scale_id"] == "scale-milk-1"
    assert kwargs["observed_weight_g"] == pytest.approx(3200.5)


def test_live_scale_pairing_no_runtime_provider_skips(conn):
    """Without a runtime state provider, live_scale pairings are silently
    skipped (live_shelf-only fallback)."""
    pid = _seed_product(conn, name="OJ")
    lot_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, 'on_shelf')",
        (lot_id, pid),
    )
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-oj-1", "single_item", pid, lot_id),
    )
    conn.commit()
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_live_scale_pairing_no_heartbeat_for_device_skips(conn):
    """A pairing whose device hasn't heartbeated yet must be skipped
    (no current weight to emit; next tick will retry once heartbeat
    arrives)."""
    pid = _seed_product(conn, name="WATER")
    lot_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, 'on_shelf')",
        (lot_id, pid),
    )
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-water-1", "single_item", pid, lot_id),
    )
    conn.commit()
    # Provider returns empty — device hasn't heartbeated yet.
    poller, emitter = _make_poller(
        conn, clock=_ManualClock(), runtime_state_provider=lambda: {},
    )

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_live_scale_pairing_without_lot_id_skipped(conn):
    """A pairing with NULL lot_id (operator hasn't assigned a product
    yet) must be skipped — there's nothing to attribute weight to."""
    pid = _seed_product(conn, name="EMPTY")
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, NULL)",
        ("scale-empty-1", "single_item", pid),
    )
    conn.commit()
    runtime = {"scale-empty-1": {"weight_g": 100.0, "stable": True}}
    poller, emitter = _make_poller(
        conn,
        clock=_ManualClock(),
        runtime_state_provider=lambda: runtime,
    )

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_live_scale_pairing_significant_change_re_emits(conn):
    """Confirm the throttle gates work for the pairings-driven path:
    the heartbeat weight changing past the 5g threshold re-emits."""
    pid = _seed_product(conn, name="CEREAL")
    lot_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, 'on_shelf')",
        (lot_id, pid),
    )
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-cereal-1", "single_item", pid, lot_id),
    )
    conn.commit()

    runtime = {"scale-cereal-1": {"weight_g": 500.0, "stable": True}}
    poller, emitter = _make_poller(
        conn,
        clock=_ManualClock(),
        runtime_state_provider=lambda: runtime,
    )

    # First tick emits.
    assert poller.tick_once() == 1
    # 1g drift — sub-threshold — must NOT re-emit.
    runtime["scale-cereal-1"]["weight_g"] = 501.0
    assert poller.tick_once() == 0
    # 8g drop (user poured a serving) — must re-emit.
    runtime["scale-cereal-1"]["weight_g"] = 492.0
    assert poller.tick_once() == 1


def test_live_scale_provider_exception_does_not_kill_tick(conn):
    """If runtime_state_provider raises, the tick must absorb the error,
    log, and still emit live_shelf candidates."""
    # Seed a live_shelf candidate.
    pid_shelf = _seed_product(conn, name="SHELF1")
    _seed_lot(
        conn, product_id=pid_shelf, shelf_id="live_shelf",
        current_weight_g=200.0,
    )
    # Seed a live_scale candidate.
    pid_scale = _seed_product(conn, name="SCALE1")
    lot_id_scale = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status) VALUES (?, ?, 'on_shelf')",
        (lot_id_scale, pid_scale),
    )
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-broken-1", "single_item", pid_scale, lot_id_scale),
    )
    conn.commit()

    def boom():
        raise RuntimeError("provider unavailable")

    poller, emitter = _make_poller(
        conn, clock=_ManualClock(), runtime_state_provider=boom,
    )

    n = poller.tick_once()

    # Live_shelf still emits; live_scale skipped due to provider failure.
    assert n == 1
    kwargs_list = [
        c.kwargs for c in emitter.emit_live_weight_sync.call_args_list
    ]
    assert all(k["kind"] == "live_shelf" for k in kwargs_list)


def test_live_scale_pairing_dedup_when_lots_row_present(conn):
    """If a lot has both a `lots` row AND a `scale_pairings` row (legacy
    test seeding overlap), the pairings branch must dedup against the
    `lots` branch so we emit only once."""
    pid = _seed_product(conn, name="DUP")
    lot_id = _seed_lot(
        conn, product_id=pid, shelf_id="single_item", current_weight_g=85.0,
    )
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-dup-1", "single_item", pid, lot_id),
    )
    conn.commit()
    runtime = {"scale-dup-1": {"weight_g": 999.0, "stable": True}}
    poller, emitter = _make_poller(
        conn,
        clock=_ManualClock(),
        runtime_state_provider=lambda: runtime,
    )

    n = poller.tick_once()

    # Exactly ONE emit — the lots-row reading (85g) wins; the pairing
    # entry is deduped out so we don't emit 999g for the same lot too.
    assert n == 1
    assert emitter.emit_live_weight_sync.call_count == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["observed_weight_g"] == pytest.approx(85.0)
