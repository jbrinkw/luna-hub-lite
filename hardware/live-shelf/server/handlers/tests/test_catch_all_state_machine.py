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

import pytest  # noqa: E402

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


# ----------------------------------------------------------------------
# Codex finding HIGH-1 (2026-04-28): hallucination guard
# ----------------------------------------------------------------------


def test_hallucinated_item_id_does_not_emit_first_measurement(tmp_path):
    """Pre-fix: an out-of-pool ``item_id`` (model invention / drift)
    would route through the FIRST-measurement branch if the lot
    happened to exist in cloud_lots — corrupting random inventory.

    Mutation guard: removing the ``valid_pool_ids`` membership check at
    the top of ``_dispatch_catch_all_add`` lets the emit fire.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    # Both lots exist in cloud_lots, but only POOL-LOT was in the pool
    # we sent the classifier. The classifier "hallucinates" OTHER-LOT.
    _seed_cloud_lot(conn, lot_id="POOL-LOT", product_id="prod-1")
    _seed_cloud_lot(
        conn, lot_id="OTHER-LOT", product_id="prod-1", qty=0.4,
        created_at="2026-04-27T01:00:00Z",
    )

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "OTHER-LOT",  # hallucinated — not in pool below
            "candidate_pool_used": [
                {"candidate_id": "POOL-LOT", "lot_id": "POOL-LOT",
                 "why_candidate": "inventory_only"},
            ],
        },
        delta_g=350.0,
        event_ts="2026-04-28T11:00:00.000Z",
        event_id="evt-hallu",
        session_id=None,
    )
    assert handled is False
    emitter.emit_catch_all_first_measurement.assert_not_called()
    emitter.emit_catch_all_second_measurement.assert_not_called()
    emitter.emit_manual_discard.assert_not_called()


def test_hallucinated_item_id_blocks_second_measurement_too(tmp_path):
    """A hallucinated id whose lot HAPPENS to be in_flight_kind=catch_all
    on cloud_lots would otherwise emit a second measurement against the
    wrong lot. Guard fires before the in_flight check.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="POOL-LOT", product_id="prod-1")
    _seed_cloud_lot(
        conn, lot_id="HIJACKED", product_id="prod-1", qty=0.4,
        in_flight_kind="catch_all",
        pickup_event_id="prior-first-uuid",
    )

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "HIJACKED",
            "candidate_pool_used": [
                {"candidate_id": "POOL-LOT", "lot_id": "POOL-LOT"},
            ],
        },
        delta_g=200.0,
        event_ts="2026-04-28T11:05:00.000Z",
        event_id="evt-hallu-second",
        session_id=None,
    )
    assert handled is False
    emitter.emit_catch_all_second_measurement.assert_not_called()


def test_hallucinated_item_id_blocks_empty_bottle_discard(tmp_path):
    """A hallucinated id at empty-bottle weight would otherwise emit a
    discard against the wrong lot. Guard fires first.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn, net=500.0, tare=25.0)
    _seed_cloud_lot(conn, lot_id="POOL-LOT", product_id="prod-1")
    _seed_cloud_lot(
        conn, lot_id="HIJACKED", product_id="prod-1", qty=0.4,
        created_at="2026-04-27T01:00:00Z",
    )

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "HIJACKED",
            "candidate_pool_used": [
                {"candidate_id": "POOL-LOT", "lot_id": "POOL-LOT"},
            ],
        },
        delta_g=30.0,  # would be empty-bottle window if accepted
        event_ts="2026-04-28T11:10:00.000Z",
        event_id="evt-hallu-empty",
        session_id=None,
    )
    assert handled is False
    emitter.emit_manual_discard.assert_not_called()


def test_pool_with_only_lot_id_field_validates_picked_lot(tmp_path):
    """The catch-all pool entries carry the lot_id under both
    ``candidate_id`` AND ``lot_id``. The guard accepts EITHER field, so
    a pick that matches a pool entry's lot_id is valid even if the
    classifier reused candidate_id verbatim.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-ALPHA", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={
            "item_id": "LOT-ALPHA",
            "candidate_pool_used": [
                # lot_id field present, candidate_id matches
                {"candidate_id": "LOT-ALPHA", "lot_id": "LOT-ALPHA"},
            ],
        },
        delta_g=350.0,
        event_ts="2026-04-28T11:15:00.000Z",
        event_id="evt-pool-ok",
        session_id=None,
    )
    assert handled is True
    emitter.emit_catch_all_first_measurement.assert_called_once()


