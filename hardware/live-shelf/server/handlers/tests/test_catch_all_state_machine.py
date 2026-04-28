"""Catch-all delta-capture state machine — Pi dispatch tests.

Validates ``ScaleHandler._dispatch_catch_all_add`` (CATCH_ALL_SCALE_PLAN.md
§"Final confirmed model", 2026-04-27). Three runtime branches:

  1. FIRST event — picked lot is NOT in-flight on catch-all → emits
     ``catch_all_first_measurement`` with this Pi event_id stamped as
     ``pi_event_id``.
  2. SECOND event — picked lot IS in-flight on catch-all → emits
     ``catch_all_second_measurement`` with the lot's existing
     ``pickup_event_id`` as the cloud's lookup key.
  3. EMPTY-BOTTLE short-circuit (preserves commit abbd518) — measured
     weight ≈ tare ± 5% of (tare+net) AND lot is NOT in-flight on
     catch-all → emits ``discarded`` directly.

Plus a regression: empty bottle WITH active session = SECOND event,
NOT discard.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import DEFAULT_REGISTRY  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(tmp_path: Path):
    conn = init_db(str(tmp_path / "pi.sqlite3"))
    cloud_emitter = MagicMock()
    cloud_emitter.emit_catch_all_first_measurement = MagicMock(
        return_value="cli-1"
    )
    cloud_emitter.emit_catch_all_second_measurement = MagicMock(
        return_value="cli-2"
    )
    cloud_emitter.emit_manual_discard = MagicMock(return_value="cli-d")
    handler = ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=tmp_path / "events",
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=dict(DEFAULT_REGISTRY),
        cloud_emitter=cloud_emitter,
    )
    return handler, conn, cloud_emitter


def _seed_product(conn, *, product_id="prod-1", net=500.0, tare=25.0):
    storage_repo.create_product(
        conn,
        ProductIn(
            barcode="HRN-1",
            name="Test Item",
            net_weight_g=net,
            gross_weight_g=net + tare,
            tare_weight_g=tare,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    with conn:
        conn.execute(
            "UPDATE products SET product_id = ? WHERE barcode = ?",
            (product_id, "HRN-1"),
        )


def _seed_cloud_lot(conn, *, lot_id, product_id, qty=0.5,
                    in_flight_kind=None, pickup_event_id=None,
                    created_at="2026-04-27T00:00:00Z"):
    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers,
                in_flight_kind, pickup_event_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lot_id, product_id, qty,
                in_flight_kind, pickup_event_id,
                created_at, "2026-04-27T00:00:00Z",
            ),
        )


# ----------------------------------------------------------------------
# Branch 4 (FIRST event)
# ----------------------------------------------------------------------


def test_first_event_emits_first_measurement(tmp_path):
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-FRESH", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-FRESH"},
        delta_g=350.0,
        event_ts="2026-04-28T10:00:00.000Z",
        event_id="evt-first-1",
        session_id="sess-1",
    )
    assert handled is True
    emitter.emit_catch_all_first_measurement.assert_called_once()
    kwargs = emitter.emit_catch_all_first_measurement.call_args.kwargs
    assert kwargs["product_id"] == "prod-1"
    assert kwargs["measured_weight_g"] == 350.0
    assert kwargs["pi_event_id"] == "evt-first-1"
    assert kwargs["scale_id"] == "scale-02"
    emitter.emit_catch_all_second_measurement.assert_not_called()
    emitter.emit_manual_discard.assert_not_called()


# ----------------------------------------------------------------------
# Branch 2 (SECOND event)
# ----------------------------------------------------------------------


def test_second_event_emits_second_measurement_when_in_flight(tmp_path):
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(
        conn, lot_id="LOT-MID", product_id="prod-1",
        in_flight_kind="catch_all",
        pickup_event_id="first-event-uuid-stamp",
    )

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-MID"},
        delta_g=250.0,
        event_ts="2026-04-28T10:05:00.000Z",
        event_id="evt-second-1",
        session_id="sess-2",
    )
    assert handled is True
    emitter.emit_catch_all_second_measurement.assert_called_once()
    kwargs = emitter.emit_catch_all_second_measurement.call_args.kwargs
    assert kwargs["product_id"] == "prod-1"
    assert kwargs["measured_weight_g"] == 250.0
    # First-event ref is the EXISTING pickup_event_id, NOT this event's id.
    assert kwargs["first_event_pi_event_id"] == "first-event-uuid-stamp"
    emitter.emit_catch_all_first_measurement.assert_not_called()
    emitter.emit_manual_discard.assert_not_called()


# ----------------------------------------------------------------------
# Branch 3 (EMPTY-BOTTLE short-circuit)
# ----------------------------------------------------------------------


def test_empty_bottle_no_session_emits_discard(tmp_path):
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn, net=500.0, tare=25.0)
    _seed_cloud_lot(conn, lot_id="LOT-EMPTY", product_id="prod-1")

    # Tare ± 5% of (tare+net) = 25 ± 26.25g, so a 30g empty placement
    # is well inside the empty-bottle window.
    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-EMPTY"},
        delta_g=30.0,
        event_ts="2026-04-28T10:10:00.000Z",
        event_id="evt-empty-1",
        session_id="sess-3",
    )
    assert handled is True
    emitter.emit_manual_discard.assert_called_once()
    kwargs = emitter.emit_manual_discard.call_args.kwargs
    assert kwargs["kind"] == "catch_all"
    assert kwargs["product_id"] == "prod-1"
    assert kwargs["scale_id"] == "scale-02"
    emitter.emit_catch_all_first_measurement.assert_not_called()
    emitter.emit_catch_all_second_measurement.assert_not_called()


def test_empty_bottle_with_active_session_emits_second_measurement(tmp_path):
    """Regression: empty bottle WITH active in-flight session is the
    SECOND event of a delta-capture cycle (full consumption), NOT a
    discard. The full-consumption food_logs row is written cloud-side
    by the second-measurement apply branch.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn, net=500.0, tare=25.0)
    _seed_cloud_lot(
        conn, lot_id="LOT-DRINKING", product_id="prod-1",
        in_flight_kind="catch_all",
        pickup_event_id="full-bottle-event-uuid",
    )

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-DRINKING"},
        delta_g=30.0,  # would qualify for empty-bottle window in isolation
        event_ts="2026-04-28T10:15:00.000Z",
        event_id="evt-drained-1",
        session_id="sess-4",
    )
    assert handled is True
    emitter.emit_catch_all_second_measurement.assert_called_once()
    kwargs = emitter.emit_catch_all_second_measurement.call_args.kwargs
    assert kwargs["measured_weight_g"] == 30.0
    assert kwargs["first_event_pi_event_id"] == "full-bottle-event-uuid"
    emitter.emit_manual_discard.assert_not_called()


