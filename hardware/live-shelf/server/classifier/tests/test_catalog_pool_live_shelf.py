"""Tests for the ``catalog_not_on_shelf`` branch on ``live_shelf`` (decision #54).

**Why this file exists:** decisions.md #54 reintroduces the
``catalog_not_on_shelf`` branch in :func:`pool_for_add` for the
``live_shelf`` shelf kind specifically. The motivation is the
"general products to be matchable on the live_shelf even if no
stock_lots exist yet" expectation: users have catalog products with
no inventory at all (e.g. uncertified Tortillas in the catalog with
no ``stock_lots`` row, or a freshly-scanned product never intaked).
On the multi-item live-shelf the user expects a fresh placement to
match against the catalog and create a new lot.

The tests here pin three contracts:

1. **Catalog branch ON for live_shelf** — certified products with no
   inventory surface in the pool with ``why_candidate='catalog_not_on_shelf'``.
2. **Catalog branch OFF for non-live_shelf** — single_item /
   catch_all / unspecified shelf_id KEEP decision #45's
   inventory-only contract. Same product, different shelf, different
   pool.
3. **Dedupe priority preserved** — when a product is in BOTH the
   inventory_only branch (cloud_lots qty>0) AND the catalog branch
   (certified product), the inventory_only entry wins the
   _dedupe_by_product collapse so the apply path still routes through
   the cloud-lot promotion path rather than the mint-fresh path.
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
from server.classifier.candidate_pool import pool_for_add  # noqa: E402
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
)
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn  # noqa: E402


# --- Stub source ----------------------------------------------------------


class _CatalogStubSource:
    """Minimal :class:`CandidateSource` that ONLY supplies catalog rows.

    Other branches (in_flight, recently_out, on_shelf, inventory_only)
    return empty sequences. Test fixtures customise via constructor
    args.
    """

    def __init__(
        self,
        *,
        certified_not_on_shelf: Sequence[ProductCandidate] = (),
        inventory_only: Sequence[ProductCandidate] = (),
    ) -> None:
        self._catalog = list(certified_not_on_shelf)
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
        return list(self._catalog)


def _product(
    pid: str,
    *,
    name: str,
    weight: float | None = None,
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


class TestCatalogBranchLiveShelfStub:
    def test_catalog_product_surfaces_on_live_shelf(self):
        """Decision #54: certified-not-on-shelf product appears in pool.

        This is the user's "Tortillas" case: a catalog product with no
        ``cloud_lots`` row and no Pi-local lot. Pre-fix the pool was
        UNKNOWN-only because both the inventory_only branch and the
        catalog branch were silent. Post-fix the catalog branch
        surfaces the product so the classifier can match it.
        """
        source = _CatalogStubSource(
            certified_not_on_shelf=[
                _product("p_tortilla", name="Flour Tortillas", weight=566.0),
            ],
        )
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_add(560.0, ctx)
        ids = [c.candidate_id for c in pool]
        # Tortillas is in the pool.
        assert "p_tortilla" in ids
        # Tagged as catalog_not_on_shelf, NOT inventory_only or top_up.
        non_sent = [c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        assert len(non_sent) == 1
        assert non_sent[0].why_candidate == "catalog_not_on_shelf"
        # Sentinel still last.
        assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID

    def test_catalog_branch_silent_for_non_live_shelf(self):
        """Decision #45 still applies to single_item + catch_all + None.

        Same stub source, different shelf_id — the catalog branch
        must NOT fire. This is the explicit three-shelf-three-pool
        design: only ``live_shelf`` opens up the catalog branch.
        Mutation guard: removing the ``shelf_id == 'live_shelf'``
        gate in candidate_pool.py would cause this test to FAIL
        (catalog product would surface unexpectedly).
        """
        source = _CatalogStubSource(
            certified_not_on_shelf=[
                _product("p_tortilla", name="Flour Tortillas", weight=566.0),
            ],
        )
        for shelf in ("single_item", "catch_all", None):
            ctx = ClassifierContext(source=source, shelf_id=shelf)
            pool = pool_for_add(560.0, ctx)
            ids = [c.candidate_id for c in pool]
            assert "p_tortilla" not in ids, (
                f"catalog branch must be silent for shelf_id={shelf!r}"
            )

    def test_empty_catalog_yields_unknown_only_pool(self):
        """Mutation guard: empty catalog → no entries from this branch.

        Sanity check that the branch is truly the source of the
        Tortillas surfacing — strip the catalog seed and the pool
        collapses to UNKNOWN-only on live_shelf.
        """
        source = _CatalogStubSource(certified_not_on_shelf=[])
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_add(560.0, ctx)
        assert len(pool) == 1
        assert pool[0].candidate_id == UNKNOWN_CANDIDATE_ID

    def test_inventory_only_wins_dedupe_over_catalog(self):
        """When a product appears in BOTH branches, inventory_only wins.

        The product-keyed dedupe collapses multi-source candidates of
        the same SKU into one entry, preferring the higher-priority
        tier. inventory_only (priority 4) beats catalog_not_on_shelf
        (priority 5) so the apply path routes through the
        cloud-lot-promotion path (which preserves the existing
        ``stock_lots`` row), NOT the mint-fresh path (which would
        create a duplicate).
        """
        source = _CatalogStubSource(
            inventory_only=[
                _product("p_chk", name="Chicken", weight=425.0),
            ],
            certified_not_on_shelf=[
                _product("p_chk", name="Chicken", weight=425.0),
            ],
        )
        ctx = ClassifierContext(source=source, shelf_id="live_shelf")
        pool = pool_for_add(425.0, ctx)
        non_sent = [c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        # Exactly one entry for p_chk after the dedupe collapse.
        assert [c.product_id for c in non_sent] == ["p_chk"]
        # And it's tagged inventory_only — the apply path's check
        # ``why_candidate == 'inventory_only'`` would route through
        # _populate_pi_lot_mirror_from_cloud, NOT the mint helper.
        assert non_sent[0].why_candidate == "inventory_only"


# --- DB-backed integration -----------------------------------------------


def _ctx_for(conn, tmp_path, shelf_id: str) -> ClassifierContext:
    refs_root = tmp_path / "refs"
    refs_root.mkdir(exist_ok=True)
    source = RepoCandidateSource(conn, refs_root, db_lock=threading.RLock())
    return ClassifierContext(source=source, shelf_id=shelf_id)


class TestCatalogBranchLiveShelfDb:
    def test_certified_product_with_no_inventory_surfaces(self, tmp_path):
        """End-to-end: certified product, no cloud_lots, no Pi lots → in pool.

        Mirrors the real failure mode (Gatorade Frost-style: a known
        catalog SKU with no inventory). Pre-fix the pool was empty
        for this scenario; post-fix the certified product surfaces
        with ``why_candidate='catalog_not_on_shelf'`` so the
        classifier can match against it and the apply path's catalog
        mint can fire.
        """
        db_path = tmp_path / "catalog_live_shelf.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
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
            # NO cloud_lots, NO Pi lots. The product is bare in the
            # catalog only.
            ctx = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool = pool_for_add(665.0, ctx)
            ids = [c.candidate_id for c in pool]
            assert p.product_id in ids, (
                f"Pool missing Gatorade Frost — got {ids!r}. "
                "Decision #54 catalog branch silent on live_shelf."
            )
            non_sent = [
                c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID
            ]
            assert len(non_sent) == 1
            assert non_sent[0].why_candidate == "catalog_not_on_shelf"
            assert non_sent[0].product_id == p.product_id

        finally:
            conn.close()

    def test_catalog_silent_for_single_item_shelf(self, tmp_path):
        """Same DB shape, different shelf — catalog branch stays silent.

        Pinned defensively against future regressions of the
        three-shelf-three-pool contract: the catalog branch is gated
        on ``shelf_id == 'live_shelf'`` and that gate must persist.
        """
        db_path = tmp_path / "catalog_single_item.db"
        conn = init_db(db_path)
        try:
            storage_repo.create_product(
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
            for shelf in ("single_item", "catch_all"):
                ctx = _ctx_for(conn, tmp_path, shelf_id=shelf)
                pool = pool_for_add(665.0, ctx)
                # UNKNOWN-only — decision #45's inventory-only rule
                # holds for non-live_shelf shelves.
                assert len(pool) == 1, (
                    f"shelf_id={shelf!r}: pool should be UNKNOWN-only, "
                    f"got {[c.candidate_id for c in pool]!r}"
                )
                assert pool[0].candidate_id == UNKNOWN_CANDIDATE_ID
        finally:
            conn.close()

    def test_uncertified_product_does_not_surface(self, tmp_path):
        """Catalog branch is certified-only.

        ``get_all_certified_products`` filters on ``certified=1``.
        Uncertified rows must not appear even on live_shelf — they
        haven't been validated as suitable for matching (no tare,
        possibly malformed weights, etc.).
        """
        db_path = tmp_path / "catalog_uncert.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Random Untrusted Item",
                    barcode="rui-1",
                    net_weight_g=500.0,
                    gross_weight_g=520.0,
                    unit_type="solid",
                    container_type="bag",
                    certified=0,
                ),
            )
            ctx = _ctx_for(conn, tmp_path, shelf_id="live_shelf")
            pool = pool_for_add(500.0, ctx)
            ids = [c.candidate_id for c in pool]
            assert p.product_id not in ids
        finally:
            conn.close()


# --- Apply path: catalog mint --------------------------------------------


class TestCatalogMintHelper:
    """Verify _mint_pi_lot_for_catalog_pick gates on shelf_id correctly.

    This unit-tests the helper directly so a mutation that drops the
    ``shelf_id != 'live_shelf'`` guard is caught before the helper
    is wired into the apply path's branch.
    """

    def test_mints_on_live_shelf(self, tmp_path):
        """live_shelf + catalog pick → Pi lot is created."""
        db_path = tmp_path / "catalog_mint.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Frosty Drink",
                    barcode="fd-1",
                    net_weight_g=600.0,
                    gross_weight_g=620.0,
                    unit_type="liquid",
                    container_type="bottle",
                    certified=1,
                ),
            )
            handler = _make_minimal_handler(conn, tmp_path)
            lot = handler._mint_pi_lot_for_catalog_pick(
                product_id=p.product_id,
                weight_g=665.0,
                event_ts="2026-04-27T22:42:22.263Z",
                shelf_id="live_shelf",
            )
            assert lot is not None
            assert lot.product_id == p.product_id
            assert lot.status == "on_shelf"
            assert lot.shelf_id == "live_shelf"
        finally:
            conn.close()

    def test_refuses_mint_on_single_item(self, tmp_path):
        """single_item shelf must NOT mint — decision #45 holds."""
        db_path = tmp_path / "catalog_mint_si.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Frosty Drink",
                    barcode="fd-2",
                    net_weight_g=600.0,
                    gross_weight_g=620.0,
                    unit_type="liquid",
                    container_type="bottle",
                    certified=1,
                ),
            )
            handler = _make_minimal_handler(conn, tmp_path)
            lot = handler._mint_pi_lot_for_catalog_pick(
                product_id=p.product_id,
                weight_g=665.0,
                event_ts="2026-04-27T22:42:22.263Z",
                shelf_id="single_item",
            )
            assert lot is None

        finally:
            conn.close()

    def test_refuses_mint_on_catch_all(self, tmp_path):
        """catch_all shelf must NOT mint — separate workstream owns that path."""
        db_path = tmp_path / "catalog_mint_ca.db"
        conn = init_db(db_path)
        try:
            p = storage_repo.create_product(
                conn,
                ProductIn(
                    name="Frosty Drink",
                    barcode="fd-3",
                    net_weight_g=600.0,
                    gross_weight_g=620.0,
                    unit_type="liquid",
                    container_type="bottle",
                    certified=1,
                ),
            )
            handler = _make_minimal_handler(conn, tmp_path)
            lot = handler._mint_pi_lot_for_catalog_pick(
                product_id=p.product_id,
                weight_g=665.0,
                event_ts="2026-04-27T22:42:22.263Z",
                shelf_id="catch_all",
            )
            assert lot is None
        finally:
            conn.close()


class _NullCandidateSource:
    """Same shape as the existing test stub in test_in_flight_apply.py."""

    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_inventory_only_products(self, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_minimal_handler(conn, tmp_path):
    """Construct a minimally-wired :class:`ScaleHandler` for helper tests.

    Mirrors test_in_flight_apply._make_handler. We just need the conn,
    db_lock, and a writeable events_root for the helper to call
    ``storage_repo.create_lot``. All other handler features (camera,
    cloud emitter, etc.) default to no-ops via the constructor.
    """
    from server.handlers.scale_events import ScaleHandler

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
    )