def test_empty_pool_does_not_invoke_guard(tmp_path):
    """Defensive: a classification missing ``candidate_pool_used``
    (legacy path / synthetic apply / sweeper) skips the guard. The
    guard is only "deny on mismatch with a non-empty pool" — if we
    can't validate, we proceed (the legacy lookup-then-fall-through
    semantics still apply).
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-FREE", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-FREE"},  # no candidate_pool_used
        delta_g=350.0,
        event_ts="2026-04-28T11:20:00.000Z",
        event_id="evt-no-pool",
        session_id=None,
    )
    assert handled is True
    emitter.emit_catch_all_first_measurement.assert_called_once()


# ----------------------------------------------------------------------
# Codex finding HIGH-2 (2026-04-28): fail-closed cloud emit
# ----------------------------------------------------------------------


def test_first_emit_failure_returns_false_for_sweeper_retry(tmp_path):
    """When the cloud emit returns ``None`` (the
    ``CloudEventEmitter._enqueue`` failure sentinel), the dispatch MUST
    return False so the event stays pending and the sweeper retries.
    Pre-fix the return value was ignored and the event was marked
    handled — silent drop, durable Pi↔cloud divergence.

    Mutation guard: removing the ``if not client_event_id: return False``
    check makes this test fail because the dispatch returns True and
    the cloud_lots write-through fires for an event the cloud never
    received.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    emitter.emit_catch_all_first_measurement = MagicMock(return_value=None)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-NULL", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-NULL"},
        delta_g=350.0,
        event_ts="2026-04-28T11:30:00.000Z",
        event_id="evt-null-emit",
        session_id=None,
    )
    assert handled is False, (
        "fail-closed: emit returning None must NOT mark the event handled"
    )
    # Write-through must NOT have fired — the cloud doesn't have the
    # first measurement, so locally pretending we do would corrupt the
    # next event's routing.
    row = conn.execute(
        "SELECT in_flight_kind FROM cloud_lots WHERE lot_id = ?",
        ("LOT-NULL",),
    ).fetchone()
    assert row[0] is None, (
        "fast-path mirror must NOT fire when the cloud emit failed"
    )


def test_first_emit_exception_returns_false_for_sweeper_retry(tmp_path):
    """An exception from the emit (e.g. SQLite locked, JSON serialization
    bug) is also fail-closed.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    emitter.emit_catch_all_first_measurement = MagicMock(
        side_effect=RuntimeError("simulated cloud outage")
    )
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-EXC", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-EXC"},
        delta_g=350.0,
        event_ts="2026-04-28T11:35:00.000Z",
        event_id="evt-exc-emit",
        session_id=None,
    )
    assert handled is False


def test_second_emit_failure_returns_false(tmp_path):
    """SECOND-measurement emit failure also fail-closed."""
    handler, conn, emitter = _make_handler(tmp_path)
    emitter.emit_catch_all_second_measurement = MagicMock(return_value=None)
    _seed_product(conn)
    _seed_cloud_lot(
        conn, lot_id="LOT-MID-FAIL", product_id="prod-1",
        in_flight_kind="catch_all",
        pickup_event_id="prior-first",
    )

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-MID-FAIL"},
        delta_g=200.0,
        event_ts="2026-04-28T11:40:00.000Z",
        event_id="evt-second-fail",
        session_id=None,
    )
    assert handled is False
    # Markers must NOT have been cleared locally — cloud still has them.
    row = conn.execute(
        "SELECT in_flight_kind FROM cloud_lots WHERE lot_id = ?",
        ("LOT-MID-FAIL",),
    ).fetchone()
    assert row[0] == "catch_all", (
        "fast-path mirror must NOT clear markers when SECOND emit failed"
    )


def test_empty_bottle_discard_failure_returns_false(tmp_path):
    """Pre-fix the empty-bottle branch SWALLOWED exceptions and still
    returned True, dropping the event silently. Now any emit failure
    (return None or exception) returns False.

    Mutation guard: restoring the pre-fix behavior (``return True``
    after the swallowed exception) makes this assertion fail.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    emitter.emit_manual_discard = MagicMock(return_value=None)
    _seed_product(conn, net=500.0, tare=25.0)
    _seed_cloud_lot(conn, lot_id="LOT-DISC-FAIL", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-DISC-FAIL"},
        delta_g=30.0,
        event_ts="2026-04-28T11:45:00.000Z",
        event_id="evt-disc-fail",
        session_id=None,
    )
    assert handled is False, (
        "empty-bottle discard must fail-closed when cloud emit returns None"
    )


