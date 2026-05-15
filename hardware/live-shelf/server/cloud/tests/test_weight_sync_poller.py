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


def _seed_cloud_lot(
    conn: sqlite3.Connection,
    *,
    product_id: str,
    qty_containers: float = 1.0,
    deleted_at: str = None,
    created_at: str = "2026-04-29T00:00:00Z",
    updated_at: str = "2026-04-29T00:00:00Z",
    lot_id: str = None,
) -> str:
    """Seed a cloud_lots mirror row. Returns the cloud lot_id."""
    if lot_id is None:
        lot_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO cloud_lots (
          lot_id, product_id, qty_containers,
          deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (lot_id, product_id, qty_containers, deleted_at, created_at, updated_at),
    )
    conn.commit()
    return lot_id


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
    seed_cloud_mirror: bool = True,
    cloud_lot_id: str = None,
) -> str:
    """Seed a Pi-local `lots` row.

    When ``seed_cloud_mirror`` is True (default), ALSO seeds a
    cloud_lots row for the same product with a DIFFERENT lot_id. This
    matches production: the Pi-local UUID and the cloud UUID for the
    "same" physical lot are distinct UUID spaces (see
    weight_sync_poller bug fix 2026-04-29 — the poller must emit the
    cloud lot_id, not the Pi-local one). Tests that need the legacy
    collide-UUIDs shape can pass ``seed_cloud_mirror=False`` and seed
    cloud_lots manually.

    Returns the Pi-local lot_id (NOT the cloud lot_id — callers wanting
    that should use ``_seed_cloud_lot`` directly).
    """
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
    if seed_cloud_mirror:
        _seed_cloud_lot(
            conn,
            product_id=product_id,
            qty_containers=1.0,
            lot_id=cloud_lot_id,
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
    """Fresh poller with no memory must emit on the first scan, and
    the emitted pi_lot_id must be the CLOUD lot_id (resolved from
    cloud_lots), NOT the Pi-local lots.lot_id."""
    pid = _seed_product(conn, name="P1")
    pi_lot = _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=160.4,
    )
    cloud_lot_id = conn.execute(
        "SELECT lot_id FROM cloud_lots WHERE product_id = ?", (pid,)
    ).fetchone()["lot_id"]
    assert cloud_lot_id != pi_lot, "fixture must seed distinct UUIDs"
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    emitter.emit_live_weight_sync.assert_called_once()
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == cloud_lot_id
    assert kwargs["pi_lot_id"] != pi_lot
    assert kwargs["kind"] == "live_shelf"
    assert kwargs["scale_id"] == "scale-01"
    # delta_g is repurposed for live_weight_sync as absolute weight.
    assert kwargs["observed_weight_g"] == pytest.approx(160.4)


def test_first_observation_emits_for_live_scale_lot_using_pairing_device_id(
    conn,
):
    """live_scale (single_item) lot uses scale_pairings.device_id as scale_id.

    This is the legacy seeding path where a `lots` row with
    shelf_id='single_item' is present alongside scale_pairings; it flows
    through the live_shelf branch (which now resolves cloud_lot_id via
    cloud_lots JOIN). The pairing is rebound to the cloud_lot_id so
    the LEFT JOIN still produces the device_id.
    """
    pid = _seed_product(conn, name="P2")
    pi_lot = _seed_lot(
        conn, product_id=pid, shelf_id="single_item", current_weight_g=85.0,
    )
    cloud_lot_id = conn.execute(
        "SELECT lot_id FROM cloud_lots WHERE product_id = ?", (pid,)
    ).fetchone()["lot_id"]
    assert cloud_lot_id != pi_lot
    # Seed a paired ESP keyed by cloud_lot_id (post-FK-drop convention).
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-pi-3", "single_item", pid, cloud_lot_id),
    )
    conn.commit()
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == cloud_lot_id
    assert kwargs["kind"] == "live_scale"
    assert kwargs["scale_id"] == "scale-pi-3"
    assert kwargs["observed_weight_g"] == pytest.approx(85.0)


