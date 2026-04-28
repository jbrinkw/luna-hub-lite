"""Catch-all candidate source repo helpers — schema + ordering tests.

Validates the helpers added in ``server/storage/repo.py`` for the
catch-all delta-capture pool:

  * ``list_cloud_in_flight_catch_all_lots`` — Tier 1 source.
  * ``list_certified_not_on_shelf_lots_by_oldest_created`` — Tier 2.

Both helpers query ``cloud_lots`` joined to ``products``. The Tier 2
helper additionally excludes products with any Pi-local ``lots`` row
and lots referenced by ``scale_pairings.lot_id``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


@pytest.fixture
def conn(tmp_path):
    return init_db(str(tmp_path / "pi.sqlite3"))


def _seed_product(conn, product_id: str, *, certified: int = 1):
    storage_repo.create_product(
        conn,
        ProductIn(
            barcode=f"hrn-{product_id}",
            name=f"Product {product_id}",
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
    conn, *, lot_id: str, product_id: str,
    qty: float = 0.5, in_flight_kind=None,
    pickup_event_id=None, created_at: str = "2026-04-27T00:00:00Z",
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
                lot_id, product_id, qty,
                in_flight_kind, pickup_event_id, in_flight_since,
                created_at, "2026-04-27T00:00:00Z",
            ),
        )


# ----------------------------------------------------------------------
# Tier 1 — list_cloud_in_flight_catch_all_lots
# ----------------------------------------------------------------------


def test_in_flight_catch_all_only_returns_catch_all_kind(conn):
    _seed_product(conn, "P1")
    _seed_product(conn, "P2")
    _seed_cloud_lot(
        conn, lot_id="L1", product_id="P1",
        in_flight_kind="catch_all",
        in_flight_since="2026-04-27T10:00:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="L2", product_id="P2",
        in_flight_kind="live_shelf",
        in_flight_since="2026-04-27T10:00:00Z",
    )

    rows = storage_repo.list_cloud_in_flight_catch_all_lots(conn)
    ids = [r[0] for r in rows]
    assert ids == ["L1"]
    assert "L2" not in ids


def test_in_flight_catch_all_orders_oldest_first(conn):
    _seed_product(conn, "P")
    _seed_cloud_lot(
        conn, lot_id="L_NEW", product_id="P",
        in_flight_kind="catch_all",
        in_flight_since="2026-04-27T11:00:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="L_OLD", product_id="P",
        in_flight_kind="catch_all",
        in_flight_since="2026-04-27T08:00:00Z",
    )

    rows = storage_repo.list_cloud_in_flight_catch_all_lots(conn)
    assert [r[0] for r in rows] == ["L_OLD", "L_NEW"]


def test_in_flight_catch_all_excludes_tombstoned(conn):
    _seed_product(conn, "P")
    _seed_cloud_lot(
        conn, lot_id="L", product_id="P",
        in_flight_kind="catch_all",
        in_flight_since="2026-04-27T10:00:00Z",
    )
    with conn:
        conn.execute(
            "UPDATE cloud_lots SET deleted_at = ? WHERE lot_id = ?",
            ("2026-04-27T12:00:00Z", "L"),
        )
    assert storage_repo.list_cloud_in_flight_catch_all_lots(conn) == []


# ----------------------------------------------------------------------
# Tier 2 — list_certified_not_on_shelf_lots_by_oldest_created
# ----------------------------------------------------------------------


def test_certified_not_on_shelf_returns_lot_level_rows(conn):
    """Two cloud lots of the same product → two rows (lot-level)."""
    _seed_product(conn, "P1")
    _seed_cloud_lot(
        conn, lot_id="L1", product_id="P1",
        created_at="2026-04-25T00:00:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="L2", product_id="P1",
        created_at="2026-04-26T00:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    assert "L1" in ids
    assert "L2" in ids


def test_certified_not_on_shelf_orders_by_created_at_asc(conn):
    """FEFO on import time — oldest created_at first."""
    _seed_product(conn, "P")
    _seed_cloud_lot(
        conn, lot_id="L_NEW", product_id="P",
        created_at="2026-04-26T12:00:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="L_OLD", product_id="P",
        created_at="2026-04-25T08:00:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="L_MID", product_id="P",
        created_at="2026-04-26T00:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    assert ids.index("L_OLD") < ids.index("L_MID") < ids.index("L_NEW")


def test_certified_not_on_shelf_excludes_uncertified(conn):
    _seed_product(conn, "P_CERT", certified=1)
    _seed_product(conn, "P_UNCERT", certified=0)
    _seed_cloud_lot(conn, lot_id="L1", product_id="P_CERT")
    _seed_cloud_lot(conn, lot_id="L2", product_id="P_UNCERT")

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    assert "L1" in ids
    assert "L2" not in ids


def test_certified_not_on_shelf_excludes_products_with_pi_lots(conn):
    """Product with ANY Pi-local lots row → excluded."""
    _seed_product(conn, "P_ON_SHELF")
    _seed_product(conn, "P_OFF_SHELF")
    _seed_cloud_lot(conn, lot_id="L1", product_id="P_ON_SHELF")
    _seed_cloud_lot(conn, lot_id="L2", product_id="P_OFF_SHELF")
    storage_repo.create_lot(
        conn,
        LotIn(
            product_id="P_ON_SHELF",
            status="on_shelf",
            current_weight_g=400.0,
            initial_weight_g=400.0,
            shelf_id="live_shelf",
        ),
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    assert "L2" in ids
    assert "L1" not in ids


def test_certified_not_on_shelf_excludes_zero_qty(conn):
    _seed_product(conn, "P")
    _seed_cloud_lot(conn, lot_id="L_FULL", product_id="P", qty=0.5)
    _seed_cloud_lot(
        conn, lot_id="L_EMPTY", product_id="P", qty=0.0,
        created_at="2026-04-27T01:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    assert "L_FULL" in ids
    assert "L_EMPTY" not in ids


def test_certified_not_on_shelf_excludes_live_shelf_in_flight(conn):
    """A lot currently in-flight on live_shelf must not appear in
    catch-all candidates — it belongs to a different state machine.
    """
    _seed_product(conn, "P")
    _seed_cloud_lot(
        conn, lot_id="L_LIVE", product_id="P",
        in_flight_kind="live_shelf",
        in_flight_since="2026-04-27T10:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    assert [r[0] for r in rows] == []


def test_certified_not_on_shelf_includes_catch_all_in_flight_too(conn):
    """A lot already in-flight on catch_all is still a valid candidate
    — picking it triggers the SECOND-event branch, not the first.
    """
    _seed_product(conn, "P")
    _seed_cloud_lot(
        conn, lot_id="L", product_id="P",
        in_flight_kind="catch_all",
        in_flight_since="2026-04-27T10:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    assert [r[0] for r in rows] == ["L"]


def test_certified_not_on_shelf_excludes_pi_local_lot_holders(conn):
    """A product with ANY Pi-local lots row (LiveTrack-paired or
    live_shelf-tracked) is excluded — the "no Pi-local lot" rule
    implicitly covers the user's "no scale_pairings.lot_id reference"
    requirement, because scale_pairings.lot_id references lots(lot_id)
    so a paired lot is by construction also a Pi-local lot.
    """
    _seed_product(conn, "P_PI_LOCAL")
    _seed_product(conn, "P_FREE")
    _seed_cloud_lot(conn, lot_id="L_PI_LOCAL", product_id="P_PI_LOCAL")
    _seed_cloud_lot(conn, lot_id="L_FREE", product_id="P_FREE")
    storage_repo.create_lot(
        conn,
        LotIn(
            product_id="P_PI_LOCAL",
            status="on_shelf",
            current_weight_g=400.0,
            initial_weight_g=400.0,
            shelf_id="single_item",  # LiveTrack-paired single-item slot
        ),
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    assert "L_FREE" in ids
    assert "L_PI_LOCAL" not in ids


def test_certified_not_on_shelf_null_created_at_sorts_last(conn):
    """Legacy rows without created_at fall to the back (so a properly
    timestamped lot always wins FEFO)."""
    _seed_product(conn, "P")
    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers, updated_at
            ) VALUES (?, ?, ?, ?)
            """,
            ("L_LEGACY", "P", 0.5, "2026-04-27T00:00:00Z"),
        )
    _seed_cloud_lot(
        conn, lot_id="L_NEW", product_id="P",
        created_at="2026-04-27T10:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    ids = [r[0] for r in rows]
    # NEW (timestamped) sorts first; LEGACY (NULL created_at) last.
    assert ids.index("L_NEW") < ids.index("L_LEGACY")