def test_empty_bottle_discard_exception_returns_false(tmp_path):
    handler, conn, emitter = _make_handler(tmp_path)
    emitter.emit_manual_discard = MagicMock(
        side_effect=RuntimeError("simulated outage")
    )
    _seed_product(conn, net=500.0, tare=25.0)
    _seed_cloud_lot(conn, lot_id="LOT-DISC-EXC", product_id="prod-1")

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-DISC-EXC"},
        delta_g=30.0,
        event_ts="2026-04-28T11:50:00.000Z",
        event_id="evt-disc-exc",
        session_id=None,
    )
    assert handled is False


# ----------------------------------------------------------------------
# Codex finding HIGH-3 (2026-04-28): local fast-path marker
# ----------------------------------------------------------------------


def test_first_then_quick_second_routes_correctly_via_local_marker(tmp_path):
    """Pre-fix: the SECOND event read ``cloud_lots.in_flight_kind`` and
    saw NULL because the lot-snapshot poller hadn't synced yet (60s
    lag). It then re-routed as another FIRST measurement. Consumption
    accounting was lost.

    With the write-through fix the FIRST emit synchronously stamps
    ``in_flight_kind='catch_all'`` + ``pickup_event_id`` on the local
    cloud_lots row, so the immediately-following SECOND event sees
    the fresh state and routes correctly.

    Mutation guard: removing the
    ``_writethrough_stamp_catch_all_in_flight`` call after the FIRST
    emit makes the test fail because the SECOND event re-routes as
    another FIRST measurement.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(conn, lot_id="LOT-SEQ", product_id="prod-1")

    # First event
    handled1 = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-SEQ"},
        delta_g=350.0,
        event_ts="2026-04-28T12:00:00.000Z",
        event_id="evt-seq-first",
        session_id=None,
    )
    assert handled1 is True
    emitter.emit_catch_all_first_measurement.assert_called_once()
    emitter.emit_catch_all_second_measurement.assert_not_called()

    # Second event arrives BEFORE the lot-snapshot poller could have
    # synced. Without the local fast-path marker this would re-route as
    # a FIRST measurement (because cloud_lots.in_flight_kind would
    # still read NULL).
    handled2 = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-SEQ"},
        delta_g=180.0,
        event_ts="2026-04-28T12:00:30.000Z",
        event_id="evt-seq-second",
        session_id=None,
    )
    assert handled2 is True
    emitter.emit_catch_all_second_measurement.assert_called_once()
    second_kwargs = emitter.emit_catch_all_second_measurement.call_args.kwargs
    # First-event reference is the FIRST event's pi_event_id — proof
    # the local marker captured it correctly at FIRST-emit time.
    assert second_kwargs["first_event_pi_event_id"] == "evt-seq-first"
    # FIRST emit must still have only fired once (the second event did
    # NOT re-trigger another FIRST measurement).
    assert emitter.emit_catch_all_first_measurement.call_count == 1


def test_second_emit_clears_local_in_flight_marker(tmp_path):
    """After a successful SECOND emit the local cloud_lots row's
    in-flight markers must be cleared, so a third event for the same
    lot opens a NEW first-measurement cycle rather than incorrectly
    routing as another second.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn)
    _seed_cloud_lot(
        conn, lot_id="LOT-CYCLE", product_id="prod-1",
        in_flight_kind="catch_all",
        pickup_event_id="prior-first-uuid",
    )

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-CYCLE"},
        delta_g=180.0,
        event_ts="2026-04-28T12:05:00.000Z",
        event_id="evt-cycle-second",
        session_id=None,
    )
    assert handled is True

    row = conn.execute(
        "SELECT in_flight_kind, pickup_event_id, in_flight_since "
        "FROM cloud_lots WHERE lot_id = ?",
        ("LOT-CYCLE",),
    ).fetchone()
    assert row[0] is None, "in_flight_kind must be cleared post-SECOND"
    assert row[1] is None, "pickup_event_id must be cleared post-SECOND"
    assert row[2] is None, "in_flight_since must be cleared post-SECOND"


