"""Regression test: scale-03 live_scale refill emits an outbox event.

Mimics the production bug from 2026-04-22:

  * scale-03 is paired in the cloud to chocolate-milk product
    (chefbyte.scale_pairings).
  * The product has net_weight_g populated.
  * The user places a fresh bottle on scale-03.

Expected Pi-side behavior:

  * ``handle_scale_event`` for device_id='scale-03' maps shelf_id
    ``live_scale`` → ``single_item`` at ingress, skips the
    live_shelf/catch_all classifier pipeline entirely, and calls
    ``emit_single_item_event`` directly (short-circuit path).
  * A cloud_outbox row lands with kind='live_scale',
    event_kind='refilled' (delta > refill_threshold), positive delta_g,
    scale_id='scale-03', occurred_at = ESP ts. product_id is omitted
    (cloud resolves via scale_pairings).
  * Zero local scale_events rows (single-item rig is cloud-native).

This test was written AFTER observing the bug in production. It's the
behavioral companion to the structural contract test in
``test_cloud_contract.py`` — together they prevent regression of the
end-to-end path that blocks the "paired item on scale → inventory
updates" flow.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.storage import init_db  # noqa: E402


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
    """Build a ScaleHandler with the default shelf registry (scale-03 is
    single-item) and a real CloudEventEmitter backed by the in-memory
    cloud_outbox table."""
    cfg = AppConfig()
    cfg.catch_all_enabled = True
    registry = build_registry_from_config(cfg)
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
        catch_all_enabled=True,
        shelf_registry_override=registry,
        cloud_emitter=emitter,
    )


def _outbox_rows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in conn.execute(
            "SELECT outbox_id, client_event_id, sent_at, attempts, "
            "       failed_permanently, payload_json "
            "  FROM cloud_outbox "
            " ORDER BY outbox_id ASC"
        )
    ]


def test_scale03_paired_refill_enqueues_live_scale_outbox_event(tmp_path):
    """A +1672g add on scale-03 must enqueue a cloud_outbox row with
    kind='live_scale', event_kind='refilled', positive delta, scale_id='scale-03',
    NO product_id (cloud resolves via scale_pairings), and leave zero
    local scale_events rows."""
    conn = init_db(":memory:")
    # Row factory so payload extraction reads by column name.
    conn.row_factory = sqlite3.Row
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    # Place a fresh 1672g bottle on scale-03: ESP reports the add.
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-22T15:00:00.000Z",
        "device_id": "scale-03",
        "event_seq": 1,
        "delta_g": 1672.0,
        "before_weight_g": 0.0,
        "after_weight_g": 1672.0,
    })

    assert status == 200, (resp, status)
    # Handler must take the single-item short-circuit branch.
    assert resp.get("shelf_id") == "single_item", resp
    assert resp.get("event_kind") == "refilled", resp
    # No local scale_events row — single-item is cloud-native.
    assert conn.execute("SELECT COUNT(*) FROM scale_events").fetchone()[0] == 0

    # Exactly one outbox row, representing this refill.
    rows = _outbox_rows(conn)
    assert len(rows) == 1, f"expected 1 outbox row, got {len(rows)}: {rows!r}"
    payload = json.loads(rows[0]["payload_json"])

    assert payload["kind"] == "live_scale", payload
    assert payload["event_kind"] == "refilled", payload
    assert payload["scale_id"] == "scale-03", payload
    # Refill delta is positive (mass went up).
    assert isinstance(payload["delta_g"], (int, float))
    assert payload["delta_g"] > 0, payload
    assert payload["delta_g"] == pytest.approx(1672.0)
    # product_id must be OMITTED (not null) so the cloud /event handler's
    # `if (!productId && kind === 'live_scale')` pairing-resolution branch
    # fires. Sending null would fall through to the 'product_id required'
    # 400 and stall the outbox.
    assert "product_id" not in payload, (
        "Pi must not send product_id for single-item — cloud resolves "
        f"via scale_pairings. payload={payload!r}"
    )

    # occurred_at must mirror the ESP ts (the emitter preserves whatever
    # the handler passes in) — analytics depend on wall-clock placement.
    assert payload["occurred_at"] == "2026-04-22T15:00:00.000Z", payload

    # Row must still be pending drain (CloudWorker hasn't ticked in this test).
    assert rows[0]["sent_at"] is None
    assert rows[0]["attempts"] == 0
    assert rows[0]["failed_permanently"] == 0


def test_scale03_paired_consume_enqueues_live_scale_consumed_event(tmp_path):
    """Symmetric test: removing ~1672g from scale-03 must enqueue a
    kind='live_scale', event_kind='consumed', NEGATIVE delta event.

    Added alongside the refill test so the complete single-item
    round-trip (place then remove) is pinned. This is the flow the
    production user exercises: consume milk until bottle is empty,
    scale reports the depletion delta."""
    conn = init_db(":memory:")
    conn.row_factory = sqlite3.Row
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    # Pretend there was already a full bottle on the scale; now it's
    # fully lifted off.
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-22T15:05:00.000Z",
        "device_id": "scale-03",
        "event_seq": 2,
        "delta_g": -1672.0,
        "before_weight_g": 1672.0,
        "after_weight_g": 0.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("shelf_id") == "single_item", resp
    # When after_weight_g is within noise floor, the emitter classifies
    # as 'depleted' rather than 'consumed'. The handler's short-circuit
    # sets event_kind in its response for diagnostics; the cloud payload
    # is what actually matters. Accept either as a valid consumption
    # signal (depletion is a stricter form of consumed).
    assert resp.get("event_kind") in ("consumed", "depleted"), resp

    rows = _outbox_rows(conn)
    assert len(rows) == 1
    payload = json.loads(rows[0]["payload_json"])
    assert payload["kind"] == "live_scale"
    assert payload["event_kind"] in ("consumed", "depleted"), payload
    # Negative delta whether classified as consumed (raw) or depleted
    # (magnitude negated by the emitter).
    assert payload["delta_g"] < 0, payload