# ----------------------------------------------------------------------
# UNKNOWN + edge cases
# ----------------------------------------------------------------------


def test_unknown_falls_through_to_legacy_path(tmp_path):
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-X", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "UNKNOWN"},
        delta_g=300.0,
        event_ts="2026-04-28T10:20:00.000Z",
        event_id="evt-unknown",
        session_id=None,
    )
    assert handled is False
    emitter.emit_catch_all_first_measurement.assert_not_called()
    emitter.emit_catch_all_second_measurement.assert_not_called()
    emitter.emit_manual_discard.assert_not_called()


def test_missing_cloud_lot_falls_through(tmp_path):
    """Hallucinated id (not in cloud_lots) → fall through to legacy
    path so the existing review-queue logic surfaces the failure
    rather than silently discarding the event.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    # Don't seed cloud_lots — handler should bail.

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-PHANTOM"},
        delta_g=300.0,
        event_ts="2026-04-28T10:25:00.000Z",
        event_id="evt-phantom",
        session_id=None,
    )
    assert handled is False
    emitter.emit_catch_all_first_measurement.assert_not_called()


def test_non_positive_weight_falls_through(tmp_path):
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-Z", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-Z"},
        delta_g=0.0,
        event_ts="2026-04-28T10:30:00.000Z",
        event_id="evt-zero",
        session_id=None,
    )
    assert handled is False
    emitter.emit_catch_all_first_measurement.assert_not_called()


def test_in_flight_without_pickup_event_id_falls_through(tmp_path):
    """Defensive: in_flight_kind=catch_all but pickup_event_id NULL
    means the cloud has data corruption — the second-event lookup
    would fail anyway. Falling through lets the legacy review path
    surface it instead of silently emitting nonsense.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(
        conn, lot_id="LOT-CORRUPT", product_id="prod-1",
        in_flight_kind="catch_all",
        pickup_event_id=None,
    )

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-CORRUPT"},
        delta_g=200.0,
        event_ts="2026-04-28T10:35:00.000Z",
        event_id="evt-corrupt",
        session_id=None,
    )
    assert handled is False
    emitter.emit_catch_all_second_measurement.assert_not_called()