# ----------------------------------------------------------------------
# Codex finding MEDIUM-6 (2026-04-28): empty-bottle discard carries lot_id
# ----------------------------------------------------------------------


def test_empty_bottle_discard_includes_lot_id_in_emit(tmp_path):
    """Pre-fix: the empty-bottle short-circuit emitted ``discarded`` by
    product_id only. With multiple lots of the same product, the
    cloud's product-level FEFO would zero the wrong lot. The fix
    includes ``lot_id`` in the emit so the cloud apply path can target
    the visually-identified lot directly.

    Mutation guard: dropping the ``lot_id=str(cloud_lot_id)`` kwarg
    from the ``emit_manual_discard`` call lets the FEFO race re-open.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product(conn, net=500.0, tare=25.0)
    # Two lots of the same product. The classifier picks LOT-MATCHED
    # but FEFO-by-created_at would pick LOT-OLDER first.
    _seed_cloud_lot(
        conn, lot_id="LOT-OLDER", product_id="prod-1", qty=0.6,
        created_at="2026-04-25T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="LOT-MATCHED", product_id="prod-1", qty=0.4,
        created_at="2026-04-26T00:00:00Z",
    )

    handled = handler._dispatch_catch_all_add(
        classification={"item_id": "LOT-MATCHED"},
        delta_g=30.0,  # empty-bottle weight
        event_ts="2026-04-28T12:10:00.000Z",
        event_id="evt-disc-lot",
        session_id=None,
    )
    assert handled is True
    emitter.emit_manual_discard.assert_called_once()
    kwargs = emitter.emit_manual_discard.call_args.kwargs
    assert kwargs.get("lot_id") == "LOT-MATCHED", (
        "discard payload must carry the visually-identified lot_id, not "
        "rely on cloud-side FEFO"
    )
    assert kwargs.get("product_id") == "prod-1"
    assert kwargs.get("kind") == "catch_all"


# ----------------------------------------------------------------------
# Namespace invariant — Pi lot_id vs cloud product_id vs cloud lot_id
# (regression for 2026-04-29 hamburger-buns bug)
# ----------------------------------------------------------------------
#
# The catch-all pool builder keys candidates by cloud lot_id (not
# product_id), so the classifier's item_id IS a lot_id.  The
# _dispatch_catch_all_add must translate item_id → product_id via the
# cloud_lots mirror BEFORE building the emit payload.  Pre-regression the
# dispatch used `item_id` directly as `product_id`, which would send the
# lot_id to the cloud and cause apply_shelf_event to return
# applied=false ("product not found").
#
# Verification strategy: use three completely distinct UUID-shaped strings
# for the Pi-local product reference, the cloud product_id, and the cloud
# lot_id.  The emit must carry cloud_product_id (never cloud_lot_id or the
# Pi-local product ref).  Pre-fix this test fails because the code would
# pass `item_id` (= CLOUD_LOT_UUID) as `product_id` to the emitter.

# Three deliberately distinct UUIDs — no two are equal.
_PI_LOCAL_PRODUCT_UUID = "aaaaaaaa-0000-0000-0000-000000000001"
_CLOUD_PRODUCT_UUID    = "bbbbbbbb-0000-0000-0000-000000000002"
_CLOUD_LOT_UUID        = "cccccccc-0000-0000-0000-000000000003"


def _seed_product_with_explicit_product_id(
    conn,
    *,
    pi_product_id: str,
    net: float = 500.0,
    tare: float = 25.0,
) -> None:
    """Seed a products row with a caller-supplied product_id UUID."""
    from server.storage.models import ProductIn  # local import for clarity
    storage_repo.create_product(
        conn,
        ProductIn(
            barcode="NSP-NS-001",
            name="Namespace Test Item",
            net_weight_g=net,
            gross_weight_g=net + tare,
            tare_weight_g=tare,
            unit_type="solid",
            container_type="bag",
            certified=1,
        ),
    )
    with conn:
        conn.execute(
            "UPDATE products SET product_id = ? WHERE barcode = ?",
            (pi_product_id, "NSP-NS-001"),
        )


def test_dispatch_sends_cloud_product_id_not_lot_id_in_first_measurement(
    tmp_path,
):
    """Regression: catch_all first-measurement emit must carry the cloud
    product_id extracted from cloud_lots, NOT the classifier's item_id
    (which is the cloud lot_id).

    Uses three deliberately distinct UUIDs:
      * Pi-local products.product_id = _PI_LOCAL_PRODUCT_UUID  (not used
        by dispatch — it goes through cloud_lots.product_id instead)
      * cloud_lots.product_id        = _CLOUD_PRODUCT_UUID
      * cloud_lots.lot_id            = _CLOUD_LOT_UUID  (= item_id)

    Pre-fix: _dispatch_catch_all_add called
      emit_catch_all_first_measurement(product_id=cid)
    where `cid` was the item_id from classification — i.e. _CLOUD_LOT_UUID.
    The cloud apply_shelf_event would get "product not found" and return
    applied=false, leaving cloud stock_lots.pickup_event_id = NULL.

    Post-fix: the dispatch looks up cloud_lots by lot_id=cid, reads
    product_id from that row, and passes _CLOUD_PRODUCT_UUID to the emit.
    """
    handler, conn, emitter = _make_handler(tmp_path)

    # Pi-local product row — its product_id deliberately differs from the
    # cloud product_id to prove the dispatch reads from cloud_lots, not
    # from the local products table.
    _seed_product_with_explicit_product_id(conn, pi_product_id=_PI_LOCAL_PRODUCT_UUID)

    # Cloud_lots row: lot_id = _CLOUD_LOT_UUID, product_id = _CLOUD_PRODUCT_UUID.
    # The JOIN inside list_certified_not_on_shelf_lots_by_oldest_created
    # requires products.product_id == cloud_lots.product_id; here we seed
    # directly and bypass the pool builder so we can test _dispatch_catch_all_add
    # in isolation.
    _seed_cloud_lot(
        conn,
        lot_id=_CLOUD_LOT_UUID,
        product_id=_CLOUD_PRODUCT_UUID,
        qty=0.662,
        in_flight_kind=None,
    )

    # Classifier returns item_id = cloud lot_id (this is the correct
    # catch_all pool contract — pool_for_catch_all keys candidates by lot_id).
    classification = {
        "item_id": _CLOUD_LOT_UUID,
        "candidate_pool_used": [
            {
                "candidate_id": _CLOUD_LOT_UUID,
                "lot_id": _CLOUD_LOT_UUID,
                "product_id": _CLOUD_PRODUCT_UUID,
                "why_candidate": "inventory_only",
                "expected_weight_g": 337.0,
            }
        ],
    }

    handled = handler._dispatch_catch_all_add(
        classification=classification,
        delta_g=337.7,
        event_ts="2026-04-29T22:47:15.376Z",
        event_id="9e692a0a-0e33-4d85-8cea-5e49e23393d6",
        session_id="sess-ns-1",
    )

    assert handled is True, "dispatch must return True (FIRST measurement)"
    emitter.emit_catch_all_first_measurement.assert_called_once()
    kwargs = emitter.emit_catch_all_first_measurement.call_args.kwargs

    # THE CORE INVARIANT: product_id in the emit must be the cloud product_id
    # (from cloud_lots.product_id), NOT the lot_id / item_id.
    assert kwargs["product_id"] == _CLOUD_PRODUCT_UUID, (
        f"emit must carry cloud product_id={_CLOUD_PRODUCT_UUID!r}, "
        f"got {kwargs.get('product_id')!r}; "
        "if this is the lot_id the cloud handler will return 'product not found'"
    )
    assert kwargs["product_id"] != _CLOUD_LOT_UUID, (
        "emit must NOT carry the cloud lot_id as product_id"
    )
    assert kwargs["product_id"] != _PI_LOCAL_PRODUCT_UUID, (
        "emit must NOT carry the Pi-local product UUID (it differs from cloud's)"
    )
    assert kwargs["measured_weight_g"] == pytest.approx(337.7)
    assert kwargs["pi_event_id"] == "9e692a0a-0e33-4d85-8cea-5e49e23393d6"


def test_dispatch_sends_cloud_product_id_not_lot_id_in_second_measurement(
    tmp_path,
):
    """Same namespace invariant for the SECOND measurement path.

    The picked candidate's cloud_lots row has in_flight_kind='catch_all'.
    The emit must carry cloud product_id, not the lot_id that arrived as
    item_id.
    """
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product_with_explicit_product_id(conn, pi_product_id=_PI_LOCAL_PRODUCT_UUID)
    _seed_cloud_lot(
        conn,
        lot_id=_CLOUD_LOT_UUID,
        product_id=_CLOUD_PRODUCT_UUID,
        qty=0.662,
        in_flight_kind="catch_all",
        pickup_event_id="9e692a0a-0e33-4d85-8cea-5e49e23393d6",
    )

    classification = {
        "item_id": _CLOUD_LOT_UUID,
        "candidate_pool_used": [
            {
                "candidate_id": _CLOUD_LOT_UUID,
                "lot_id": _CLOUD_LOT_UUID,
                "product_id": _CLOUD_PRODUCT_UUID,
                "why_candidate": "in_flight",
                "expected_weight_g": 337.0,
            }
        ],
    }

    handled = handler._dispatch_catch_all_add(
        classification=classification,
        delta_g=200.0,
        event_ts="2026-04-29T22:49:02.757Z",
        event_id="50959097-dd99-421f-b004-e5e0d8f10016",
        session_id="sess-ns-2",
    )

    assert handled is True, "dispatch must return True (SECOND measurement)"
    emitter.emit_catch_all_second_measurement.assert_called_once()
    kwargs = emitter.emit_catch_all_second_measurement.call_args.kwargs

    assert kwargs["product_id"] == _CLOUD_PRODUCT_UUID, (
        f"SECOND emit must carry cloud product_id={_CLOUD_PRODUCT_UUID!r}, "
        f"got {kwargs.get('product_id')!r}"
    )
    assert kwargs["product_id"] != _CLOUD_LOT_UUID
    assert kwargs["first_event_pi_event_id"] == "9e692a0a-0e33-4d85-8cea-5e49e23393d6"


def test_dispatch_sends_cloud_product_id_not_lot_id_in_empty_bottle_discard(
    tmp_path,
):
    """Same namespace invariant for the empty-bottle discard path."""
    handler, conn, emitter = _make_handler(tmp_path)
    _seed_product_with_explicit_product_id(
        conn, pi_product_id=_PI_LOCAL_PRODUCT_UUID, net=500.0, tare=25.0,
    )
    _seed_cloud_lot(
        conn,
        lot_id=_CLOUD_LOT_UUID,
        product_id=_CLOUD_PRODUCT_UUID,
        qty=0.662,
        in_flight_kind=None,
    )

    # We need the products table to have _CLOUD_PRODUCT_UUID so tare lookup
    # works (get_product called with product_id from cloud_lots.product_id).
    # Re-seed with _CLOUD_PRODUCT_UUID so the dispatch can resolve tare.
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO products "
            "(product_id, name, net_weight_g, gross_weight_g, "
            " tare_weight_g, unit_type, container_type, certified) "
            "VALUES (?, 'NSP Cloud Product', 500.0, 525.0, 25.0, "
            "        'solid', 'bag', 1)",
            (_CLOUD_PRODUCT_UUID,),
        )

    classification = {
        "item_id": _CLOUD_LOT_UUID,
        "candidate_pool_used": [
            {
                "candidate_id": _CLOUD_LOT_UUID,
                "lot_id": _CLOUD_LOT_UUID,
                "product_id": _CLOUD_PRODUCT_UUID,
                "why_candidate": "inventory_only",
                "expected_weight_g": 525.0,
            }
        ],
    }

    # 25g = tare, well within ±5% of (25+500)=525 → empty-bottle window.
    handled = handler._dispatch_catch_all_add(
        classification=classification,
        delta_g=25.0,
        event_ts="2026-04-29T23:00:00.000Z",
        event_id="evt-ns-discard",
        session_id="sess-ns-3",
    )

    assert handled is True, "empty-bottle discard must be handled"
    emitter.emit_manual_discard.assert_called_once()
    kwargs = emitter.emit_manual_discard.call_args.kwargs

    assert kwargs["product_id"] == _CLOUD_PRODUCT_UUID, (
        f"discard emit must carry cloud product_id, got {kwargs.get('product_id')!r}"
    )
    assert kwargs["product_id"] != _CLOUD_LOT_UUID
