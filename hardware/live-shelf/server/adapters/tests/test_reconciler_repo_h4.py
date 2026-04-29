"""H4 same-session in-flight TTL reaper — adapter integration tests.

Pass-4a of the reconciler closes the inter-tick race between session
close+reconcile and the next 5s sweeper tick. Lots whose
``pickup_session_id == session_id`` AND in-flight age > TTL are
reaped synchronously inside the reconciler instead of waiting up to 5s
for the global sweeper.

These tests exercise the real adapter against an in-memory SQLite DB
so we cover:
  * the storage-side flip (status, total_consumed_g, in_flight columns)
  * the ``in_flight_ttl_expired`` resolution write
  * the cloud emit chain (consumed event from write_resolution +
    in_flight_return_marker companion to clear stock_lots.in_flight_since)
  * scoping by session_id (cross-session lots stay the global
    sweeper's job)
  * the race guard when a concurrent ADD already returned the lot
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Any, List, Optional

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.reconciler_repo import RepoReconcilerAdapter  # noqa: E402
from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


class _CapturingEmitter(CloudEventEmitter):
    """Real emitter subclass that records each emit call's kwargs.

    Bypasses the outbox insert by overriding ``_enqueue`` so tests don't
    need the cloud_outbox schema. ``enabled=True`` so the production
    short-circuit at the top of ``_emit_cloud_for_resolution`` doesn't
    fire.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        super().__init__(conn, enabled=True)
        self.calls: List[dict] = []

    def _enqueue(self, payload: dict):  # type: ignore[override]
        self.calls.append(dict(payload))
        return f"stub-event-{len(self.calls)}"


@pytest.fixture
def conn() -> sqlite3.Connection:
    return init_db(":memory:")


def _ensure_session(conn: sqlite3.Connection, session_id: str) -> None:
    """Insert a sessions row with a known id — session_resolutions FK
    on sessions(session_id), and scale_events FK on sessions too.
    Sets ``ended_at`` so the ``sessions_one_open_per_shelf`` partial
    unique index doesn't reject a second open session on the same
    shelf (we're seeding closed sessions for the reconciler to act on).
    Uses INSERT OR IGNORE so the helper is idempotent across multiple
    seed calls in one test.
    """
    conn.execute(
        """
        INSERT OR IGNORE INTO sessions (
            session_id, started_at, ended_at, initial_shelf_weight_g, shelf_id
        ) VALUES (?, ?, ?, ?, 'live_shelf')
        """,
        (
            session_id,
            "2026-04-19T12:00:00.000Z",
            "2026-04-19T12:01:00.000Z",
            1000.0,
        ),
    )
    conn.commit()


def _seed_in_flight_lot(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    barcode: str = "BC-1",
    pickup_weight_g: float = 200.0,
    pickup_event_suffix: str = "1",
    age_seconds: int = 3600,
) -> dict[str, Any]:
    """Seed a product + a real scale_events row + an in_flight lot
    whose age > ``age_seconds``.

    Uses ``datetime('now', '-N seconds')`` for ``in_flight_since`` so
    the ``julianday('now') - julianday(in_flight_since)`` filter sees
    the lot as already expired even with TTL=1s. Returns a dict with
    the lot_id, product_id, and pickup_event_id (FK target).
    """
    _ensure_session(conn, session_id)
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name=f"Test {barcode}", barcode=barcode,
            net_weight_g=pickup_weight_g, gross_weight_g=pickup_weight_g,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id, status="on_shelf",
            current_weight_g=pickup_weight_g,
            initial_weight_g=pickup_weight_g,
        ),
    )
    # Real scale_events row so the resolution's remove_event_id FK holds.
    pickup_ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts="2026-04-19T12:00:05.000Z",
            delta_g=-pickup_weight_g,
            before_weight_g=1000.0,
            after_weight_g=1000.0 - pickup_weight_g,
            direction="remove",
            session_id=session_id,
            classifier_status="classified",
        ),
    )
    conn.execute(
        f"""
        UPDATE lots SET status='in_flight',
               in_flight_since = datetime('now', '-{int(age_seconds)} seconds'),
               pickup_weight_g = ?,
               pickup_event_id = ?,
               pickup_session_id = ?
         WHERE lot_id = ?
        """,
        (pickup_weight_g, pickup_ev.event_id, session_id, lot.lot_id),
    )
    conn.commit()
    return {
        "lot_id": lot.lot_id,
        "product_id": product.product_id,
        "pickup_event_id": pickup_ev.event_id,
    }


