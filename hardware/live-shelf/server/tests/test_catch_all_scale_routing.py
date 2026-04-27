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
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


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


def test_catch_all_revive_path_uses_existing_shelf_id(tmp_path):
    """**2026-04-27 (decisions.md #42):** the apply-path no longer mints
    lots from a catalog pick. When the classifier returns a product_id
    for a catch-all ADD event, the picker resolves to the EXISTING lot
    (must already be in inventory under the inventory-only rule). This
    test verifies the lot's existing ``shelf_id`` is preserved (not
    overwritten) on the revive.

    Pre-2026-04-27 the test asserted a brand-new ``catch_all``-tagged
    lot was minted from a ``catalog_not_on_shelf`` pick. That branch
    is removed.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)

    # Catalog product + an EXISTING out-lot already on catch_all that
    # the apply path will resolve to.
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
    from datetime import datetime, timezone
    now_iso = datetime.now(tz=timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    existing_lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="out",
            current_weight_g=0.0,
            initial_weight_g=500.0,
            total_consumed_g=500.0,
            last_out_at=now_iso,
            shelf_id="catch_all",
        ),
    )

    # Record an ADD event that the handler would have seen on the catch-all.
    event_ts = now_iso
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

    # Classifier pick is the product_id (it sees products only under
    # the new contract).
    classification = {
        "item_id": product.product_id,
        "action": "added",
        "confidence": 1.0,
        "multi_match": [],
        "candidate_pool_used": [
            {
                "candidate_id": product.product_id,
                "product_id": product.product_id,
                "expected_weight_g": 500.0,
                "why_candidate": "recently_out",
            },
        ],
    }

    before_count = conn.execute(
        "SELECT COUNT(*) FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchone()[0]
    assert before_count == 1

    handler._apply_lot_update_from_classification(
        direction="add",
        classification=classification,
        event_ts=event_ts,
        delta_g=500.0,
        session_id=None,
        event_id=ev.event_id,
        shelf_id="catch_all",
    )

    # Same lot — no new mint. shelf_id preserved on the revive.
    rows = conn.execute(
        "SELECT lot_id, shelf_id, status FROM lots WHERE product_id = ?",
        (product.product_id,),
    ).fetchall()
    assert len(rows) == 1, (
        "Inventory-only rule violated: a duplicate lot was minted"
    )
    assert rows[0][0] == existing_lot.lot_id
    assert rows[0][1] == "catch_all", (
        f"Existing lot's shelf_id={rows[0][1]!r} not preserved on revive"
    )
    assert rows[0][2] == "on_shelf"


def test_catch_all_ingress_stamps_session_id_from_catch_all_pointer(tmp_path):
    """Regression: catch-all events must read session_id from
    ``app_state.current_catch_all_session_id``, NOT ``current_session_id``.

    Reproduces the bug that caused "No images for catch-all scale" on the Pi:
    a catch-all WeightHandler opens a session and stamps it on
    ``current_catch_all_session_id``. The ingress path (pre-fix) read
    ``current_session_id`` (the live-shelf pointer, which was None), so every
    catch-all scale_events row landed with ``session_id=NULL``. The sweeper
    then couldn't correlate it to the closed session and left the event
    stranded in the deferred-to-close-hook loop. Fix is to pick the pointer
    based on the resolved shelf_id.

    This test sets both pointers to distinct session_ids and asserts the
    catch-all event picks the catch-all one.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path, catch_all_enabled=True)

    # Seed two independent open sessions — one per shelf — then stamp the
    # app_state pointers so the two branches are unambiguously distinct.
    live_sess = storage_repo.open_session(
        conn, "2026-04-18T07:59:50.000Z", 0.0, shelf_id="live_shelf",
    )
    catch_sess = storage_repo.open_session(
        conn, "2026-04-18T07:59:55.000Z", 0.0, shelf_id="catch_all",
    )
    # open_session overwrites current_session_id each call; re-seat both.
    conn.execute(
        "UPDATE app_state SET current_session_id = ?, "
        "current_catch_all_session_id = ? WHERE id = 1",
        (live_sess.session_id, catch_sess.session_id),
    )
    conn.commit()

    # Catch-all event — must pick the catch-all pointer.
    resp, status = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:00.100Z",
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status == 200, (resp, status)
    row = conn.execute(
        "SELECT shelf_id, session_id FROM scale_events WHERE event_id = ?",
        (resp["event_id"],),
    ).fetchone()
    assert row[0] == "catch_all"
    assert row[1] == catch_sess.session_id, (
        f"Catch-all event linked to session_id={row[1]!r}; expected the "
        f"catch-all session {catch_sess.session_id!r}, NOT the live-shelf "
        f"session {live_sess.session_id!r}"
    )

    # Live-shelf event on the same handler must still pick the live-shelf
    # pointer — regression guard so the conditional doesn't cross-wire the
    # two paths.
    resp2, status2 = handler.handle_scale_event({
        "ts": "2026-04-18T08:00:01.100Z",
        "device_id": "scale-01",
        "event_seq": 2,
        "delta_g": 120.0,
        "before_weight_g": 0.0,
        "after_weight_g": 120.0,
    })
    assert status2 == 200
    row2 = conn.execute(
        "SELECT shelf_id, session_id FROM scale_events WHERE event_id = ?",
        (resp2["event_id"],),
    ).fetchone()
    assert row2[0] == "live_shelf"
    assert row2[1] == live_sess.session_id


def test_live_shelf_mint_still_writes_shelf_id_live_shelf(tmp_path):
    """**2026-04-27 (decisions.md #42):** apply path no longer mints
    lots. With NO existing lot for the product, the apply-path picker
    returns None and the call is a no-op (warning logged). Test the
    default shelf_id path with an existing live_shelf lot — the
    revive must preserve the lot's existing shelf_id.
    """
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
    from datetime import datetime, timezone
    now_iso = datetime.now(tz=timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status="out",
            current_weight_g=0.0,
            initial_weight_g=300.0,
            total_consumed_g=300.0,
            last_out_at=now_iso,
            shelf_id="live_shelf",
        ),
    )

    event_ts = now_iso
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
                "product_id": product.product_id,
                "expected_weight_g": 300.0,
                "why_candidate": "recently_out",
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
