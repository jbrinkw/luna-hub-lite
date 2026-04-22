"""Cloud outbox regression: live_shelf classifier events must hit the
outbox when an in-flight lot returns (the 2026-04-22 chocolate-milk bug
found these events silently dropped — only single-item live_scale rows
were reaching cloud).

This test wires the ScaleHandler end-to-end with a real CloudEventEmitter
backed by an actual ``cloud_outbox`` table, drives an in-flight pickup
+ return through _apply_lot_update_from_classification, and inspects the
outbox to confirm a ``kind='live_shelf'`` ``event_kind='consumed'`` row
landed with the correct pi_event_id + product_id + negative delta.

This is the symmetric complement to test_cloud_contract.py (which only
covered single-item/live_scale + TTL-reap live_shelf emits) and pins
the live path that went unexercised.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(conn, tmp_path, emitter):
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    return ScaleHandler(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        cloud_emitter=emitter,
    )


def _record_event(conn, *, direction, delta_g, ts, session_id):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=0.0,
            after_weight_g=abs(delta_g),
            direction=direction, session_id=session_id,
            classifier_status="pending",
        ),
    )
    return ev.event_id


def _outbox_rows(conn) -> list[dict]:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT outbox_id, client_event_id, payload_json "
            "  FROM cloud_outbox "
            " ORDER BY outbox_id ASC"
        )
    ]


def test_in_flight_return_enqueues_live_shelf_consumed_event(tmp_path):
    """Full-stack: handler + real CloudEventEmitter + real outbox.

    Drives the 2026-04-22 chocolate-milk scenario:
      1. Pickup ADD: classifier picks lot_id (remove direction actually)
         → resolution in_flight_pickup, NO outbox emit (pickup is bookkeeping).
      2. Return ADD: classifier picks lot_id → return branch fires,
         computes 1200g consumption, emits a live_shelf consumed event to
         the outbox.

    Assertions:
      * Lot flips back to on_shelf with current_weight=472g
      * Exactly one cloud_outbox row exists (the return's consumed event)
      * Payload shape matches the cloud shelf-ingest /event contract
    """
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    # Seed product + on-shelf lot.
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Chocolate Milk",
            barcode="CM-1",
            net_weight_g=1537.8,
            gross_weight_g=1537.8,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=1672.0,
            initial_weight_g=1672.0,
            shelf_id="live_shelf",
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=1672.0,
    ).session_id

    # --- Pickup (REMOVE -1672g) ---
    e_remove = _record_event(
        conn, direction="remove", delta_g=-1672.0,
        ts="2026-04-22T03:01:39.000Z", session_id=session_id,
    )
    handler._apply_lot_update_from_classification(
        direction="remove",
        classification={
            "item_id": lot.lot_id,
            "action": "removed",
            "confidence": 0.95,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts="2026-04-22T03:01:39.000Z",
        delta_g=-1672.0,
        session_id=session_id,
        event_id=e_remove,
        shelf_id="live_shelf",
    )
    assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"
    # Pickup itself is not a cloud event (terminal-only policy).
    assert _outbox_rows(conn) == [], (
        "in_flight_pickup must NOT emit to cloud; only the terminal return"
        " / reap emits"
    )

    # --- Return (ADD +472g, classifier picks lot_id — the REAL 2026-04-22 shape) ---
    e_add = _record_event(
        conn, direction="add", delta_g=472.1,
        ts="2026-04-22T04:03:54.000Z", session_id=session_id,
    )
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.92,
            "multi_match": [],
            # Pool shape matches production dump: lot-backed entry has
            # no product_id field, plus unrelated catalog candidates.
            "candidate_pool_used": [
                {"candidate_id": lot.lot_id,
                 "why_candidate": "in_flight",
                 "expected_weight_g": 1672.494},
                {"candidate_id": "aa9f27c3-dba8-4c2f-ba34-333159d685ad",
                 "why_candidate": "catalog_not_on_shelf"},
            ],
        },
        event_ts="2026-04-22T04:03:54.000Z",
        delta_g=472.1,
        session_id=session_id,
        event_id=e_add,
        shelf_id="live_shelf",
    )

    # Pi-local state: lot closed, consumption recorded.
    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now.status == "on_shelf"
    assert lot_now.current_weight_g == pytest.approx(472.1)
    assert lot_now.total_consumed_g == pytest.approx(1199.9, rel=1e-3)

    # Cloud outbox: TWO rows — a ``consumed`` event that decrements qty
    # and a companion ``in_flight_return`` event that clears
    # stock_lots.in_flight_since on the cloud. Before the 2026-04-27
    # EMIT→HANDLE matrix fix only the consumed emit fired and the
    # cloud's in_flight marker stayed stuck forever on same-item return.
    rows = _outbox_rows(conn)
    assert len(rows) == 2, (
        f"expected exactly 2 outbox rows for the return "
        f"(consumed + in_flight_return marker-clear), got {len(rows)}: "
        f"{[r['payload_json'] for r in rows]}"
    )
    payload_consumed = json.loads(rows[0]["payload_json"])
    assert payload_consumed["kind"] == "live_shelf"
    assert payload_consumed["event_kind"] == "consumed"
    assert payload_consumed["product_id"] == product.product_id
    assert payload_consumed["delta_g"] == pytest.approx(-1199.9, rel=1e-3)
    assert payload_consumed["pi_event_id"] == e_add
    assert "client_event_id" in payload_consumed
    # scale_id for live_shelf events is synthesised from the shelf_id.
    assert "scale_id" in payload_consumed

    payload_marker = json.loads(rows[1]["payload_json"])
    assert payload_marker["kind"] == "live_shelf"
    assert payload_marker["event_kind"] == "in_flight_return"
    assert payload_marker["product_id"] == product.product_id
    # Marker-clear carries zero delta; qty mutation is owned by the
    # preceding consumed event.
    assert payload_marker["delta_g"] == 0.0
    assert payload_marker["pi_event_id"] == e_add


def test_self_heal_replays_stuck_in_flight_return(tmp_path):
    """One-shot self-heal: a pre-fix classified ADD event (in_flight lot
    never closed, no session_resolution, no outbox emit) must be replayed
    by scale_handler.self_heal_stuck_in_flight_returns() — lot closes,
    consumption recorded, cloud event enqueued.

    Pins the recovery path for Jeremy's chocolate-milk lot
    ``7c78ac21-1963-43c5-81ee-001260e6cd9e`` stuck on the Pi at deploy time.
    """
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Chocolate Milk",
            barcode="CM-1",
            net_weight_g=1537.8,
            gross_weight_g=1537.8,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=1672.0,
            initial_weight_g=1672.0,
            shelf_id="live_shelf",
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=1672.0,
    ).session_id

    # Simulate the pre-fix stuck state directly:
    #   1. Mark lot in_flight.
    #   2. Record an ADD event with classifier_status='classified' and
    #      the real 2026-04-22 classification shape.
    #   3. Do NOT write any in_flight_return resolution.
    storage_repo.mark_lot_in_flight(
        conn, lot.lot_id,
        pickup_weight_g=1672.494,
        pickup_event_id=None,
        pickup_session_id=None,
        in_flight_since="2026-04-22T03:01:39.205Z",
    )
    e_add = _record_event(
        conn, direction="add", delta_g=472.1,
        ts="2026-04-22T04:03:54.000Z", session_id=session_id,
    )
    # Stamp the event 'classified' with the real event's classification JSON.
    import json as _json
    classification = {
        "item_id": lot.lot_id,
        "action": "added",
        "confidence": 0.92,
        "reasoning": "returning lot",
        "multi_match": [],
        "candidate_pool_used": [
            {"candidate_id": lot.lot_id,
             "why_candidate": "in_flight",
             "expected_weight_g": 1672.494},
            {"candidate_id": "aa9f27c3-dba8-4c2f-ba34-333159d685ad",
             "why_candidate": "catalog_not_on_shelf"},
        ],
    }
    with conn:
        conn.execute(
            "UPDATE scale_events SET classifier_status='classified', "
            "classification=? WHERE event_id=?",
            (_json.dumps(classification), e_add),
        )

    # Pre-heal state: lot stuck in_flight, no outbox rows.
    assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"
    assert _outbox_rows(conn) == []

    # Run the self-heal.
    healed = handler.self_heal_stuck_in_flight_returns()
    assert healed == 1, "should have healed the one stuck lot"

    # Post-heal state: lot closed, consumption recorded, cloud emit fired.
    lot_now = storage_repo.get_lot(conn, lot.lot_id)
    assert lot_now.status == "on_shelf"
    assert lot_now.current_weight_g == pytest.approx(472.1)
    assert lot_now.total_consumed_g == pytest.approx(1200.394, rel=1e-3)

    rows = _outbox_rows(conn)
    # Two rows: consumed + in_flight_return marker-clear. The self-heal
    # goes through the same _apply_add_against_in_flight_lot path as a
    # live ADD event, so it inherits the same dual-emit contract added
    # in the 2026-04-27 EMIT→HANDLE matrix fix.
    assert len(rows) == 2, rows
    payload_consumed = json.loads(rows[0]["payload_json"])
    assert payload_consumed["kind"] == "live_shelf"
    assert payload_consumed["event_kind"] == "consumed"
    assert payload_consumed["product_id"] == product.product_id
    assert payload_consumed["pi_event_id"] == e_add
    payload_marker = json.loads(rows[1]["payload_json"])
    assert payload_marker["event_kind"] == "in_flight_return"
    assert payload_marker["product_id"] == product.product_id

    # Second call: nothing to heal (idempotent).
    assert handler.self_heal_stuck_in_flight_returns() == 0
    assert len(_outbox_rows(conn)) == 2


def test_self_heal_ignores_lots_already_closed(tmp_path):
    """Self-heal must not touch lots that are already on_shelf/out — only
    still-stuck in_flight ones.
    """
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    product = storage_repo.create_product(
        conn,
        ProductIn(name="X", barcode="X1", net_weight_g=100.0,
                  gross_weight_g=100.0, unit_type="solid",
                  container_type="box", certified=1),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(product_id=product.product_id, status="on_shelf",
              current_weight_g=100.0, initial_weight_g=100.0,
              shelf_id="live_shelf"),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=100.0,
    ).session_id
    e_add = _record_event(
        conn, direction="add", delta_g=100.0,
        ts="2026-04-22T04:03:54.000Z", session_id=session_id,
    )
    import json as _json
    classification = {
        "item_id": lot.lot_id, "action": "added", "confidence": 0.95,
        "reasoning": "", "multi_match": [],
        "candidate_pool_used": [{"candidate_id": lot.lot_id,
                                 "why_candidate": "in_flight"}],
    }
    with conn:
        conn.execute(
            "UPDATE scale_events SET classifier_status='classified', "
            "classification=? WHERE event_id=?",
            (_json.dumps(classification), e_add),
        )

    # Lot is on_shelf, not in_flight — self-heal must skip.
    assert handler.self_heal_stuck_in_flight_returns() == 0
    assert _outbox_rows(conn) == []


def test_in_flight_return_event_enqueues_only_once(tmp_path):
    """Idempotence: a duplicate apply call for the same event_id must NOT
    enqueue a second outbox row.

    Session-dedup kicks in when the same session already has a
    non-in_flight_pickup resolution for the lot. This protects against a
    sweeper retry for the same event double-writing to cloud.
    """
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Milk",
            barcode="M-1",
            net_weight_g=500.0,
            gross_weight_g=500.0,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="on_shelf",
            current_weight_g=500.0,
            initial_weight_g=500.0,
            shelf_id="live_shelf",
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=500.0,
    ).session_id

    # Pickup + return.
    e_remove = _record_event(
        conn, direction="remove", delta_g=-500.0,
        ts="2026-04-22T03:01:00.000Z", session_id=session_id,
    )
    handler._apply_lot_update_from_classification(
        direction="remove", delta_g=-500.0,
        classification={
            "item_id": lot.lot_id, "action": "removed",
            "confidence": 0.95, "multi_match": [],
            "candidate_pool_used": [{"candidate_id": lot.lot_id}],
        },
        event_ts="2026-04-22T03:01:00.000Z",
        session_id=session_id, event_id=e_remove, shelf_id="live_shelf",
    )
    e_add = _record_event(
        conn, direction="add", delta_g=200.0,
        ts="2026-04-22T03:05:00.000Z", session_id=session_id,
    )

    first_call = dict(
        direction="add", delta_g=200.0,
        classification={
            "item_id": lot.lot_id, "action": "added",
            "confidence": 0.95, "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": lot.lot_id, "why_candidate": "in_flight"},
            ],
        },
        event_ts="2026-04-22T03:05:00.000Z",
        session_id=session_id, event_id=e_add, shelf_id="live_shelf",
    )
    handler._apply_lot_update_from_classification(**first_call)
    # Two rows: ``consumed`` + ``in_flight_return`` marker-clear. The
    # 2026-04-27 EMIT→HANDLE matrix fix adds the marker-clear to
    # guarantee cloud's stock_lots.in_flight_since tracks Pi state.
    assert len(_outbox_rows(conn)) == 2

    # Call again with identical args (simulates a sweeper retry after
    # ambiguous crash). Session-dedup check at line 1604 uses the same
    # event_id as the prior write, so the SECOND attempt should be a
    # no-op — no new outbox rows (neither consumed nor marker-clear).
    handler._apply_lot_update_from_classification(**first_call)
    assert len(_outbox_rows(conn)) == 2, (
        "duplicate apply must not double-emit to cloud "
        "(both consumed and in_flight_return must dedup by session-level guard)"
    )
