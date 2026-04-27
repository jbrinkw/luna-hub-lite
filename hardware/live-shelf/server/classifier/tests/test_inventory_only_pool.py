"""Regression tests for the ``inventory_only`` candidate-pool branch.

**Why this file exists:** commit ``3b99043`` (2026-04-27) restricted
the ADD pool to "products that already have at least one lot in
inventory." The implementation read the Pi-local ``lots`` table only,
which is empty until the user has physically placed a product on this
shelf at least once. Cloud inventory (``stock_lots``, mirrored to the
Pi as ``cloud_lots``) was invisible to the pool builder, so users who
intaked a product (creating a cloud stock_lot) but had not yet placed
it on the live-shelf saw an empty pool on the first place event — the
classifier got only the UNKNOWN sentinel and returned UNKNOWN. The
audits passed because the static prompt-purity contracts (no lot-level
keys in the prompt) did NOT exercise the candidate builder against
realistic cloud inventory.

The tests in this module:

1. **TestInventoryOnlyBranch (unit)** — uses a stub ``CandidateSource``
   that returns a list of ``ProductCandidate`` rows for the new
   ``get_inventory_only_products`` method. Asserts the pool surfaces
   them as ``why_candidate='inventory_only'`` candidates. Mutation
   guard: stripping the seeded inventory must drop the pool back to
   UNKNOWN-only.

2. **TestInventoryOnlyDbBacked (integration)** — uses the real
   :class:`RepoCandidateSource` + :class:`storage_repo` with cloud_lots
   rows seeded against the live SQLite migration set. This is the test
   the regression would have failed: it covers the production filter
   path end-to-end and would have caught the bug at deploy time.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Sequence

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.adapters.candidate_source import RepoCandidateSource  # noqa: E402
from server.classifier.candidate_pool import (  # noqa: E402
    pool_for_add,
    pool_for_remove,
)
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
)
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn  # noqa: E402


# --- Stub source ----------------------------------------------------------


class _InventoryOnlyStubSource:
    """Minimal :class:`CandidateSource` that ONLY supplies inventory_only.

    Other branches (in_flight, recently_out, on_shelf) return empty
    sequences. Test fixtures customise via constructor args.
    """

    def __init__(
        self,
        *,
        inventory_only: Sequence[ProductCandidate] = (),
    ) -> None:
        self._inventory_only = list(inventory_only)
        self.calls: list[tuple[str, tuple]] = []

    def get_on_shelf_lots(self, shelf_id: str | None = None) -> list[LotCandidate]:
        self.calls.append(("on_shelf", (shelf_id,)))
        return []

    def get_recently_out_lots(
        self, window_seconds: int, shelf_id: str | None = None,
    ) -> list[LotCandidate]:
        self.calls.append(("recently_out", (window_seconds, shelf_id)))
        return []

    def get_in_flight_lots(
        self,
        max_age_seconds: int | None = None,
        shelf_id: str | None = None,
    ) -> list[LotCandidate]:
        self.calls.append(("in_flight", (max_age_seconds, shelf_id)))
        return []

    def get_inventory_only_products(
        self, shelf_id: str | None = None,
    ) -> list[ProductCandidate]:
        self.calls.append(("inventory_only", (shelf_id,)))
        return list(self._inventory_only)

    def get_certified_not_on_shelf(self) -> list[ProductCandidate]:
        self.calls.append(("catalog", ()))
        return []


def _product(
    pid: str,
    *,
    name: str,
    weight: float,
    container: str | None = "bottle",
    refs: Sequence[str] = (),
) -> ProductCandidate:
    return ProductCandidate(
        product_id=pid,
        name=name,
        brand=None,
        expected_weight_g=weight,
        container_type=container,
        reference_image_paths=refs,
    )


# --- Unit tests against the stub -----------------------------------------


class TestInventoryOnlyBranch:
    def test_seeded_inventory_surfaces_as_inventory_only(self):
        """Three intaked-but-not-yet-on-shelf products → all three appear in pool.

        This is the user's exact scenario from the 2026-04-27 regression:
        Gatorade + chicken + parmesan all have cloud stock_lots, none are
        on the Pi shelf yet. ADD event must produce a pool with all three
        + the UNKNOWN sentinel, NOT UNKNOWN-only.
        """
        source = _InventoryOnlyStubSource(
            inventory_only=[
                _product("p_gat", name="Gatorade Frost", weight=900.0),
                _product("p_chk", name="Pulled Chicken", weight=600.0),
                _product("p_par", name="PARMESAN", weight=200.0),
            ],
        )
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_add(663.452, ctx)
        ids = [c.candidate_id for c in pool]
        # All three products must be present.
        assert "p_gat" in ids
        assert "p_chk" in ids
        assert "p_par" in ids
        # Sentinel last + present exactly once.
        assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID
        assert ids.count(UNKNOWN_CANDIDATE_ID) == 1
        # Real inventory candidates must be tagged ``inventory_only``,
        # NOT ``catalog_not_on_shelf`` (decision #45 dropped that branch).
        non_sentinel = [c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        assert all(c.why_candidate == "inventory_only" for c in non_sentinel)

    def test_empty_inventory_returns_unknown_only_pool(self):
        """Mutation guard: with NO inventory_only products, pool collapses to UNKNOWN.

        This is the smoking-gun case from the production regression:
        ``cloud_lots`` empty (or never queried) → empty inventory_only
        list → pool=[UNKNOWN]. Confirms the test would FAIL if the seed
        is removed — i.e. it actually exercises the inventory branch.
        """
        source = _InventoryOnlyStubSource(inventory_only=[])
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_add(663.452, ctx)
        assert len(pool) == 1
        assert pool[0].candidate_id == UNKNOWN_CANDIDATE_ID
        # Mutation evidence: the test asserts UNKNOWN-only ONLY when the
        # seed is empty. The companion test above seeds 3 products and
        # asserts they appear; flipping the seed flips the assertion.

    def test_inventory_only_branch_passes_shelf_id(self):
        """The pool builder threads ``shelf_id`` through the new method.

        Without this, multi-shelf Pis could surface inventory_only
        products from a different shelf into the pool.
        """
        source = _InventoryOnlyStubSource(
            inventory_only=[
                _product("p_only", name="Lone Item", weight=500.0),
            ],
        )
        ctx = ClassifierContext(source=source, shelf_id="catch_all")
        pool_for_add(500.0, ctx)
        inventory_only_calls = [
            args for name, args in source.calls if name == "inventory_only"
        ]
        assert inventory_only_calls == [("catch_all",)]

    def test_inventory_only_dropped_from_remove_pool(self):
        """REMOVE pool must NOT include inventory_only products.

        The REMOVE pool requires shelf-presence (a lot to actually
        remove). A cloud stock_lot the user never placed on the shelf
        cannot be removed from the shelf, so it must not appear.
        """
        source = _InventoryOnlyStubSource(
            inventory_only=[
                _product("p_only", name="Lone Item", weight=500.0),
            ],
        )
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_remove(-500.0, ctx)
        ids = [c.candidate_id for c in pool]
        assert "p_only" not in ids

    def test_inventory_only_below_top_up_when_both_match(self):
        """When the same product has BOTH a top-up target and inventory_only,
        the top-up branch wins the dedupe.

        Rationale: top-up evidence (lot is currently on the shelf) is
        stronger than cloud-mirror inventory (never been observed on
        this shelf). The dedupe-by-product collapse must keep the
        top-up entry.
        """

        # Construct a dedicated stub that ALSO surfaces an on-shelf lot
        # for the same product_id, simulating a stale cloud_lots row
        # that the regular branches already cover.
        class _BothBranchSource(_InventoryOnlyStubSource):
            def get_on_shelf_lots(
                self, shelf_id: str | None = None,
            ) -> list[LotCandidate]:
                return [
                    LotCandidate(
                        lot_id="L1",
                        product_id="p_dup",
                        name="Both-branch Product",
                        brand=None,
                        expected_weight_g=200.0,
                        container_type="bottle",
                        status="on_shelf",
                    ),
                ]

        source = _BothBranchSource(
            inventory_only=[
                _product("p_dup", name="Both-branch Product", weight=200.0),
            ],
        )
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_add(200.0, ctx)
        non_sentinel = [c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        # Exactly one entry for p_dup (deduped by product), and it must
        # come from the top-up branch.
        p_dup_entries = [c for c in non_sentinel if c.candidate_id == "p_dup"]
        assert len(p_dup_entries) == 1
        assert p_dup_entries[0].why_candidate == "top_up_target"


# --- DB-backed integration test ------------------------------------------


def _ctx_for(conn, tmp_path, shelf_id: str) -> ClassifierContext:
    refs_root = tmp_path / "refs"
    refs_root.mkdir(exist_ok=True)
    source = RepoCandidateSource(conn, refs_root, db_lock=threading.RLock())
    return ClassifierContext(source=source, shelf_id=shelf_id)


def _seed_cloud_lot(
    conn,
    *,
    lot_id: str,
    product_id: str,
    qty: float = 1.0,
) -> None:
    """Insert a cloud_lots mirror row directly (bypasses the poller)."""
    conn.execute(
        """
        INSERT INTO cloud_lots (
            lot_id, product_id, location_id, qty_containers,
            expires_on, in_flight_since, pickup_event_id,
            updated_at, deleted_at, synced_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL,
                  '2026-04-27T20:00:00+00:00', NULL,
                  datetime('now'))
        """,
        (lot_id, product_id, "loc-1", qty),
    )
    conn.commit()


class TestInventoryOnlyDbBacked:
    def test_pool_includes_seeded_cloud_inventory(self, tmp_path):
        """End-to-end: cloud_lots seeded → RepoCandidateSource → pool has them.

        This is the test the production regression would have failed.
        Mutation evidence: removing the cloud_lots inserts in
        ``_seed_cloud_lot`` collapses the pool to UNKNOWN-only. The
        companion negative test below pins this.
        """
        db_path = tmp_path / "inv_only.db"
        conn = init_db(db_path)
        try:
            # Three products mirroring the user's actual inventory at
            # the time of the regression.
            p_gat = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Gatorade Frost",
                    barcode="gat-frost",
                    net_weight_g=900.0,
                    gross_weight_g=950.0,
                    unit_type="liquid",
                    container_type="bottle",
                    certified=1,
                ),
            )
            p_chk = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Pulled Chicken",
                    barcode="chk-1",
                    net_weight_g=600.0,
                    gross_weight_g=620.0,
                    unit_type="solid",
                    container_type="tray",
                    certified=1,
                ),
            )
            p_par = storage_repo.create_product(
                conn,
                ProductIn(
                    name="PARMESAN",
                    barcode="par-1",
                    net_weight_g=200.0,
                    gross_weight_g=220.0,
                    unit_type="solid",
                    container_type="jar",
                    certified=1,
                ),
            )
            _seed_cloud_lot(
                conn, lot_id="cl-gat", product_id=p_gat.product_id,
            )
            _seed_cloud_lot(
                conn, lot_id="cl-chk", product_id=p_chk.product_id,
            )
            _seed_cloud_lot(
                conn, lot_id="cl-par", product_id=p_par.product_id,
            )
            # NO Pi lots — every cloud lot is "inventory_only" from the
            # Pi's perspective. This matches the production state at
            # the time of the regression.
            ctx = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool = pool_for_add(663.452, ctx)

            ids = [c.candidate_id for c in pool]
            assert p_gat.product_id in ids, (
                f"Pool missing Gatorade — got {ids!r}. "
                "Regression: inventory_only branch is silent on cloud_lots."
            )
            assert p_chk.product_id in ids
            assert p_par.product_id in ids
            # Sentinel last; pool size > 1 (the regression's smoking
            # gun was pool_size=1).
            assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID
            assert len(pool) >= 4  # 3 products + UNKNOWN

            non_sentinel = [
                c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID
            ]
            for c in non_sentinel:
                assert c.why_candidate == "inventory_only"
                assert c.lot_id is None  # no Pi lot to attach
                assert c.product_id is not None
        finally:
            conn.close()

    def test_pool_collapses_to_unknown_when_cloud_lots_empty(self, tmp_path):
        """Mutation guard: empty cloud_lots → no inventory_only entries.

        Mirror of the inventory_only regression. Updated 2026-04-27
        for decision #54: on the live_shelf, an UNCERTIFIED product
        with no cloud_lots row must NOT surface in any branch — the
        certified-product catalog branch (re-introduced by #54)
        excludes uncertified rows, and the inventory_only branch
        excludes products with no cloud_lots qty>0. Combined, a
        bare uncertified product with no inventory yields the
        UNKNOWN-only pool.
        """
        db_path = tmp_path / "inv_only_empty.db"
        conn = init_db(db_path)
        try:
            # Uncertified product, no cloud_lots → invisible to both
            # the inventory_only branch (no cloud lot) AND the catalog
            # branch (catalog branch is certified-only).
            storage_repo.create_product(
                conn,
                ProductIn(
                    name="Untracked Product",
                    barcode="untracked-1",
                    net_weight_g=300.0,
                    gross_weight_g=300.0,
                    unit_type="solid",
                    container_type="bag",
                    certified=0,
                ),
            )
            ctx = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool = pool_for_add(300.0, ctx)
            assert len(pool) == 1
            assert pool[0].candidate_id == UNKNOWN_CANDIDATE_ID
        finally:
            conn.close()

    def test_pi_lot_present_excludes_product_from_inventory_only(self, tmp_path):
        """A product with both cloud_lots AND a Pi lot must not double-up.

        The ``list_inventory_only_products`` SQL has a ``NOT EXISTS``
        clause that filters out products with any Pi ``lots`` row on
        this shelf. Verifies that filter holds in production-shape
        seeding.
        """
        from server.storage.models import LotIn
        db_path = tmp_path / "inv_only_with_pi.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Doubled Product",
                    barcode="dup-1",
                    net_weight_g=400.0,
                    gross_weight_g=420.0,
                    unit_type="solid",
                    container_type="bottle",
                    certified=1,
                ),
            )
            _seed_cloud_lot(conn, lot_id="cl-dup", product_id=p.product_id)
            # Also create a Pi lot on live_shelf — the inventory_only
            # branch must skip this product (the on-shelf branch
            # surfaces it instead).
            storage_repo.create_lot(
                conn,
                LotIn(
                    product_id=p.product_id,
                    status="on_shelf",
                    current_weight_g=400.0,
                    initial_weight_g=400.0,
                    shelf_id="live_shelf",
                ),
            )
            ctx = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool = pool_for_add(400.0, ctx)
            non_sentinel = [
                c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID
            ]
            inv_only = [
                c for c in non_sentinel if c.why_candidate == "inventory_only"
            ]
            # No inventory_only entry for this product — the Pi lot
            # already covers it via top_up_target / on_shelf branch.
            assert all(c.product_id != p.product_id for c in inv_only)
            # And the on-shelf branch DID surface the product.
            assert any(c.product_id == p.product_id for c in non_sentinel)
        finally:
            conn.close()

    def test_zero_qty_cloud_lot_is_not_inventory(self, tmp_path):
        """Empty (qty=0) cloud_lots rows must NOT count as inventory_only.

        Empty lots represent already-consumed inventory. The
        cloud-side resolver's empty-lot-reuse path can promote them
        on a refill, but they aren't candidates for the inventory_only
        branch.

        Updated 2026-04-27 for decision #54: the certified product
        STILL surfaces in the pool — but via the ``catalog_not_on_shelf``
        branch (live_shelf only). The semantic this test pins is "the
        inventory_only branch ignores qty=0 cloud lots" — when qty is
        bumped to 1.0, the entry's why_candidate flips from
        catalog_not_on_shelf to inventory_only.
        """
        db_path = tmp_path / "inv_only_zero_qty.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Empty Cloud Lot Product",
                    barcode="empty-1",
                    net_weight_g=300.0,
                    gross_weight_g=300.0,
                    unit_type="solid",
                    container_type="bottle",
                    certified=1,
                ),
            )
            # qty_containers=0 → not inventory_only.
            _seed_cloud_lot(
                conn, lot_id="cl-empty", product_id=p.product_id, qty=0.0,
            )
            ctx = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool = pool_for_add(300.0, ctx)
            non_sentinel = [
                c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID
            ]
            # Product appears via the catalog branch (decision #54).
            assert any(c.product_id == p.product_id for c in non_sentinel)
            # …but NOT via inventory_only — qty=0 disqualifies it.
            inv_only = [
                c for c in non_sentinel
                if c.product_id == p.product_id
                and c.why_candidate == "inventory_only"
            ]
            assert inv_only == []

            # Now bump qty to 1.0 — same product surfaces with the
            # stronger inventory_only tag (catalog branch loses the
            # dedupe collapse).
            conn.execute(
                "UPDATE cloud_lots SET qty_containers = 1.0 "
                "WHERE lot_id = 'cl-empty'",
            )
            conn.commit()
            ctx2 = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool2 = pool_for_add(300.0, ctx2)
            entries = [
                c for c in pool2
                if c.product_id == p.product_id
            ]
            assert len(entries) == 1
            assert entries[0].why_candidate == "inventory_only"
        finally:
            conn.close()


# --- Cross-shelf scoping --------------------------------------------------


class TestInventoryOnlyShelfScoping:
    def test_other_shelfs_pi_lot_does_not_block_inventory_only(self, tmp_path):
        """A Pi lot on shelf B must not block inventory_only on shelf A.

        Multi-shelf Pi: live_shelf and catch_all are independent. If
        the user has cloud inventory and the product is on the
        catch_all but not on live_shelf, the pool builder for
        live_shelf must surface the inventory_only entry — the
        product is in inventory but has no live_shelf-tracked lot.
        """
        from server.storage.models import LotIn
        db_path = tmp_path / "inv_only_cross_shelf.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Cross-shelf Product",
                    barcode="cs-1",
                    net_weight_g=350.0,
                    gross_weight_g=370.0,
                    unit_type="solid",
                    container_type="bag",
                    certified=1,
                ),
            )
            _seed_cloud_lot(
                conn, lot_id="cl-cs", product_id=p.product_id,
            )
            # Pi lot exists on catch_all only.
            storage_repo.create_lot(
                conn,
                LotIn(
                    product_id=p.product_id,
                    status="on_shelf",
                    current_weight_g=350.0,
                    initial_weight_g=350.0,
                    shelf_id="catch_all",
                ),
            )
            # Pool for live_shelf must surface the product (no live_shelf
            # Pi lot exists; cloud has inventory).
            ctx_live = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool_live = pool_for_add(350.0, ctx_live)
            ids_live = [c.candidate_id for c in pool_live]
            assert p.product_id in ids_live
            non_sent = [
                c for c in pool_live
                if c.candidate_id == p.product_id
            ]
            assert non_sent[0].why_candidate == "inventory_only"
        finally:
            conn.close()
