"""Catch-all scale shelf routing tests (CATCH_ALL_SCALE_PLAN.md §6, §7).

Covers two behaviors in ``server.handlers.scale_events``:

  1. Ingress: ``handle_scale_event`` resolves the payload's ``device_id``
     to a shelf via ``shelves.get_shelf_for_device`` and stamps the new
     ``scale_events.shelf_id`` row accordingly.
  2. Apply: when the classifier picks a ``catalog_not_on_shelf`` product
     on a catch-all event, ``_apply_lot_update_from_classification`` mints
     the new ``lots`` row with ``shelf_id='catch_all'`` (NOT the default
     live_shelf).
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

from server.classifier.models import UNKNOWN_CANDIDATE_ID  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.shelves import build_registry_from_config  # noqa: E402
from server.config import AppConfig  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn, ScaleEventIn  # noqa: E402


class _NullCandidateSource:
    """Minimal CandidateSource that returns empty pools — tests exercise the
    handler plumbing, not classifier logic."""

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(conn, tmp_path, *, catch_all_enabled=True):
    cfg = AppConfig()
    cfg.catch_all_enabled = catch_all_enabled
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
        catch_all_enabled=catch_all_enabled,
        shelf_registry_override=registry,
    )


# ---------------------------------------------------------------------------
# §6 ingress routing
# ---------------------------------------------------------------------------


def test_scale_event_ingress_routes_scale_02_to_catch_all_shelf_id(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_enabled=True)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })

    assert status == 200, (resp, status)
    event_id = resp["event_id"]
    row = conn.execute(
        "SELECT shelf_id FROM scale_events WHERE event_id = ?",
        (event_id,),
    ).fetchone()
    assert row is not None
    assert row[0] == "catch_all", (
        f"scale-02 ingress must stamp shelf_id='catch_all', got {row[0]!r}"
    )


def test_scale_event_ingress_routes_scale_01_to_live_shelf_shelf_id(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_enabled=True)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-01",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })

    assert status == 200, (resp, status)
    row = conn.execute(
        "SELECT shelf_id FROM scale_events WHERE event_id = ?",
        (resp["event_id"],),
    ).fetchone()
    assert row[0] == "live_shelf"


def test_scale_event_ingress_routes_scale_03_to_single_item_short_circuit(tmp_path):
    """Single-item rig: events short-circuit to cloud emit, no local scale_events.

    Two things are being asserted in this one integration test:

      1. Type-literal translation happens: shelf_id='live_scale' (from the
         registry) gets mapped to 'single_item' before any storage-type
         comparison. Before this fix, the handler 500'd on the first
         ScaleEventIn() construction because the Pydantic Literal didn't
         accept 'live_scale'. Verified by the handler not raising.

      2. Single-item events take the dedicated short-circuit path: no
         scale_events row, no classifier, no session. They emit directly
         to the cloud (CloudEventEmitter.emit_single_item_event) and
         return a 200 with shelf_id='single_item'. We assert both sides.

    If these two behaviors ever diverge — e.g. someone adds a scale_events
    insert into the single-item branch — stock math would double-count and
    the classifier would pick a random candidate.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_enabled=True)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-03",
        "event_seq": 1,
        "delta_g": -15.0,
        "before_weight_g": 200.0,
        "after_weight_g": 185.0,
    })

    assert status == 200, (resp, status)
    assert resp.get("shelf_id") == "single_item", resp
    assert resp.get("event_kind") == "consumed", resp
    # No local scale_events row — single-item skips the delta pipeline.
    count = conn.execute(
        "SELECT COUNT(*) FROM scale_events",
    ).fetchone()[0]
    assert count == 0, (
        f"single-item events must NOT write a local scale_events row; "
        f"found {count}"
    )


def test_scale_event_ingress_unknown_device_with_catch_all_enabled_rejects(tmp_path):
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_enabled=True)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-99",  # not in registry
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 400
    assert "error" in resp
    # No row should have been written.
    count = conn.execute(
        "SELECT COUNT(*) FROM scale_events"
    ).fetchone()[0]
    assert count == 0


