"""Apply-path tests for in-flight REMOVE / ADD branches
(IN_FLIGHT_TRACKER_PLAN.md §4 + §6).
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


class _NullCandidateSource:
    def get_on_shelf_lots(self):
        return []

    def get_recently_out_lots(self, window_seconds):
        return []

    def get_in_flight_lots(self, max_age_seconds=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(
    conn: sqlite3.Connection, tmp_path: Path, **kwargs
) -> ScaleHandler:
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    defaults = dict(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
    )
    defaults.update(kwargs)
    return ScaleHandler(**defaults)


_BC = [0]


def _setup_lot(conn, weight_g=200.0):
    _BC[0] += 1
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name=f"Item {_BC[0]}", barcode=f"B-{_BC[0]}",
            net_weight_g=weight_g, gross_weight_g=weight_g,
            unit_type="solid", container_type="tub", certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=weight_g, initial_weight_g=weight_g),
    )
    return product, lot


def _open_session(conn):
    return storage_repo.open_session(
        conn, "2026-04-17T12:00:00.000Z", initial_weight_g=200.0
    ).session_id


def _record_remove(conn, session_id, *, delta_g, ts="2026-04-17T12:00:05.500Z"):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=0.0, after_weight_g=0.0,
            direction="remove", session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


def _record_add(conn, session_id, *, delta_g, ts="2026-04-17T12:05:00.000Z"):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=0.0, after_weight_g=0.0,
            direction="add", session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


def _resolutions_for(conn, session_id):
    return [
        dict(row) for row in conn.execute(
            "SELECT * FROM session_resolutions WHERE session_id=? ORDER BY created_at",
            (session_id,),
        )
    ]


# ---------------------------------------------------------------------------
# REMOVE → in_flight (§4.1)
# ---------------------------------------------------------------------------


class TestRemoveMarksInFlight:
    def test_remove_writes_in_flight_pickup_resolution(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _setup_lot(conn, weight_g=250.0)
        session_id = _open_session(conn)
        event_id = _record_remove(conn, session_id, delta_g=-250.0)

        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={
                "item_id": lot.lot_id, "action": "removed",
                "confidence": 0.95, "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-17T12:00:05.500Z",
            delta_g=-250.0,
            session_id=session_id,
            event_id=event_id,
        )

        resolutions = _resolutions_for(conn, session_id)
        assert len(resolutions) == 1
        assert resolutions[0]["pattern"] == "in_flight_pickup"
        assert resolutions[0]["lot_id"] == lot.lot_id
        assert resolutions[0]["remove_event_id"] == event_id
        assert resolutions[0]["consumed_g"] is None


# ---------------------------------------------------------------------------
# ADD → in_flight return / replacement (§4.2, §4.3, §4.7)
# ---------------------------------------------------------------------------


class TestAddAgainstInFlight:
    def test_return_lighter_records_consumption(self, tmp_path):
        """Pickup 200g, return 180g → consumption 20g, lot flips back to on_shelf."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _setup_lot(conn, weight_g=200.0)
        session_id = _open_session(conn)
        event_remove = _record_remove(conn, session_id, delta_g=-200.0)

        # Stage in_flight via the real apply path.
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={
                "item_id": lot.lot_id, "action": "removed",
                "confidence": 0.95, "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-17T12:00:05.000Z",
            delta_g=-200.0,
            session_id=session_id,
            event_id=event_remove,
        )
        assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"

        # Return with lower weight.
        event_add = _record_add(conn, session_id, delta_g=180.0,
                                ts="2026-04-17T12:05:00.000Z")
        handler._apply_lot_update_from_classification(
            direction="add",
            classification={
                "item_id": lot.lot_id, "action": "added",
                "confidence": 0.93, "multi_match": [],
                "candidate_pool_used": [{"candidate_id": lot.lot_id}],
            },
            event_ts="2026-04-17T12:05:00.000Z",
            delta_g=180.0,
            session_id=session_id,
            event_id=event_add,
        )

        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf"
        assert lot_now.current_weight_g == 180.0
        assert lot_now.total_consumed_g == 20.0
        assert lot_now.in_flight_since is None
        assert lot_now.pickup_weight_g is None

        # Session_resolutions now has pickup + return rows.
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_pickup" in patterns
        assert "in_flight_return" in patterns
        return_row = next(r for r in resolutions if r["pattern"] == "in_flight_return")
        assert return_row["consumed_g"] == 20.0
        assert return_row["add_event_id"] == event_add

    def test_return_tiny_consumption_below_noise_floor_clamps_to_zero(self, tmp_path):
        """Pickup 200g, return 199g → consumption 1g, below 2g floor → 0."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _setup_lot(conn, weight_g=200.0)
        session_id = _open_session(conn)

        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={"item_id": lot.lot_id, "action": "removed",
                            "confidence": 0.95, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:00:05.000Z",
            delta_g=-200.0, session_id=session_id,
            event_id=_record_remove(conn, session_id, delta_g=-200.0),
        )

        handler._apply_lot_update_from_classification(
            direction="add",
            classification={"item_id": lot.lot_id, "action": "added",
                            "confidence": 0.90, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:05:00.000Z",
            delta_g=199.0, session_id=session_id,
            event_id=_record_add(conn, session_id, delta_g=199.0),
        )

        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf"
        # Noise-floor clamp → 0 consumption.
        assert lot_now.total_consumed_g == 0.0
        # current_weight_g still reflects the return delta.
        assert lot_now.current_weight_g == 199.0

    def test_return_heavier_within_ratio_is_topup_negative_consumption(self, tmp_path):
        """Pickup 200g, return 210g (ratio 1.05, under 1.15) → topup.
        total_consumed_g stays at 0 (negative consumption clamped).
        Per §4.9, when action='added_to_existing' the resolution pattern
        is ``topped_up`` (not ``in_flight_return``)."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _setup_lot(conn, weight_g=200.0)
        session_id = _open_session(conn)

        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={"item_id": lot.lot_id, "action": "removed",
                            "confidence": 0.95, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:00:00.000Z",
            delta_g=-200.0, session_id=session_id,
            event_id=_record_remove(conn, session_id, delta_g=-200.0),
        )

        handler._apply_lot_update_from_classification(
            direction="add",
            classification={"item_id": lot.lot_id, "action": "added_to_existing",
                            "confidence": 0.85, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:05:00.000Z",
            delta_g=210.0, session_id=session_id,
            event_id=_record_add(conn, session_id, delta_g=210.0),
        )

        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.status == "on_shelf"
        assert lot_now.total_consumed_g == 0.0
        assert lot_now.current_weight_g == 210.0

        # §4.9: action='added_to_existing' writes pattern='topped_up'
        # (not in_flight_return) so the reconciler sees a proper topup.
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_pickup" in patterns
        assert "topped_up" in patterns
        assert "in_flight_return" not in patterns

    def test_return_heavier_within_ratio_plain_return_keeps_in_flight_return_pattern(
        self, tmp_path
    ):
        """When action is NOT 'added_to_existing' (e.g. 'added' or missing),
        the return branch keeps pattern='in_flight_return'."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _setup_lot(conn, weight_g=200.0)
        session_id = _open_session(conn)

        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={"item_id": lot.lot_id, "action": "removed",
                            "confidence": 0.95, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:00:00.000Z",
            delta_g=-200.0, session_id=session_id,
            event_id=_record_remove(conn, session_id, delta_g=-200.0),
        )

        handler._apply_lot_update_from_classification(
            direction="add",
            classification={"item_id": lot.lot_id, "action": "added",  # NOT added_to_existing
                            "confidence": 0.85, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:05:00.000Z",
            delta_g=210.0, session_id=session_id,
            event_id=_record_add(conn, session_id, delta_g=210.0),
        )

        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_return" in patterns
        assert "topped_up" not in patterns

    def test_return_much_heavier_beyond_ratio_is_replacement(self, tmp_path):
        """Pickup 200g, return 450g (ratio 2.25, way beyond 1.15) →
        replacement. Old lot closes as out; new lot minted."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)

        # Need a catalog product for the minting path.
        product = storage_repo.create_product(
            conn,
            ProductIn(name="Heavy", barcode="HVY",
                      net_weight_g=450.0, gross_weight_g=450.0,
                      unit_type="solid", container_type="bowl", certified=1),
        )

        # Seed the in-flight lot.
        _, lot = _setup_lot(conn, weight_g=200.0)
        session_id = _open_session(conn)
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={"item_id": lot.lot_id, "action": "removed",
                            "confidence": 0.95, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:00:00.000Z",
            delta_g=-200.0, session_id=session_id,
            event_id=_record_remove(conn, session_id, delta_g=-200.0),
        )

        # ADD targets the in-flight lot but the delta is WAY heavier. The
        # apply path should close the old lot and fall through to the
        # mint-new-lot path using the heavy catalog product.
        handler._apply_lot_update_from_classification(
            direction="add",
            classification={
                "item_id": lot.lot_id,  # classifier picked the in-flight slot
                "action": "added",
                "confidence": 0.90,
                "multi_match": [],
                "candidate_pool_used": [
                    {"candidate_id": lot.lot_id,
                     "product_id": lot.product_id},
                    {"candidate_id": product.product_id,
                     "why_candidate": "catalog_not_on_shelf",
                     "product_id": product.product_id},
                ],
            },
            event_ts="2026-04-17T12:05:00.000Z",
            delta_g=450.0, session_id=session_id,
            event_id=_record_add(conn, session_id, delta_g=450.0),
        )

        old_lot = storage_repo.get_lot(conn, lot.lot_id)
        assert old_lot.status == "out"
        assert old_lot.last_out_at == "2026-04-17T12:05:00.000Z"
        assert old_lot.in_flight_since is None
        # Consumption accounting — the 200g pickup of the replaced item
        # is now in the lot's lifetime total.
        assert old_lot.total_consumed_g == 200.0

        # Resolution log: pickup + replaced_new_item.
        resolutions = _resolutions_for(conn, session_id)
        patterns = [r["pattern"] for r in resolutions]
        assert "in_flight_pickup" in patterns
        assert "in_flight_replaced_new_item" in patterns

    def test_duplicate_remove_against_in_flight_lot_is_skipped(self, tmp_path):
        """If a second REMOVE classifies to the same lot_id that's already
        in_flight, the apply path logs and skips — the first pickup is
        authoritative."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _setup_lot(conn, weight_g=200.0)
        session_id = _open_session(conn)

        e1 = _record_remove(conn, session_id, delta_g=-200.0,
                            ts="2026-04-17T12:00:00.000Z")
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={"item_id": lot.lot_id, "action": "removed",
                            "confidence": 0.95, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:00:00.000Z",
            delta_g=-200.0, session_id=session_id, event_id=e1,
        )
        first_in_flight_since = storage_repo.get_lot(conn, lot.lot_id).in_flight_since

        e2 = _record_remove(conn, session_id, delta_g=-50.0,
                            ts="2026-04-17T12:00:30.000Z")
        handler._apply_lot_update_from_classification(
            direction="remove",
            classification={"item_id": lot.lot_id, "action": "removed",
                            "confidence": 0.70, "multi_match": [],
                            "candidate_pool_used": [{"candidate_id": lot.lot_id}]},
            event_ts="2026-04-17T12:00:30.000Z",
            delta_g=-50.0, session_id=session_id, event_id=e2,
        )

        # First pickup authority preserved.
        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now.in_flight_since == first_in_flight_since
        assert lot_now.pickup_event_id == e1
