"""Payload snapshot-style tests for every CloudEventEmitter.emit_* helper.

These tests assert persisted outbox payload shape/value (not just that an
emit method was called), so emitter serialization regressions are caught.
"""

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


def _assert_non_null(payload: dict, keys: tuple[str, ...]) -> None:
    for key in keys:
        assert key in payload
        assert payload[key] is not None, f"expected non-null payload[{key!r}]"


def test_emit_reconciler_resolution_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_reconciler_resolution(
        pattern="use_return_consumed",
        product_id="prod-1",
        scale_id="scale-01",
        kind="live_shelf",
        delta_g=-42.5,
        occurred_at="2026-04-29T10:00:00.000Z",
        resolution_id="res-1",
        pi_event_id="evt-1",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "product_id", "delta_g",
        "occurred_at", "_pi_resolution_id", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "consumed"
    assert payload["delta_g"] == pytest.approx(-42.5)


def test_emit_single_item_event_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_single_item_event(
        scale_id="scale-03",
        product_id="prod-2",
        delta_g=-80.0,
        noise_floor_g=2.0,
        refill_threshold_g=20.0,
        depleted=False,
        occurred_at="2026-04-29T10:01:00.000Z",
        pi_event_id="evt-2",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "delta_g", "occurred_at",
        "product_id", "usage_kind", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "consumed"
    assert payload["kind"] == "live_scale"
    assert payload["delta_g"] == pytest.approx(-80.0)


def test_emit_in_flight_reap_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_in_flight_reap(
        scale_id="scale-01",
        product_id="prod-3",
        consumed_g=120.0,
        occurred_at="2026-04-29T10:02:00.000Z",
        pi_event_id="evt-3",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "product_id", "delta_g",
        "occurred_at", "usage_kind", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "consumed"
    assert payload["delta_g"] == pytest.approx(-120.0)


def test_emit_manual_discard_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_manual_discard(
        scale_id="scale-02",
        product_id="prod-4",
        kind="catch_all",
        occurred_at="2026-04-29T10:03:00.000Z",
        pi_event_id="evt-4",
        lot_id="lot-4",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "product_id", "delta_g",
        "occurred_at", "pi_event_id", "pi_lot_id", "client_event_id",
    ))
    assert payload["event_kind"] == "discarded"
    assert payload["delta_g"] == 0.0


def test_emit_in_flight_return_marker_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_in_flight_return_marker(
        scale_id="scale-01",
        product_id="prod-5",
        kind="live_shelf",
        occurred_at="2026-04-29T10:04:00.000Z",
        pi_event_id="evt-5",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "product_id", "delta_g",
        "occurred_at", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "in_flight_return"
    assert payload["delta_g"] == 0.0


def test_emit_catch_all_first_measurement_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_catch_all_first_measurement(
        scale_id="scale-02",
        product_id="prod-6",
        measured_weight_g=350.5,
        pi_event_id="evt-first",
        occurred_at="2026-04-29T10:05:00.000Z",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "product_id", "delta_g",
        "occurred_at", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "catch_all_first_measurement"
    assert payload["delta_g"] == pytest.approx(350.5)


def test_emit_catch_all_second_measurement_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_catch_all_second_measurement(
        scale_id="scale-02",
        product_id="prod-7",
        measured_weight_g=200.25,
        first_event_pi_event_id="evt-first-2",
        occurred_at="2026-04-29T10:06:00.000Z",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "product_id", "delta_g",
        "occurred_at", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "catch_all_second_measurement"
    assert payload["delta_g"] == pytest.approx(200.25)


def test_emit_review_queue_create_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    review_id = str(uuid.uuid4())
    cid = emitter.emit_review_queue_create(
        pi_review_id=review_id,
        kind="low_confidence",
        pi_session_id="sess-1",
        pi_event_id="evt-review-1",
        proposed={"item_id": "prod-z", "confidence": 0.42},
        images=["events/e1/before.jpg"],
        created_at="2026-04-29T10:07:00.000Z",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "event_kind", "pi_review_id", "kind", "pi_session_id",
        "pi_event_id", "proposed", "images", "created_at", "client_event_id",
    ))
    assert payload["event_kind"] == "review_queue_create"


def test_emit_review_queue_resolve_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    review_id = str(uuid.uuid4())
    cid = emitter.emit_review_queue_resolve(
        pi_review_id=review_id,
        status="resolved",
        user_response={"candidate_id": "prod-y"},
        resolved_at="2026-04-29T10:08:00.000Z",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "event_kind", "pi_review_id", "status", "user_response",
        "resolved_at", "client_event_id",
    ))
    assert payload["event_kind"] == "review_queue_resolve"


def test_emit_live_weight_sync_payload_snapshot(conn):
    emitter = CloudEventEmitter(conn, enabled=True)
    cid = emitter.emit_live_weight_sync(
        scale_id="scale-01",
        kind="live_shelf",
        pi_lot_id=str(uuid.uuid4()),
        observed_weight_g=160.4355,
        occurred_at="2026-04-29T10:09:00.000Z",
        pi_event_id="evt-9",
    )
    assert cid is not None

    payload = _last_payload(conn)
    _assert_non_null(payload, (
        "scale_id", "kind", "event_kind", "observed_weight_g", "delta_g",
        "pi_lot_id", "occurred_at", "pi_event_id", "client_event_id",
    ))
    assert payload["event_kind"] == "live_weight_sync"
    assert payload["observed_weight_g"] == pytest.approx(160.4355)
    assert payload["delta_g"] == pytest.approx(160.4355)
