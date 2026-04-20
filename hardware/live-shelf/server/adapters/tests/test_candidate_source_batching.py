"""Audit finding H4: ``RepoCandidateSource.get_in_flight_lots`` used to
loop ``storage_repo.get_product()`` once per in-flight lot INSIDE the
held DB lock — an N+1 SELECT hot path that scales linearly with pool
size. This test locks the fix in place: the products are batch-fetched
in a single SELECT regardless of how many lots are in-flight.

Strategy: wrap the connection in a proxy that counts every
``execute(SELECT * FROM products ...)`` call. Seed N > 2 lots and
assert the product-SELECT count is ≤ 2 (the single IN-batch query; ≤2
is the ceiling because an implementation that also issues a lookup
for an empty-id shouldn't regress, but the realistic count is 1).
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


class _CountingConn:
    """Passthrough wrapper counting product-table SELECTs.

    All other attributes/methods proxy to the real connection — only
    ``execute()`` is intercepted so we can tally product queries.
    """

    def __init__(self, inner):
        self._inner = inner
        self.product_select_count = 0

    def execute(self, sql, params=()):
        # Heuristic — the batch helper + single-row helper both SELECT
        # from the ``products`` table. Any query hitting that table
        # counts.
        stripped = sql.lstrip().lower()
        if stripped.startswith("select") and "from products" in stripped:
            self.product_select_count += 1
        return self._inner.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def _seed_n_in_flight(conn, n: int) -> list[str]:
    """Create N distinct products + N in-flight lots. Returns lot_ids."""
    lot_ids: list[str] = []
    for i in range(n):
        p = storage_repo.create_product(
            conn,
            ProductIn(
                name=f"Prod {i}",
                barcode=f"bc-{i}",
                net_weight_g=100.0 + i,
                gross_weight_g=120.0 + i,
                unit_type="solid",
                container_type="tub",
                certified=1,
            ),
        )
        lot = storage_repo.create_lot(
            conn,
            LotIn(
                product_id=p.product_id,
                status="on_shelf",
                current_weight_g=120.0 + i,
                initial_weight_g=120.0 + i,
                shelf_id="live_shelf",
            ),
        )
        storage_repo.mark_lot_in_flight(
            conn,
            lot.lot_id,
            pickup_weight_g=120.0 + i,
            pickup_event_id="",
            pickup_session_id=None,
            in_flight_since=f"2026-04-17T10:{i:02d}:00.000Z",
        )
        lot_ids.append(lot.lot_id)
    return lot_ids


def test_get_in_flight_lots_single_round_trip(tmp_path):
    """H4: hydrating N in-flight lots must issue exactly ONE products
    SELECT — not one per lot. Regression fixture for the N+1 inside the
    held DB lock."""
    conn = init_db(":memory:")
    n = 5
    seeded = _seed_n_in_flight(conn, n)

    counting = _CountingConn(conn)
    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    src = RepoCandidateSource(
        counting, refs_root, db_lock=threading.RLock()
    )

    # Reset counter AFTER seed — the seeding path doesn't go through
    # the adapter, but we want to count only the adapter's queries.
    counting.product_select_count = 0

    lots = src.get_in_flight_lots()
    # Sanity: all N lots came through with their product joined in.
    assert len(lots) == n
    assert {lot.lot_id for lot in lots} == set(seeded)

    # The fix: one batched SELECT. Allow up to 2 to accommodate a
    # future defensive refetch or zero-id early-out, but explicitly
    # forbid the old N-per-lot behavior.
    assert counting.product_select_count <= 2, (
        f"get_in_flight_lots issued {counting.product_select_count} "
        f"product SELECTs for {n} lots — N+1 regression. The batched "
        "get_products_by_ids helper must be used instead."
    )


def test_get_in_flight_lots_empty_does_not_query_products(tmp_path):
    """Edge: with zero in-flight lots the batch helper should short-circuit
    without issuing a products SELECT at all."""
    conn = init_db(":memory:")
    counting = _CountingConn(conn)
    refs_root = tmp_path / "refs"
    refs_root.mkdir()
    src = RepoCandidateSource(
        counting, refs_root, db_lock=threading.RLock()
    )
    counting.product_select_count = 0

    lots = src.get_in_flight_lots()
    assert lots == [] or list(lots) == []
    assert counting.product_select_count == 0, (
        "empty in-flight set should not hit the products table"
    )


def test_get_products_by_ids_dedupes_and_returns_dict():
    """Unit-level contract for the batch helper itself — so the
    candidate-source layer can rely on it."""
    conn = init_db(":memory:")
    p1 = storage_repo.create_product(
        conn,
        ProductIn(
            name="P1", barcode="b1", net_weight_g=100.0,
            gross_weight_g=100.0, unit_type="solid",
            container_type="tub", certified=1,
        ),
    )
    p2 = storage_repo.create_product(
        conn,
        ProductIn(
            name="P2", barcode="b2", net_weight_g=200.0,
            gross_weight_g=200.0, unit_type="solid",
            container_type="tub", certified=1,
        ),
    )

    # Duplicated ids + a non-existent id — dict keyed by product_id,
    # missing ids absent, dupes collapsed.
    result = storage_repo.get_products_by_ids(
        conn,
        [p1.product_id, p2.product_id, p1.product_id, "missing-id"],
    )
    assert set(result.keys()) == {p1.product_id, p2.product_id}
    assert result[p1.product_id].name == "P1"
    assert result[p2.product_id].name == "P2"


def test_get_products_by_ids_empty_is_noop():
    conn = init_db(":memory:")
    # Must not raise or issue a query.
    assert storage_repo.get_products_by_ids(conn, []) == {}
