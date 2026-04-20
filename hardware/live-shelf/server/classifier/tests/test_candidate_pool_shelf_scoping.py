"""Shelf-scoping tests for the classifier candidate pool.

CATCH_ALL_SCALE_PLAN.md §5.2: when the classifier runs for a catch-all
event, its candidate pool must NOT include live-shelf lots (and vice
versa). The catalog branch (:meth:`CandidateSource.get_certified_not_on_shelf`)
is shared across shelves intentionally and is not tested here.

The shelf filter is threaded via ``ClassifierContext.shelf_id`` and
propagated to the ``CandidateSource`` methods in ``candidate_pool.py``.
This test uses the real DB-backed ``RepoCandidateSource`` + repo so the
integration picks up both the SQL filter and the dataclass plumbing.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.candidate_source import RepoCandidateSource  # noqa: E402
from server.classifier.candidate_pool import (  # noqa: E402
    pool_for_add,
    pool_for_remove,
)
from server.classifier.models import ClassifierContext  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


def _seed_two_shelves(conn):
    """Seed one live_shelf on-shelf lot and one catch_all on-shelf lot."""
    live_product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Live Product",
            barcode="live-1",
            net_weight_g=300.0,
            gross_weight_g=300.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    catch_product = storage_repo.create_product(
        conn,
        ProductIn(
            name="Catch Product",
            barcode="catch-1",
            net_weight_g=150.0,
            gross_weight_g=150.0,
            unit_type="solid",
            container_type="tray",
            certified=1,
        ),
    )
    live_lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=live_product.product_id,
            status="on_shelf",
            current_weight_g=300.0,
            initial_weight_g=300.0,
            shelf_id="live_shelf",
        ),
    )
    catch_lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=catch_product.product_id,
            status="on_shelf",
            current_weight_g=150.0,
            initial_weight_g=150.0,
            shelf_id="catch_all",
        ),
    )
    return live_lot, catch_lot


def _ctx(conn, tmp_path, shelf_id):
    refs_root = tmp_path / "refs"
    refs_root.mkdir(exist_ok=True)
    source = RepoCandidateSource(
        conn, refs_root, db_lock=threading.RLock()
    )
    return ClassifierContext(source=source, shelf_id=shelf_id)


def test_remove_pool_catch_all_excludes_live_shelf_lots(tmp_path):
    conn = init_db(":memory:")
    live_lot, catch_lot = _seed_two_shelves(conn)

    ctx = _ctx(conn, tmp_path, shelf_id="catch_all")
    pool = pool_for_remove(-150.0, ctx)

    pool_ids = {c.candidate_id for c in pool}
    assert catch_lot.lot_id in pool_ids, (
        "REMOVE pool for catch_all must include catch_all on-shelf lots"
    )
    assert live_lot.lot_id not in pool_ids, (
        "REMOVE pool scoped to catch_all leaked a live_shelf lot"
    )


def test_remove_pool_live_shelf_excludes_catch_all_lots(tmp_path):
    conn = init_db(":memory:")
    live_lot, catch_lot = _seed_two_shelves(conn)

    ctx = _ctx(conn, tmp_path, shelf_id="live_shelf")
    pool = pool_for_remove(-300.0, ctx)

    pool_ids = {c.candidate_id for c in pool}
    assert live_lot.lot_id in pool_ids
    assert catch_lot.lot_id not in pool_ids


def test_candidate_pool_scoped_to_shelf_excludes_other_shelves(tmp_path):
    """Plan §5.2 primary case: catch-all REMOVE pool sees only catch-all
    lots, even when a live_shelf in-flight lot exists and has the same
    expected weight (so the ranker can't filter it out by weight)."""
    conn = init_db(":memory:")
    live_lot, catch_lot = _seed_two_shelves(conn)

    # Flip the live lot to in_flight so pool_for_add would also consider
    # it. The REMOVE pool still reads from on_shelf only.
    storage_repo.mark_lot_in_flight(
        conn,
        live_lot.lot_id,
        pickup_weight_g=300.0,
        pickup_event_id="",
        pickup_session_id=None,
        in_flight_since="2026-04-17T10:00:00.000Z",
    )

    ctx = _ctx(conn, tmp_path, shelf_id="catch_all")

    # ADD pool on the catch-all: in-flight branch must NOT surface the
    # live_shelf lot even though its weight matches the delta.
    add_pool = pool_for_add(300.0, ctx)
    add_ids = {c.candidate_id for c in add_pool}
    assert live_lot.lot_id not in add_ids, (
        "ADD pool scoped to catch_all leaked a live_shelf in_flight lot"
    )

    # REMOVE pool on the catch-all: only the catch-all on-shelf lot.
    rem_pool = pool_for_remove(-150.0, ctx)
    rem_ids = {c.candidate_id for c in rem_pool}
    assert catch_lot.lot_id in rem_ids
    assert live_lot.lot_id not in rem_ids


def test_unspecified_shelf_id_is_backward_compatible(tmp_path):
    """When ``ClassifierContext.shelf_id`` is None, pool returns lots from
    both shelves — exactly the pre-catch-all behavior."""
    conn = init_db(":memory:")
    live_lot, catch_lot = _seed_two_shelves(conn)

    ctx = _ctx(conn, tmp_path, shelf_id=None)
    pool = pool_for_remove(-200.0, ctx)
    pool_ids = {c.candidate_id for c in pool}
    # Both shelves' on-shelf lots visible to the unscoped pool.
    assert live_lot.lot_id in pool_ids
    assert catch_lot.lot_id in pool_ids
