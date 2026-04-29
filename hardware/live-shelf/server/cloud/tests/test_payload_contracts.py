"""Tests for server.cloud.payload_contracts and emitter integration."""

from __future__ import annotations

import json
import sqlite3
import sys
import uuid
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.cloud.payload_contracts import (  # noqa: E402
    PayloadContractError,
    SUPPORTED_EVENT_KINDS,
    validate_payload_contract,
)
from server.storage import init_db  # noqa: E402


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = init_db(":memory:")
    try:
        yield c
    finally:
        c.close()


def _last_payload(conn: sqlite3.Connection) -> dict:
    row = conn.execute(
        "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    return json.loads(row["payload_json"])


def test_supported_event_kinds_cover_every_emitter_path():
    assert SUPPORTED_EVENT_KINDS == frozenset({
        "consumed",
        "added",
        "refilled",
        "depleted",
        "in_flight_pickup",
        "in_flight_return",
        "discarded",
        "catch_all_first_measurement",
        "catch_all_second_measurement",
        "live_weight_sync",
        "review_queue_create",
        "review_queue_resolve",
    })


def test_round_trip_fixture_payloads_validate_for_every_emitter(conn):
    emitter = CloudEventEmitter(conn, enabled=True)

    emits = [
        lambda: emitter.emit_reconciler_resolution(
            pattern="use_return_consumed",
            product_id="prod-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=-10.0,
            occurred_at="2026-04-29T12:00:00.000Z",
            resolution_id="res-1",
            pi_event_id="evt-1",
        ),
        lambda: emitter.emit_reconciler_resolution(
            pattern="new_arrival",
            product_id="prod-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=42.0,
            occurred_at="2026-04-29T12:00:01.000Z",
        ),
        lambda: emitter.emit_reconciler_resolution(
            pattern="topped_up",
            product_id="prod-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=12.5,
            occurred_at="2026-04-29T12:00:02.000Z",
        ),
        lambda: emitter.emit_reconciler_resolution(
            pattern="in_flight_pickup",
            product_id="prod-1",
            scale_id="scale-01",
            kind="live_shelf",
            delta_g=0.0,
            occurred_at="2026-04-29T12:00:03.000Z",
        ),
        lambda: emitter.emit_single_item_event(
            scale_id="scale-03",
            product_id="prod-2",
            delta_g=-15.0,
            noise_floor_g=2.0,
            refill_threshold_g=20.0,
            depleted=False,
            occurred_at="2026-04-29T12:00:04.000Z",
        ),
        lambda: emitter.emit_single_item_event(
            scale_id="scale-03",
            product_id="prod-2",
            delta_g=25.0,
            noise_floor_g=2.0,
            refill_threshold_g=20.0,
            depleted=False,
            occurred_at="2026-04-29T12:00:05.000Z",
        ),
        lambda: emitter.emit_single_item_event(
            scale_id="scale-03",
            product_id="prod-2",
            delta_g=120.0,
            noise_floor_g=2.0,
            refill_threshold_g=20.0,
            depleted=True,
            occurred_at="2026-04-29T12:00:06.000Z",
        ),
        lambda: emitter.emit_in_flight_reap(
            scale_id="scale-01",
            product_id="prod-3",
            consumed_g=30.0,
            occurred_at="2026-04-29T12:00:07.000Z",
        ),
        lambda: emitter.emit_manual_discard(
            scale_id="scale-02",
            product_id="prod-4",
            kind="catch_all",
            occurred_at="2026-04-29T12:00:08.000Z",
            lot_id="lot-4",
        ),
        lambda: emitter.emit_in_flight_return_marker(
            scale_id="scale-01",
            product_id="prod-5",
            kind="live_shelf",
            occurred_at="2026-04-29T12:00:09.000Z",
        ),
        lambda: emitter.emit_catch_all_first_measurement(
            scale_id="scale-02",
            product_id="prod-6",
            measured_weight_g=300.0,
            pi_event_id="evt-first",
            occurred_at="2026-04-29T12:00:10.000Z",
        ),
        lambda: emitter.emit_catch_all_second_measurement(
            scale_id="scale-02",
            product_id="prod-6",
            measured_weight_g=120.0,
            first_event_pi_event_id="evt-first",
            occurred_at="2026-04-29T12:00:11.000Z",
        ),
        lambda: emitter.emit_review_queue_create(
            pi_review_id=str(uuid.uuid4()),
            kind="low_confidence",
            proposed={"item_id": "prod-x", "confidence": 0.8},
            images=["events/e1/before.jpg"],
            created_at="2026-04-29T12:00:12.000Z",
        ),
        lambda: emitter.emit_review_queue_resolve(
            pi_review_id=str(uuid.uuid4()),
            status="resolved",
            user_response={"candidate_id": "prod-y"},
            resolved_at="2026-04-29T12:00:13.000Z",
        ),
        lambda: emitter.emit_live_weight_sync(
            scale_id="scale-01",
            kind="live_shelf",
            pi_lot_id=str(uuid.uuid4()),
            observed_weight_g=160.2,
            occurred_at="2026-04-29T12:00:14.000Z",
        ),
    ]

    for emit in emits:
        cid = emit()
        assert cid is not None
        validate_payload_contract(_last_payload(conn))


@pytest.mark.parametrize(
    "bad_payload,needle",
    [
        (
            {
                "scale_id": "scale-01",
                "kind": "live_shelf",
                "event_kind": "live_weight_sync",
                "observed_weight_g": None,
                "delta_g": 10.0,
                "pi_lot_id": "lot-1",
                "occurred_at": "2026-04-29T12:30:00.000Z",
            },
            "observed_weight_g",
        ),
        (
            {
                "scale_id": "scale-01",
                "kind": "live_shelf",
                "event_kind": "live_weight_sync",
                "observed_weight_g": 10.0,
                "delta_g": None,
                "pi_lot_id": "lot-1",
                "occurred_at": "2026-04-29T12:30:00.000Z",
            },
            "delta_g",
        ),
        (
            {
                "event_kind": "review_queue_resolve",
                "pi_review_id": "r1",
                "status": None,
            },
            "status",
        ),
        (
            {
                "event_kind": "catch_all_first_measurement",
                "scale_id": "scale-02",
                "kind": "catch_all",
                "product_id": "p1",
                "delta_g": 0.0,
                "occurred_at": "2026-04-29T12:30:00.000Z",
                "pi_event_id": "evt",
            },
            "delta_g",
        ),
    ],
)
def test_validate_payload_contract_rejects_forbidden_nulls_or_invalid_values(
    bad_payload: dict,
    needle: str,
):
    with pytest.raises(PayloadContractError, match=needle):
        validate_payload_contract(bad_payload)


def test_invalid_payload_raises_before_enqueue(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    bad_payload = {
        "scale_id": "scale-01",
        "kind": "live_shelf",
        "event_kind": "live_weight_sync",
        "observed_weight_g": None,
        "delta_g": 12.0,
        "pi_lot_id": "lot-1",
        "occurred_at": "2026-04-29T12:31:00.000Z",
    }

    # Contract violations now produce a dead-letter outbox row instead of
    # silently vanishing. The emitter still returns None (caller sees "no
    # event id emitted") but the row is recorded for operator inspection.
    result = emitter._enqueue(bad_payload)
    assert result is None, "emitter must return None for a dead-lettered payload"
    rows = conn.execute("SELECT COUNT(*), last_error, failed_permanently, attempts FROM cloud_outbox").fetchone()
    assert rows[0] == 1, "exactly one dead-letter row must be inserted"
    assert rows[1].startswith("PRODUCER_DROP:"), f"last_error must start with PRODUCER_DROP: — got {rows[1]!r}"
    assert rows[2] == 1, "failed_permanently must be 1 (dead-lettered)"
    assert rows[3] == 99, "attempts must be 99 (above retry threshold)"
