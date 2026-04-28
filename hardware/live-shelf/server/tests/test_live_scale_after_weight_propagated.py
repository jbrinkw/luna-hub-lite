"""Regression test: live_scale (single_item) outbox payload includes
``after_weight_g`` so the cloud can apply SET semantics on placement
events.

CONTEXT (2026-04-28):
  Tonight's bug: user scanned a gallon of milk → wizard inserted a
  stock_lots row with qty_containers=1.0. User placed the bottle on
  scale-03 (live_scale). The Pi emitted ``refilled`` with delta_g=full
  bottle weight. The cloud applied via the legacy resolver path which
  treated the event as ADD and bumped qty 1.0 → 1.972.

  Migration 20260428060000 fixes this by having the cloud SET qty :=
  after_weight_g / net_weight_g for paired live_scale ADD events.
  This test pins the Pi-side contract: the outbox payload MUST carry
  ``after_weight_g`` so the cloud has the absolute mass available.

If the Pi stops emitting ``after_weight_g``, the cloud falls back to
delta_g for backwards compatibility — but only when the Pi's emitter
is broken or the handler caller forgets to pass it through. This test
guards the happy path.
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


def _outbox_payloads(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        json.loads(row[0])
        for row in conn.execute(
            "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id ASC"
        )
    ]


def test_live_scale_refill_payload_includes_after_weight_g(tmp_path):
    """A placement event (0g → 3677g) emits ``after_weight_g=3677`` so
    the cloud can SET qty := 3677/net_weight rather than ADD."""
    conn = init_db(":memory:")
    conn.row_factory = sqlite3.Row
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-28T18:05:51.774Z",
        "device_id": "scale-03",
        "event_seq": 1,
        "delta_g": 3677.856,
        "before_weight_g": 0.0,
        "after_weight_g": 3677.856,
    })

    assert status == 200, (resp, status)
    assert resp.get("shelf_id") == "single_item"
    assert resp.get("event_kind") == "refilled"
    # Handler echoes the after_weight_g in its response for
    # diagnostics.
    assert resp.get("after_weight_g") == pytest.approx(3677.856)

    payloads = _outbox_payloads(conn)
    assert len(payloads) == 1, payloads
    payload = payloads[0]

    assert payload["kind"] == "live_scale"
    assert payload["event_kind"] == "refilled"
    # The critical assertion: after_weight_g is present in the payload.
    # Without this field, the cloud's live_scale ADD branch falls back
    # to delta_g — which equals after_weight_g for a 0g→full placement
    # but NOT for a partial top-off (2000g→3677g delta=1677, after=3677).
    assert "after_weight_g" in payload, (
        "live_scale outbox payload MUST include after_weight_g so the "
        "cloud can SET qty := after_weight_g / net_weight_g. Missing "
        f"field in payload={payload!r}"
    )
    assert payload["after_weight_g"] == pytest.approx(3677.856), payload


def test_live_scale_partial_topoff_after_weight_differs_from_delta(tmp_path):
    """Top-off scenario: bottle was at 2000g, user added more, now at
    3677g. delta=1677 but after_weight=3677. The cloud needs the
    absolute weight (3677) to compute qty correctly via SET semantics
    — using delta would set qty to 1677/net_weight which is wrong.

    Mutation guard: if the Pi stops sending after_weight_g, this test
    fails because the payload only carries delta_g (different value)."""
    conn = init_db(":memory:")
    conn.row_factory = sqlite3.Row
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-28T19:00:00.000Z",
        "device_id": "scale-03",
        "event_seq": 7,
        "delta_g": 1677.0,
        "before_weight_g": 2000.0,
        "after_weight_g": 3677.0,
    })

    assert status == 200, (resp, status)
    payloads = _outbox_payloads(conn)
    assert len(payloads) == 1
    payload = payloads[0]

    # delta_g is the change (positive top-off).
    assert payload["delta_g"] == pytest.approx(1677.0), payload
    # after_weight_g is the absolute mass — the SET target.
    assert payload["after_weight_g"] == pytest.approx(3677.0), payload
    # They must differ. If they accidentally match, the test setup is
    # wrong (and the test loses its mutation-detection power).
    assert payload["delta_g"] != payload["after_weight_g"], (
        "Test setup invariant: delta_g and after_weight_g must differ "
        "in this scenario or the test cannot detect a regression that "
        "drops after_weight_g and falls back to delta_g."
    )


def test_live_scale_consume_payload_includes_after_weight_g(tmp_path):
    """Consume direction: bottle goes 1672g → 0g. delta=-1672,
    after_weight=0. Pi still emits after_weight_g=0 — the cloud's
    consume branch doesn't currently use it (delta semantics still
    correct for consumption), but emitting consistently keeps the
    payload shape stable for future apply-branch refactors."""
    conn = init_db(":memory:")
    conn.row_factory = sqlite3.Row
    emitter = CloudEventEmitter(conn, enabled=True)
    handler = _make_handler(conn, tmp_path, emitter)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-28T20:00:00.000Z",
        "device_id": "scale-03",
        "event_seq": 9,
        "delta_g": -1672.0,
        "before_weight_g": 1672.0,
        "after_weight_g": 0.0,
    })

    assert status == 200
    payloads = _outbox_payloads(conn)
    assert len(payloads) == 1
    payload = payloads[0]

    # Consume / depleted branch — both should still carry
    # after_weight_g=0.
    assert payload["kind"] == "live_scale"
    assert payload["event_kind"] in ("consumed", "depleted")
    assert "after_weight_g" in payload, payload
    assert payload["after_weight_g"] == pytest.approx(0.0), payload