def test_h4_reaps_expired_in_flight_lot_in_session(conn):
    """Happy path — an expired in-flight lot in the target session is
    flipped to 'out', total_consumed_g bumped by pickup_weight_g, and
    a in_flight_ttl_expired resolution lands in session_resolutions.
    """
    seeded = _seed_in_flight_lot(conn, session_id="S1", pickup_weight_g=180.0)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, in_flight_ttl_seconds=1,
    )
    reaped = adapter.reap_expired_in_flight_for_session("S1")
    assert reaped == 1

    # Lot flipped to 'out' with consumption recorded.
    lot = storage_repo.get_lot(conn, seeded["lot_id"])
    assert lot is not None
    assert lot.status == "out"
    assert lot.total_consumed_g == pytest.approx(180.0)
    assert lot.in_flight_since is None
    assert lot.pickup_weight_g is None
    assert lot.pickup_event_id is None
    assert lot.pickup_session_id is None

    # Resolution row written.
    rows = storage_repo.list_resolutions_for_session(conn, "S1")
    patterns = [r.pattern for r in rows]
    assert "in_flight_ttl_expired" in patterns
    ttl_row = next(r for r in rows if r.pattern == "in_flight_ttl_expired")
    assert ttl_row.lot_id == seeded["lot_id"]
    assert ttl_row.consumed_g == pytest.approx(180.0)
    assert ttl_row.remove_event_id == seeded["pickup_event_id"]


def test_h4_emits_cloud_consumed_plus_in_flight_return_marker(conn):
    """Cloud mirror — the reaper emits BOTH the ``consumed`` event
    (from write_resolution → _emit_cloud_for_resolution) AND the
    ``in_flight_return`` marker (companion emit) so the cloud's
    stock_lots.in_flight_since gets cleared. Without the marker,
    cloud /chef/inventory would render the lot as in-flight forever
    (EMIT→HANDLE matrix fix 2026-04-27).
    """
    seeded = _seed_in_flight_lot(conn, session_id="S1", pickup_weight_g=120.0)
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None,
        cloud_emitter=emitter, in_flight_ttl_seconds=1,
    )
    reaped = adapter.reap_expired_in_flight_for_session("S1")
    assert reaped == 1

    # Two emits: consumed (from write_resolution) + in_flight_return_marker.
    kinds = [c.get("event_kind") for c in emitter.calls]
    assert kinds.count("consumed") == 1
    assert kinds.count("in_flight_return") == 1

    consumed = next(c for c in emitter.calls if c["event_kind"] == "consumed")
    assert consumed["product_id"] == seeded["product_id"]
    assert consumed["delta_g"] == pytest.approx(-120.0)
    # usage_kind on the consumed event tells the cloud's food_logs
    # writer this was a TTL reap (not a manual discard / use-return).
    assert consumed.get("usage_kind") == "in_flight_ttl_expired"

    marker = next(c for c in emitter.calls if c["event_kind"] == "in_flight_return")
    assert marker["product_id"] == seeded["product_id"]
    assert marker.get("pi_event_id") == seeded["pickup_event_id"]


def test_h4_skips_lot_from_other_session(conn):
    """Cross-session in-flight lots stay the global sweeper's job.
    The adapter MUST NOT touch a lot whose pickup_session_id differs
    from the session being reconciled — even when the lot's age
    exceeds TTL.
    """
    same_session = _seed_in_flight_lot(
        conn, session_id="S1", barcode="BC-A", pickup_weight_g=50.0,
    )
    other_session = _seed_in_flight_lot(
        conn, session_id="S-OTHER", barcode="BC-B", pickup_weight_g=75.0,
    )
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, in_flight_ttl_seconds=1,
    )
    reaped = adapter.reap_expired_in_flight_for_session("S1")
    assert reaped == 1

    same = storage_repo.get_lot(conn, same_session["lot_id"])
    assert same is not None and same.status == "out"
    other = storage_repo.get_lot(conn, other_session["lot_id"])
    # Other-session lot left alone — global sweeper will get it later.
    assert other is not None and other.status == "in_flight"
    assert other.pickup_session_id == "S-OTHER"


