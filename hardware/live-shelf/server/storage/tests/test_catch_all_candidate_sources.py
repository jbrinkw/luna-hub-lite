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


def test_certified_not_on_shelf_excludes_catch_all_in_flight(conn):
    """**2026-04-28 (Codex finding MEDIUM-5):** Tier 1
    (``list_cloud_in_flight_catch_all_lots``) already exposes every lot
    with ``in_flight_kind='catch_all'``. Tier 2 must therefore EXCLUDE
    those rows so the two tiers are strictly disjoint at the source —
    no lot appears in both, so the post-concat dedupe never has work
    to do under normal operation.

    Mutation guard: reverting the source query to
    ``in_flight_kind IS NULL OR 'catch_all'`` lets the row leak back
    into Tier 2 — this assertion catches it.
    """
    _seed_product(conn, "P")
    _seed_cloud_lot(
        conn, lot_id="L", product_id="P",
        in_flight_kind="catch_all",
        in_flight_since="2026-04-27T10:00:00Z",
    )

    rows = storage_repo.list_certified_not_on_shelf_lots_by_oldest_created(conn)
    assert [r[0] for r in rows] == [], (
        "catch_all in-flight rows belong to Tier 1 only; Tier 2 must "
        "stay disjoint"
    )


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


# ----------------------------------------------------------------------
# Two-pass catch-all classification (2026-05-03):
#   list_user_inventory_lots_qty_gt_zero_certified
#   list_user_inventory_lots_qty_gt_zero_uncertified
# ----------------------------------------------------------------------


def test_user_inventory_certified_excludes_uncertified_products(conn):
    """The certified variant returns ONLY lots whose product has certified=1."""
    _seed_product(conn, "P_CERT", certified=1)
    _seed_product(conn, "P_UNCERT", certified=0)
    _seed_cloud_lot(conn, lot_id="L_CERT", product_id="P_CERT")
    _seed_cloud_lot(conn, lot_id="L_UNCERT", product_id="P_UNCERT")

    rows = storage_repo.list_user_inventory_lots_qty_gt_zero_certified(conn)
    ids = [r[0] for r in rows]
    assert "L_CERT" in ids
    assert "L_UNCERT" not in ids, (
        "list_user_inventory_lots_qty_gt_zero_certified must NOT return "
        "lots whose product is uncertified"
    )


def test_user_inventory_uncertified_excludes_certified_products(conn):
    """The uncertified variant returns ONLY lots whose product is NOT certified."""
    _seed_product(conn, "P_CERT", certified=1)
    _seed_product(conn, "P_UNCERT", certified=0)
    _seed_cloud_lot(conn, lot_id="L_CERT", product_id="P_CERT")
    _seed_cloud_lot(conn, lot_id="L_UNCERT", product_id="P_UNCERT")

    rows = storage_repo.list_user_inventory_lots_qty_gt_zero_uncertified(conn)
    ids = [r[0] for r in rows]
    assert "L_UNCERT" in ids
    assert "L_CERT" not in ids, (
        "list_user_inventory_lots_qty_gt_zero_uncertified must NOT return "
        "lots whose product is certified"
    )