def test_scale_event_ingress_unknown_device_without_catch_all_falls_back_to_live_shelf(tmp_path):
    """Pre-feature behavior: when catch_all is disabled, an unknown
    device_id still gets recorded (against live_shelf) so legacy setups
    using a non-canonical device_id aren't broken by this refactor."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_enabled=False)

    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "legacy-scale",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200
    row = conn.execute(
        "SELECT shelf_id FROM scale_events WHERE event_id = ?",
        (resp["event_id"],),
    ).fetchone()
    assert row[0] == "live_shelf"


# ---------------------------------------------------------------------------
# §7 apply-path mint on catch-all
# ---------------------------------------------------------------------------


def test_catch_all_mint_path_writes_shelf_id_catch_all(tmp_path):
    """Simulates a catch-all ADD whose classifier picked a catalog
    product (catalog_not_on_shelf branch). Assert the minted lots row
    carries shelf_id='catch_all', not the live_shelf default."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Catalog product that the classifier will pick.
    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Ketchup",
            barcode="kk-1",
            net_weight_g=500.0,
            gross_weight_g=500.0,
            unit_type="solid",
            container_type="bottle",
            certified=1,
        ),
    )

    # Record an ADD event that the handler would have seen on the catch-all.
    event_ts = "2026-04-18T09:00:00.000Z"
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=event_ts,
            delta_g=500.0,
            before_weight_g=0.0,
            after_weight_g=500.0,
            direction="add",
            session_id=None,
            classifier_status="pending",
            shelf_id="catch_all",
        ),
    )

    # Mirror what a successful classifier pass would feed to the apply
    # helper for a catalog_not_on_shelf pick: item_id is the product_id,
    # with that product_id visible in the pool.
    classification = {
        "item_id": product.product_id,
        "action": "added",
        "confidence": 1.0,
        "multi_match": [],
        "candidate_pool_used": [
            {
                "candidate_id": product.product_id,
                "expected_weight_g": 500.0,
                "why_candidate": "catalog_not_on_shelf",
            },
        ],
    }

    before_count = conn.execute(
        "SELECT COUNT(*) FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchone()[0]
    assert before_count == 0

    handler._apply_lot_update_from_classification(
        direction="add",
        classification=classification,
        event_ts=event_ts,
        delta_g=500.0,
        session_id=None,
        event_id=ev.event_id,
        shelf_id="catch_all",
    )

    rows = conn.execute(
        "SELECT lot_id, shelf_id, status FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchall()
    assert len(rows) == 1, (
        "Expected exactly one minted lot for the catalog pick"
    )
    assert rows[0][1] == "catch_all", (
        f"Catch-all ADD mint wrote shelf_id={rows[0][1]!r}; expected "
        f"'catch_all' — the shelf_id must be threaded into LotIn."
    )
    assert rows[0][2] == "on_shelf"


def test_live_shelf_mint_still_writes_shelf_id_live_shelf(tmp_path):
    """Regression guard: the same apply-helper signature change must NOT
    break the pre-catch-all live-shelf ADD path. When called with the
    default shelf_id (live_shelf), the mint inherits that value."""
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Mustard",
            barcode="mm-1",
            net_weight_g=300.0,
            gross_weight_g=300.0,
            unit_type="solid",
            container_type="bottle",
            certified=1,
        ),
    )

    event_ts = "2026-04-18T09:00:00.000Z"
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=event_ts,
            delta_g=300.0,
            before_weight_g=0.0,
            after_weight_g=300.0,
            direction="add",
            session_id=None,
            classifier_status="pending",
            # shelf_id omitted — SQL DEFAULT fires.
        ),
    )

    classification = {
        "item_id": product.product_id,
        "action": "added",
        "confidence": 1.0,
        "multi_match": [],
        "candidate_pool_used": [
            {
                "candidate_id": product.product_id,
                "expected_weight_g": 300.0,
                "why_candidate": "catalog_not_on_shelf",
            },
        ],
    }

    # Call WITHOUT passing shelf_id — default ('live_shelf') must apply.
    handler._apply_lot_update_from_classification(
        direction="add",
        classification=classification,
        event_ts=event_ts,
        delta_g=300.0,
        session_id=None,
        event_id=ev.event_id,
    )

    rows = conn.execute(
        "SELECT shelf_id FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "live_shelf"