def test_h4_skips_lot_younger_than_ttl(conn):
    """A lot whose age is BELOW the TTL is NOT touched. The reaper
    only handles the same-session lots that already exceed TTL — the
    common case (user picked up + immediately reconciled) is left to
    the regular reconciler passes.
    """
    seeded = _seed_in_flight_lot(
        conn, session_id="S1", pickup_weight_g=99.0, age_seconds=10,
    )
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, in_flight_ttl_seconds=3600,  # 1h TTL, 10s age
    )
    reaped = adapter.reap_expired_in_flight_for_session("S1")
    assert reaped == 0

    lot = storage_repo.get_lot(conn, seeded["lot_id"])
    assert lot is not None and lot.status == "in_flight"


def test_h4_returns_zero_on_no_matching_lots(conn):
    """Empty session — the reaper returns 0 without raising and
    without writing a resolution row.
    """
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, in_flight_ttl_seconds=1,
    )
    reaped = adapter.reap_expired_in_flight_for_session("S-EMPTY")
    assert reaped == 0
    assert storage_repo.list_resolutions_for_session(conn, "S-EMPTY") == []


def test_h4_per_call_ttl_override(conn):
    """``ttl_seconds`` kwarg overrides the constructor default for one
    call. Lets tests drive expiry without sleeping; in production the
    config value flows through cfg.in_flight_ttl_seconds → constructor.
    """
    seeded = _seed_in_flight_lot(
        conn, session_id="S1", pickup_weight_g=10.0, age_seconds=300,
    )
    # Constructor TTL >> age (lot would be skipped) but override < age.
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None, in_flight_ttl_seconds=86400,
    )
    reaped = adapter.reap_expired_in_flight_for_session("S1", ttl_seconds=60)
    assert reaped == 1
    lot = storage_repo.get_lot(conn, seeded["lot_id"])
    assert lot is not None and lot.status == "out"


def test_h4_race_with_concurrent_return_skips_safely(conn, monkeypatch):
    """Race guard — if a concurrent ADD already flipped the lot back to
    on_shelf between list_expired_in_flight_lots_for_session and the
    UPDATE in reap_in_flight_lot_as_consumed, the helper returns a Lot
    whose status is NOT 'out'. The adapter must skip the rest of the
    per-lot side-effects (no resolution row, no cloud emit) so we
    don't double-book consumption against an item the user actually
    returned.

    Mirrors the C2 race guard on
    handlers.scale_events.ScaleHandler._reap_expired_in_flight.
    """
    seeded = _seed_in_flight_lot(conn, session_id="S1", pickup_weight_g=42.0)

    # Simulate the race by flipping the lot back to on_shelf AFTER
    # list_expired returns but BEFORE reap_in_flight_lot_as_consumed
    # runs. We monkeypatch the storage call to do the flip first.
    import server.storage.repo as _repo_module
    real_reap = _repo_module.reap_in_flight_lot_as_consumed

    def _racing_reap(_conn, lot_id, *, consumed_g, last_out_at):
        # Concurrent ADD: clear in_flight columns and put it back on shelf.
        # The race guard in reap_in_flight_lot_as_consumed's UPDATE
        # (``WHERE status='in_flight'``) means the real reap is a no-op,
        # then get_lot returns the on_shelf row.
        _conn.execute(
            "UPDATE lots SET status='on_shelf', "
            "in_flight_since=NULL, pickup_weight_g=NULL, "
            "pickup_event_id=NULL, pickup_session_id=NULL "
            "WHERE lot_id = ?",
            (lot_id,),
        )
        _conn.commit()
        return real_reap(
            _conn, lot_id, consumed_g=consumed_g, last_out_at=last_out_at,
        )

    monkeypatch.setattr(
        _repo_module, "reap_in_flight_lot_as_consumed", _racing_reap,
    )
    emitter = _CapturingEmitter(conn)
    adapter = RepoReconcilerAdapter(
        conn, db_lock=None,
        cloud_emitter=emitter, in_flight_ttl_seconds=1,
    )
    reaped = adapter.reap_expired_in_flight_for_session("S1")
    # Race detected: count stays 0, no resolution, no cloud emit.
    assert reaped == 0

    lot = storage_repo.get_lot(conn, seeded["lot_id"])
    assert lot is not None and lot.status == "on_shelf"

    rows = storage_repo.list_resolutions_for_session(conn, "S1")
    assert [r.pattern for r in rows if r.pattern == "in_flight_ttl_expired"] == []
    # Cloud emits would also be empty (no resolution → no consumed event;
    # no marker either since both are gated on the status flip).
    kinds = [c.get("event_kind") for c in emitter.calls]
    assert "consumed" not in kinds
    assert "in_flight_return" not in kinds