def test_user_inventory_uncertified_predicate_is_null_safe(conn):
    """NULL ``products.certified`` is treated as uncertified.

    Defense-in-depth against future migrations that NULL out the
    ``certified`` column. The schema's NOT NULL constraint prevents us
    from inserting a NULL through the normal API; we exercise the NULL
    branch by dropping and re-creating the column without the
    constraint, then writing a NULL row.

    Why the schema-mutate trick (audit D-LOW-2 clarification, 2026-05-04):
        SQLite has no PRAGMA to disable NOT NULL constraints, and
        ``sqlite3`` re-validates ``NOT NULL`` on every UPDATE — so a raw
        ``UPDATE products SET certified = NULL`` against the production
        schema would raise. Three options exist:

          (a) Initialise the test's connection with a custom schema that
              allows NULL on ``certified`` for THIS test only — adds an
              entire fixture branch and obscures the mutation guard
              the test is designed to expose.
          (b) Use a temporary attached database — requires a second DB
              file lifecycle on tmpfs and breaks the conn fixture
              contract.
          (c) Use the schema-rebuild trick (DROP COLUMN + ADD COLUMN
              without NOT NULL) — keeps the test self-contained and
              localised to the rows it needs to mutate.

        We picked (c). The trade-off: the trick depends on the column's
        name being ``certified`` and stays brittle if a future migration
        renames it. We assert the rebuild landed correctly so a
        rename-without-migrating-this-test fails LOUDLY (with a clear
        assertion message) instead of cryptically (a NULL that quietly
        becomes 0 on the rebuilt column).

    Mutation guard: dropping the ``IS NULL`` clause from the
    uncertified query (e.g. ``WHERE p.certified = 0``) makes the
    NULL-row L_NULL silently disappear from the result, failing the
    membership assertion.
    """
    _seed_product(conn, "P_NULLCERT", certified=0)
    # Bypass the NOT NULL constraint via the schema-rebuild trick —
    # see the docstring above for the rationale. SQLite's
    # ``sqlite3`` driver lets us disable foreign keys but not NOT
    # NULL, so this is the cleanest in-test workaround.
    with conn:
        conn.execute("ALTER TABLE products RENAME COLUMN certified TO _old_cert")
        conn.execute("ALTER TABLE products ADD COLUMN certified INTEGER")
        conn.execute("UPDATE products SET certified = _old_cert")
        conn.execute(
            "UPDATE products SET certified = NULL WHERE product_id = ?",
            ("P_NULLCERT",),
        )
    # Schema-mutate landing assertion: confirms the ALTER actually
    # produced a nullable ``certified`` column. A future migration that
    # renames the column or adds a CHECK constraint would silently
    # break the rebuild trick — this assertion catches that with a
    # clear message instead of a cryptic test failure downstream.
    cols = {row[1]: row[3] for row in conn.execute("PRAGMA table_info(products)")}
    assert "certified" in cols, (
        "schema-rebuild trick failed: ``certified`` column is missing "
        "after ADD COLUMN. A future migration probably renamed it — "
        "update this test's column-rebuild block to match the new name "
        "or rework the test to use a custom schema fixture."
    )
    assert cols["certified"] == 0, (
        "schema-rebuild trick failed: ``certified`` column is NOT NULL "
        "after rebuild (PRAGMA table_info notnull=1). The ADD COLUMN "
        "INTEGER (without NOT NULL) should have produced a nullable "
        "column. Inspect the schema ALTER block above."
    )
    # Confirm the NULL actually landed for the row we want to test.
    null_count = conn.execute(
        "SELECT COUNT(*) FROM products "
        "WHERE product_id = ? AND certified IS NULL",
        ("P_NULLCERT",),
    ).fetchone()[0]
    assert null_count == 1, (
        "schema-rebuild trick failed: the row we tried to NULL out is "
        "not actually NULL after the UPDATE. The rebuild may have "
        "back-filled defaults — re-inspect the ALTER sequence."
    )

    _seed_cloud_lot(conn, lot_id="L_NULL", product_id="P_NULLCERT")

    rows = storage_repo.list_user_inventory_lots_qty_gt_zero_uncertified(conn)
    ids = [r[0] for r in rows]
    assert "L_NULL" in ids, (
        "NULL certified must be treated as uncertified — the predicate "
        "uses (certified IS NULL OR certified = 0)"
    )

    rows = storage_repo.list_user_inventory_lots_qty_gt_zero_certified(conn)
    ids = [r[0] for r in rows]
    assert "L_NULL" not in ids, (
        "NULL certified must NOT count as certified"
    )


def test_user_inventory_certified_split_excludes_in_flight_catch_all(conn):
    """Both variants exclude in_flight_kind='catch_all' (Tier 1's territory)."""
    _seed_product(conn, "P_C", certified=1)
    _seed_product(conn, "P_U", certified=0)
    _seed_cloud_lot(
        conn, lot_id="L_C_IF", product_id="P_C",
        in_flight_kind="catch_all", in_flight_since="2026-04-27T10:00Z",
    )
    _seed_cloud_lot(
        conn, lot_id="L_U_IF", product_id="P_U",
        in_flight_kind="catch_all", in_flight_since="2026-04-27T10:00Z",
    )

    cert = [r[0] for r in
            storage_repo.list_user_inventory_lots_qty_gt_zero_certified(conn)]
    uncert = [r[0] for r in
              storage_repo.list_user_inventory_lots_qty_gt_zero_uncertified(conn)]
    assert "L_C_IF" not in cert, (
        "in_flight_kind='catch_all' is owned by Tier 1; certified split "
        "must exclude it to keep tiers disjoint"
    )
    assert "L_U_IF" not in uncert


def test_user_inventory_certified_split_excludes_zero_qty(conn):
    """Both variants share the qty>0 invariant from the parent helper."""
    _seed_product(conn, "P_C", certified=1)
    _seed_product(conn, "P_U", certified=0)
    _seed_cloud_lot(conn, lot_id="L_C_EMPTY", product_id="P_C", qty=0.0)
    _seed_cloud_lot(conn, lot_id="L_U_EMPTY", product_id="P_U", qty=0.0)

    assert storage_repo.list_user_inventory_lots_qty_gt_zero_certified(conn) == []
    assert storage_repo.list_user_inventory_lots_qty_gt_zero_uncertified(conn) == []


def test_user_inventory_certified_split_returns_extended_tuple_shape(conn):
    """Both variants return the 12-column shape (with tare_weight_g appended).

    The adapter unpacks 12 columns; if the SELECT list ever drifts, the
    adapter ValueError is louder than a silent misread.
    """
    _seed_product(conn, "P_C", certified=1)
    _seed_cloud_lot(conn, lot_id="L_C", product_id="P_C")
    rows = storage_repo.list_user_inventory_lots_qty_gt_zero_certified(conn)
    assert len(rows) == 1
    assert len(rows[0]) == 12, (
        f"expected 12-column tuple shape, got {len(rows[0])} columns"
    )
