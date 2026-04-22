"""Replacement branch companion emit.

Regression for the 2026-04-22 chocolate-milk bug: when the classifier
lands on the "replacement" side of _apply_add_against_in_flight_lot
(ratio > new_item_weight_ratio — e.g. user picks up a 472g partial
container and puts a 1672g full one back), the Pi now emits TWO cloud
events:

  1. ``in_flight_replaced_new_item`` → live_shelf consumed for the
     old pickup_weight_g (presumed eaten off-shelf).
  2. ``in_flight_replacement_add`` → live_shelf added for the new
     heavier mass placed on the shelf.

Before this fix only #1 fired, so cloud inventory never saw the
replacement container.
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


def test_replacement_branch_emits_both_consumed_and_added(tmp_path):
    """Chocolate-milk scenario end-to-end.

    1. Pickup (REMOVE -472g) — classifier picks the on-shelf partial
       bottle, lot flips to in_flight. No outbox emit (pickup is
       bookkeeping).
    2. Replacement (ADD +1672g, classifier picks same lot) — ratio
       1672/472 = 3.54 > 1.15 → replacement branch. OLD lot closes
       as consumed (pickup_weight_g presumed eaten). A fresh cloud
       emit for the NEW mass is added too.

    Assertions:
      * exactly TWO cloud_outbox rows (was 1 before the fix)
      * row 1: live_shelf consumed, delta_g = -472.0, same product_id
      * row 2: live_shelf added,    delta_g = +1672.0, same product_id,
        and share the same pi_event_id as row 1 (both from the same
        scale_events.event_id — cloud dedupes via client_event_id).
    """
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Chocolate Milk",
            barcode="CM-1",
            net_weight_g=1672.0,
            gross_weight_g=1672.0,
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
            current_weight_g=472.0,   # partial bottle
            initial_weight_g=1672.0,
            shelf_id="live_shelf",
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=472.0,
    ).session_id

    # --- Pickup (REMOVE -472g) ---
    e_remove = _record_event(
        conn, direction="remove", delta_g=-472.0,
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
        delta_g=-472.0,
        session_id=session_id,
        event_id=e_remove,
        shelf_id="live_shelf",
    )
    assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"
    assert _outbox_rows(conn) == [], (
        "pickup must not emit cloud events"
    )

    # --- Replacement (ADD +1672g, classifier picks same lot) ---
    e_add = _record_event(
        conn, direction="add", delta_g=1672.0,
        ts="2026-04-22T04:03:54.000Z", session_id=session_id,
    )
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.92,
            "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": lot.lot_id,
                 "why_candidate": "in_flight",
                 "expected_weight_g": 472.0},
            ],
        },
        event_ts="2026-04-22T04:03:54.000Z",
        delta_g=1672.0,
        session_id=session_id,
        event_id=e_add,
        shelf_id="live_shelf",
    )

    rows = _outbox_rows(conn)
    assert len(rows) == 2, (
        f"replacement must emit TWO cloud rows (consumed + added), got "
        f"{len(rows)}: {[r['payload_json'] for r in rows]}"
    )
    p1 = json.loads(rows[0]["payload_json"])
    p2 = json.loads(rows[1]["payload_json"])

    # Row 1: consumed for the old pickup mass.
    assert p1["kind"] == "live_shelf"
    assert p1["event_kind"] == "consumed"
    assert p1["product_id"] == product.product_id
    assert p1["delta_g"] == pytest.approx(-472.0)
    assert p1["pi_event_id"] == e_add

    # Row 2: added for the new (heavier) replacement mass.
    assert p2["kind"] == "live_shelf"
    assert p2["event_kind"] == "added"
    assert p2["product_id"] == product.product_id
    assert p2["delta_g"] == pytest.approx(1672.0)
    assert p2["pi_event_id"] == e_add

    # Client event ids must differ — they're separate cloud events
    # that need separate idempotency keys. (Both share the Pi's
    # event_id as pi_event_id for audit correlation.)
    assert rows[0]["client_event_id"] != rows[1]["client_event_id"]


def test_replacement_add_payload_shape_contract(tmp_path):
    """Pin the full cloud-contract shape of the replacement_add emit:

      * kind == 'live_shelf'
      * event_kind == 'added'
      * delta_g == +(replacement_mass)
      * product_id == old-lot.product_id
      * scale_id present (synthesised from shelf_id)
      * pi_event_id stamped

    This is the payload cloud's apply_shelf_event parses; it must
    exactly match the service-role RPC signature. A drift here would
    silently 400 the cloud /event call and the replacement lot would
    disappear again — exactly the bug we're fixing.
    """
    conn = init_db(":memory:")
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Chocolate Milk",
            barcode="CM-1",  # identical to test 1 — tests are independent
            net_weight_g=1672.0,
            gross_weight_g=1672.0,
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
            current_weight_g=472.0,
            initial_weight_g=1672.0,
            shelf_id="live_shelf",
        ),
    )
    session_id = storage_repo.open_session(
        conn, "2026-04-22T03:00:00.000Z", initial_weight_g=472.0,
    ).session_id

    e_remove = _record_event(
        conn, direction="remove", delta_g=-472.0,
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
        delta_g=-472.0,
        session_id=session_id,
        event_id=e_remove,
        shelf_id="live_shelf",
    )
    assert storage_repo.get_lot(conn, lot.lot_id).status == "in_flight"

    e_add = _record_event(
        conn, direction="add", delta_g=1672.0,
        ts="2026-04-22T04:03:54.000Z", session_id=session_id,
    )
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": lot.lot_id,
            "action": "added",
            "confidence": 0.92,
            "multi_match": [],
            "candidate_pool_used": [
                {"candidate_id": lot.lot_id,
                 "why_candidate": "in_flight",
                 "expected_weight_g": 472.0},
            ],
        },
        event_ts="2026-04-22T04:03:54.000Z",
        delta_g=1672.0,
        session_id=session_id,
        event_id=e_add,
        shelf_id="live_shelf",
    )

    rows = _outbox_rows(conn)
    assert len(rows) == 2
    add_payload = json.loads(rows[1]["payload_json"])
    assert add_payload["kind"] == "live_shelf"
    assert add_payload["event_kind"] == "added"
    assert add_payload["delta_g"] == pytest.approx(1672.0)
    assert add_payload["product_id"] == product.product_id
    assert "scale_id" in add_payload
    assert add_payload["pi_event_id"] == e_add
    assert "occurred_at" in add_payload