def test_live_weight_sync_outbox_payload_carries_observed_weight_from_lot(conn):
    """End-to-end: lot.current_weight_g must land in outbox JSON as
    observed_weight_g for live_weight_sync rows, and pi_lot_id must be
    the CLOUD lot_id."""
    pid = _seed_product(conn, name="P2-outbox")
    pi_lot = _seed_lot(
        conn, product_id=pid, shelf_id="live_shelf", current_weight_g=160.4355,
    )
    cloud_lot_id = conn.execute(
        "SELECT lot_id FROM cloud_lots WHERE product_id = ?", (pid,)
    ).fetchone()["lot_id"]
    assert cloud_lot_id != pi_lot
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
    assert payload["pi_lot_id"] == cloud_lot_id
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
    """If a lot has both a `lots` row AND a `scale_pairings` row keyed
    by the same cloud_lot_id, the pairings branch must dedup against the
    `lots` branch so we emit only once."""
    pid = _seed_product(conn, name="DUP")
    _seed_lot(
        conn, product_id=pid, shelf_id="single_item", current_weight_g=85.0,
    )
    cloud_lot_id = conn.execute(
        "SELECT lot_id FROM cloud_lots WHERE product_id = ?", (pid,)
    ).fetchone()["lot_id"]
    # Pairings.lot_id holds the cloud lot_id (FK to local lots was dropped).
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-dup-1", "single_item", pid, cloud_lot_id),
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
    assert kwargs["pi_lot_id"] == cloud_lot_id


# ---------------------------------------------------------------------------
# Production-shape regression tests (2026-04-29)
# ---------------------------------------------------------------------------
#
# Before this batch the live_shelf branch emitted ``lots.lot_id`` (Pi-local
# UUID space) as ``pi_lot_id``. Cloud's ``apply_live_weight_sync`` looks
# up ``stock_lots.lot_id`` directly with that value, but the cloud's UUID
# for the same physical lot is DIFFERENT from the Pi's — every emit
# returned ``applied=false reason='lot_id not found'`` and
# ``last_observed_weight_g`` never updated. Confirmed prod state:
#   Pi lots.lot_id      = 8923f32f-37f6-400b-ae07-e5fc25faee55
#   cloud stock_lots    = afc2ab94-e63d-4404-9f3c-39b4c6e347ae  (same product)
# The fix: JOIN cloud_lots on product_id, emit cloud_lots.lot_id.
#
# Old fixtures (above) used a single uuid for both the Pi `lots` row and
# any seeded `cloud_lots` row — they could not have caught this bug.
# These tests deliberately seed DISTINCT UUIDs.


def test_emits_cloud_lot_id_not_pi_local_lot_id_for_live_shelf(conn):
    """Production-shape regression: when Pi `lots` and `cloud_lots`
    have DIFFERENT UUIDs for the same physical lot, the poller MUST
    emit the cloud lot_id (so cloud's apply_live_weight_sync finds it).

    Bug reference: 2026-04-29 — emitting lots.lot_id caused every
    live_weight_sync to return applied=false 'lot_id not found' and
    last_observed_weight_g never updated in production.
    """
    pid = _seed_product(conn, name="CHICKEN")
    pi_local_lot_id = "8923f32f-37f6-400b-ae07-e5fc25faee55"
    cloud_lot_id = "afc2ab94-e63d-4404-9f3c-39b4c6e347ae"
    conn.execute(
        """
        INSERT INTO lots (
          lot_id, product_id, status, current_weight_g, shelf_id
        ) VALUES (?, ?, 'on_shelf', 1234.5, 'live_shelf')
        """,
        (pi_local_lot_id, pid),
    )
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=1.0, lot_id=cloud_lot_id,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == cloud_lot_id, (
        "poller must emit the cloud lot_id, not the Pi-local lots.lot_id"
    )
    assert kwargs["pi_lot_id"] != pi_local_lot_id
    assert kwargs["observed_weight_g"] == pytest.approx(1234.5)


