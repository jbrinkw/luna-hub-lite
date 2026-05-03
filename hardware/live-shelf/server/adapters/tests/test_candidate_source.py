"""Adapter tests for ``RepoCandidateSource`` Tier-2 catch-all widening.

Validates the new ``get_catch_all_user_inventory_lots`` method that
backs the catch-all auto-import flow. The widened pool covers every
``cloud_lots`` row with qty>0 for the user — certified or not — so an
uncertified product placed on the catch-all scale can still be picked
by the classifier and gain its tare via AI estimation on first
measurement.

The legacy ``get_catch_all_inventory_lots`` (certified-only,
not-on-any-shelf) stays untouched — the auto-import flow opts in to
the wider source explicitly.
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
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


@pytest.fixture
def conn(tmp_path):
    return init_db(str(tmp_path / "pi.sqlite3"))


@pytest.fixture
def db_lock():
    return threading.RLock()


def _seed_product(
    conn,
    product_id: str,
    *,
    certified: int = 1,
    name: str | None = None,
):
    storage_repo.create_product(
        conn,
        ProductIn(
            barcode=f"hrn-{product_id}",
            name=name or f"Product {product_id}",
            net_weight_g=500.0,
            gross_weight_g=525.0,
            tare_weight_g=25.0,
            unit_type="liquid",
            container_type="bottle",
            certified=certified,
        ),
    )
    with conn:
        conn.execute(
            "UPDATE products SET product_id = ? WHERE barcode = ?",
            (product_id, f"hrn-{product_id}"),
        )


def _seed_cloud_lot(
    conn,
    *,
    lot_id: str,
    product_id: str,
    qty: float = 0.5,
    in_flight_kind=None,
    pickup_event_id=None,
    created_at: str = "2026-04-27T00:00:00Z",
    in_flight_since=None,
):
    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers,
                in_flight_kind, pickup_event_id, in_flight_since,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lot_id,
                product_id,
                qty,
                in_flight_kind,
                pickup_event_id,
                in_flight_since,
                created_at,
                "2026-04-27T00:00:00Z",
            ),
        )


def test_get_catch_all_user_inventory_lots_returns_all_qty_gt_zero(
    conn, db_lock, tmp_path
):
    """Tier 2 of the catch-all auto-import: every cloud_lots row qty>0
    for the user, regardless of certification status. Ordered FEFO
    (oldest created_at first).
    """
    # Seed: certified product + uncertified product, both with qty>0.
    _seed_product(conn, "p-cert", certified=1, name="Olive Oil")
    _seed_product(conn, "p-uncert", certified=0, name="Pasta Box")
    _seed_cloud_lot(
        conn,
        lot_id="lot-cert",
        product_id="p-cert",
        qty=2.0,
        created_at="2026-05-01T00:00:00Z",
    )
    _seed_cloud_lot(
        conn,
        lot_id="lot-uncert",
        product_id="p-uncert",
        qty=1.0,
        created_at="2026-05-02T00:00:00Z",
    )
    # Decoy: a depleted lot — must NOT appear.
    _seed_product(conn, "p-empty", certified=1, name="Empty")
    _seed_cloud_lot(
        conn,
        lot_id="lot-empty",
        product_id="p-empty",
        qty=0.0,
        created_at="2026-04-01T00:00:00Z",
    )
    # Decoy: an in-flight catch-all lot — Tier 1 owns this; widening
    # Tier 2 must NOT double-count it.
    _seed_product(conn, "p-iflight", certified=1, name="Mid-measure")
    _seed_cloud_lot(
        conn,
        lot_id="lot-iflight",
        product_id="p-iflight",
        qty=1.0,
        in_flight_kind="catch_all",
        in_flight_since="2026-04-15T00:00:00Z",
        created_at="2026-04-15T00:00:00Z",
    )

    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    src = RepoCandidateSource(conn, refs_root, db_lock=db_lock)
    out = src.get_catch_all_user_inventory_lots()
    ids = [c.product_id for c in out]

    # Both certified + uncertified appear; depleted + in-flight don't.
    assert "p-cert" in ids
    assert "p-uncert" in ids
    assert "p-empty" not in ids
    assert "p-iflight" not in ids
    # FEFO: oldest created_at first.
    assert ids.index("p-cert") < ids.index("p-uncert")


def test_get_catch_all_user_inventory_lots_excludes_live_shelf_in_flight_passthrough(
    conn, db_lock, tmp_path
):
    """A live_shelf in-flight lot is not Tier-1 catch-all but still
    has stock; per task spec only catch_all in-flight is excluded.
    Live-shelf in-flight lots SHOULD pass through (they're real
    inventory; the apply path will route correctly via lot_id).
    """
    _seed_product(conn, "p-live", certified=1, name="Live Shelf")
    _seed_cloud_lot(
        conn,
        lot_id="lot-live",
        product_id="p-live",
        qty=1.0,
        in_flight_kind="live_shelf",
        in_flight_since="2026-04-27T10:00:00Z",
        created_at="2026-04-27T00:00:00Z",
    )

    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    src = RepoCandidateSource(conn, refs_root, db_lock=db_lock)
    out = src.get_catch_all_user_inventory_lots()
    ids = [c.product_id for c in out]

    # Only catch_all in-flight is excluded. live_shelf in-flight stays.
    assert "p-live" in ids


def test_get_catch_all_user_inventory_lots_returns_lot_candidates_with_status_out(
    conn, db_lock, tmp_path
):
    """Output shape: every entry is a LotCandidate with status='out'
    (the closest sentinel for "off-shelf inventory" — the apply path
    routes by lot_id, status is cosmetic for tier ranking).
    """
    _seed_product(conn, "p1", certified=0, name="Uncertified")
    _seed_cloud_lot(
        conn,
        lot_id="lot1",
        product_id="p1",
        qty=1.0,
    )

    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    src = RepoCandidateSource(conn, refs_root, db_lock=db_lock)
    out = list(src.get_catch_all_user_inventory_lots())

    assert len(out) == 1
    cand = out[0]
    assert cand.lot_id == "lot1"
    assert cand.product_id == "p1"
    assert cand.name == "Uncertified"
    assert cand.status == "out"
    # Prefer gross over net for full container weight.
    assert cand.expected_weight_g == 525.0