def test_skips_emit_when_no_matching_cloud_lots_row(conn):
    """If no cloud_lots row exists for the product, the poller MUST
    skip the row entirely — emitting a Pi-local UUID is guaranteed to
    fail at the cloud's stock_lots lookup, so don't waste an outbox
    slot on a dead-letter."""
    pid = _seed_product(conn, name="ORPHAN")
    # Seed lots row but NO cloud_lots row for this product.
    _seed_lot(
        conn,
        product_id=pid,
        shelf_id="live_shelf",
        current_weight_g=200.0,
        seed_cloud_mirror=False,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()


def test_picks_freshest_cloud_lot_when_multiple_match(conn):
    """When several cloud_lots rows exist for the same product, the
    poller picks the one with highest qty_containers (and breaks ties
    by most recent created_at). Deleted rows are excluded entirely."""
    pid = _seed_product(conn, name="GATORADE")
    pi_local_lot_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO lots (
          lot_id, product_id, status, current_weight_g, shelf_id
        ) VALUES (?, ?, 'on_shelf', 600.0, 'live_shelf')
        """,
        (pi_local_lot_id, pid),
    )
    # Three cloud_lots for the same product:
    #   - "old": stale, fully consumed (qty=0).
    #   - "deleted": tombstoned, must be ignored.
    #   - "fresh": current live stock, must be picked.
    old_lot = "11111111-1111-1111-1111-111111111111"
    deleted_lot = "22222222-2222-2222-2222-222222222222"
    fresh_lot = "33333333-3333-3333-3333-333333333333"
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=0.0, lot_id=old_lot,
        created_at="2026-04-01T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=5.0, lot_id=deleted_lot,
        created_at="2026-04-25T00:00:00Z",
        deleted_at="2026-04-26T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=2.0, lot_id=fresh_lot,
        created_at="2026-04-28T00:00:00Z",
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == fresh_lot
    assert kwargs["pi_lot_id"] != old_lot
    assert kwargs["pi_lot_id"] != deleted_lot


def test_live_scale_branch_passes_through_scale_pairings_lot_id(conn):
    """live_scale regression: the scale_pairings branch must emit
    scale_pairings.lot_id directly (which is already the cloud
    stock_lots.lot_id — the FK to local lots(lot_id) was dropped in
    migration 20260429... specifically because of this).
    """
    pid = _seed_product(conn, name="MILK-PROD")
    cloud_lot_id = "44444444-4444-4444-4444-444444444444"
    # Production live_scale path: NO `lots` row, only scale_pairings.
    # The pairings.lot_id is the cloud lot_id (post-FK-drop).
    conn.execute(
        "INSERT INTO scale_pairings (device_id, shelf_id, product_id, lot_id) "
        "VALUES (?, ?, ?, ?)",
        ("scale-milk-prod", "single_item", pid, cloud_lot_id),
    )
    conn.commit()
    runtime = {"scale-milk-prod": {"weight_g": 1800.0, "stable": True}}
    poller, emitter = _make_poller(
        conn,
        clock=_ManualClock(),
        runtime_state_provider=lambda: runtime,
    )

    n = poller.tick_once()

    assert n == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == cloud_lot_id
    assert kwargs["kind"] == "live_scale"
    assert kwargs["scale_id"] == "scale-milk-prod"
    assert kwargs["observed_weight_g"] == pytest.approx(1800.0)


# ---------------------------------------------------------------------------
# G5 (MED, 2026-05-15) — ambiguous cloud_lots collapse
# ---------------------------------------------------------------------------
#
# Before G5: when a product has >1 active cloud_lots (e.g. two cartons of
# milk), the live_shelf branch's `LIMIT 1` inner subquery collapses every
# Pi `lots` row for that product onto the SAME cloud_lot_id. Throttle
# memory is keyed by cloud_lot_id, so only one of the two Pi weights
# actually streams; the other is dropped silently and
# `last_observed_weight_g` flaps unpredictably between cartons.
#
# Fix: detect products with >1 active cloud_lots (qty>0, not deleted) per
# tick, skip ALL Pi lots for those products, log a WARNING with the
# product_id + cloud_lots count + the Pi lot_ids that would have collapsed,
# and bump `last_tick_stats['skipped_ambiguous_count']` so /healthz can
# alarm. Option (a): conservative — never invent a fake "total weight"
# across distinct physical cartons.


def test_ambiguous_cloud_lots_skip_emission_and_log_and_count(conn, caplog):
    """Two cloud_lots for same product + 2 Pi lots with current_weight_g.
    Poller must emit nothing, log a WARNING naming the product + count +
    the Pi lot_ids that would have collapsed, and bump
    `skipped_ambiguous_count` by 1 (one product, not two lots).
    """
    pid = _seed_product(conn, name="MILK-AMBIG")
    # Two cloud_lots — same product, both active (qty>0).
    cloud_lot_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    cloud_lot_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=1.0, lot_id=cloud_lot_a,
        created_at="2026-05-01T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=1.0, lot_id=cloud_lot_b,
        created_at="2026-05-02T00:00:00Z",
    )
    # Two Pi lots — both observing weight on the live shelf.
    pi_lot_1 = "11111111-cafe-cafe-cafe-111111111111"
    pi_lot_2 = "22222222-cafe-cafe-cafe-222222222222"
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "shelf_id) VALUES (?, ?, 'on_shelf', 1800.0, 'live_shelf')",
        (pi_lot_1, pid),
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "shelf_id) VALUES (?, ?, 'on_shelf', 1750.0, 'live_shelf')",
        (pi_lot_2, pid),
    )
    conn.commit()
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    with caplog.at_level("WARNING", logger="server.cloud.weight_sync_poller"):
        n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()
    stats = poller.last_tick_stats
    # One PRODUCT was ambiguous — even though two Pi lots would have
    # collapsed, the operator's mental model is per-product.
    assert stats["skipped_ambiguous_count"] == 1, stats
    assert stats["emitted"] == 0
    # WARNING must surface the product + the collapse candidates so the
    # operator can act.
    warn_msgs = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelname == "WARNING"
    ]
    assert any(pid in m for m in warn_msgs), warn_msgs
    # Both Pi lot_ids must appear in the warning so operator sees what
    # would have collapsed.
    joined = " ".join(warn_msgs)
    assert pi_lot_1 in joined
    assert pi_lot_2 in joined
    # The count of cloud_lots must be surfaced too ("2 active cloud_lots").
    assert "2" in joined


def test_single_cloud_lot_still_emits_regression(conn):
    """Regression: the G5 fix must not break the happy path. One
    cloud_lot + one Pi lot → emit normally."""
    pid = _seed_product(conn, name="HAPPY-PATH")
    pi_lot_id = _seed_lot(
        conn,
        product_id=pid,
        shelf_id="live_shelf",
        current_weight_g=500.0,
    )
    cloud_lot_id = conn.execute(
        "SELECT lot_id FROM cloud_lots WHERE product_id = ?", (pid,),
    ).fetchone()["lot_id"]
    assert cloud_lot_id != pi_lot_id
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 1
    stats = poller.last_tick_stats
    assert stats["skipped_ambiguous_count"] == 0, stats
    assert stats["emitted"] == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == cloud_lot_id
    assert kwargs["observed_weight_g"] == pytest.approx(500.0)


def test_mixed_batch_unambiguous_product_still_emits(conn, caplog):
    """Product A (1 cloud_lot) + Product B (2 cloud_lots) in same tick.
    Must emit for A and skip+log for B."""
    pid_a = _seed_product(conn, name="A-OK")
    pid_b = _seed_product(conn, name="B-AMBIG")
    # Product A: one cloud_lot, one Pi lot.
    cloud_a = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001"
    pi_a = "11111111-1111-1111-1111-aaaaaaaa0001"
    _seed_cloud_lot(
        conn, product_id=pid_a, qty_containers=1.0, lot_id=cloud_a,
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "shelf_id) VALUES (?, ?, 'on_shelf', 240.0, 'live_shelf')",
        (pi_a, pid_a),
    )
    # Product B: two cloud_lots, two Pi lots (the bug case).
    cloud_b1 = "bbbbbbbb-bbbb-bbbb-bbbb-000000000001"
    cloud_b2 = "bbbbbbbb-bbbb-bbbb-bbbb-000000000002"
    pi_b1 = "22222222-2222-2222-2222-bbbbbbbb0001"
    pi_b2 = "22222222-2222-2222-2222-bbbbbbbb0002"
    _seed_cloud_lot(
        conn, product_id=pid_b, qty_containers=1.0, lot_id=cloud_b1,
        created_at="2026-05-01T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, product_id=pid_b, qty_containers=1.0, lot_id=cloud_b2,
        created_at="2026-05-02T00:00:00Z",
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "shelf_id) VALUES (?, ?, 'on_shelf', 1800.0, 'live_shelf')",
        (pi_b1, pid_b),
    )
    conn.execute(
        "INSERT INTO lots (lot_id, product_id, status, current_weight_g, "
        "shelf_id) VALUES (?, ?, 'on_shelf', 1700.0, 'live_shelf')",
        (pi_b2, pid_b),
    )
    conn.commit()
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    with caplog.at_level("WARNING", logger="server.cloud.weight_sync_poller"):
        n = poller.tick_once()

    # Exactly one emit — product A only.
    assert n == 1
    assert emitter.emit_live_weight_sync.call_count == 1
    kwargs = emitter.emit_live_weight_sync.call_args.kwargs
    assert kwargs["pi_lot_id"] == cloud_a, (
        "must emit for A's cloud_lot, not B's"
    )
    assert kwargs["observed_weight_g"] == pytest.approx(240.0)
    # Stats: one ambiguous product (B), one emit (A).
    stats = poller.last_tick_stats
    assert stats["skipped_ambiguous_count"] == 1, stats
    assert stats["emitted"] == 1
    # WARNING must name product B (not product A).
    warn_msgs = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelname == "WARNING"
    ]
    joined = " ".join(warn_msgs)
    assert pid_b in joined
    assert pid_a not in joined, (
        f"product A is unambiguous and must not appear in any WARNING: {warn_msgs}"
    )


def test_ambiguous_cloud_lots_with_no_active_pi_lot_does_not_emit(conn):
    """Edge case: product has 2 cloud_lots but no Pi `lots` row currently
    observing weight (or only rows excluded by the upstream JOIN — e.g.
    status='out'). Result: no emission attempted, no candidates to skip,
    skipped_ambiguous_count is still counted as 1 (the product IS
    ambiguous regardless of whether any Pi lot is currently observing).

    The point of this test is to confirm the SQL doesn't somehow conjure
    an emit when the upstream JOIN already excludes everything, AND that
    the ambiguous-skip path is harmless when there's nothing to skip.
    """
    pid = _seed_product(conn, name="NOBODY-HOME")
    # Two cloud_lots, both active.
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=1.0,
        lot_id="cccccccc-cccc-cccc-cccc-000000000001",
        created_at="2026-05-01T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, product_id=pid, qty_containers=1.0,
        lot_id="cccccccc-cccc-cccc-cccc-000000000002",
        created_at="2026-05-02T00:00:00Z",
    )
    # Pi lot exists but is 'out' — excluded by SQL.
    _seed_lot(
        conn,
        product_id=pid,
        shelf_id="live_shelf",
        status="out",
        current_weight_g=0.0,
        seed_cloud_mirror=False,
    )
    poller, emitter = _make_poller(conn, clock=_ManualClock())

    n = poller.tick_once()

    assert n == 0
    emitter.emit_live_weight_sync.assert_not_called()
    # Product is ambiguous even though no candidate would emit; the
    # ambiguity detector runs on cloud_lots irrespective of Pi state so
    # /healthz can still surface the operator-action condition.
    stats = poller.last_tick_stats
    assert stats["skipped_ambiguous_count"] == 1, stats
