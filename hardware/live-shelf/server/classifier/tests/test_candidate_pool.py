"""Tests for candidate pool assembly (plan §6)."""

from __future__ import annotations

from typing import Sequence

import pytest

from server.classifier.candidate_pool import (
    UNKNOWN_SENTINEL,
    _matches_weight,
    _rank_candidates,
    pool_for_add,
    pool_for_remove,
    weight_proximity_score,
)
from server.classifier.models import (
    UNKNOWN_CANDIDATE_ID,
    Candidate,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
)


# --- Stub CandidateSource --------------------------------------------------


class StubSource:
    """In-memory :class:`CandidateSource` for tests.

    Mirrors the protocol Bundle H will later implement on top of Bundle A's
    storage. Tests hand a configured instance to ``ClassifierContext``.
    """

    def __init__(
        self,
        *,
        on_shelf: Sequence[LotCandidate] = (),
        recently_out: Sequence[LotCandidate] = (),
        certified_not_on_shelf: Sequence[ProductCandidate] = (),
    ) -> None:
        self._on_shelf = list(on_shelf)
        self._recently_out = list(recently_out)
        self._catalog = list(certified_not_on_shelf)
        self.calls: list[tuple[str, tuple]] = []

    def get_on_shelf_lots(self) -> list[LotCandidate]:
        self.calls.append(("on_shelf", ()))
        return list(self._on_shelf)

    def get_recently_out_lots(self, window_seconds: int) -> list[LotCandidate]:
        self.calls.append(("recently_out", (window_seconds,)))
        return list(self._recently_out)

    def get_certified_not_on_shelf(self) -> list[ProductCandidate]:
        self.calls.append(("catalog", ()))
        return list(self._catalog)


def _lot(
    lot_id: str,
    *,
    name: str,
    weight: float,
    status: str = "on_shelf",
    product_id: str | None = None,
    brand: str | None = None,
    container: str | None = "bottle",
    refs: Sequence[str] = (),
) -> LotCandidate:
    return LotCandidate(
        lot_id=lot_id,
        product_id=product_id or f"prod_{lot_id}",
        name=name,
        brand=brand,
        expected_weight_g=weight,
        container_type=container,
        status=status,  # type: ignore[arg-type]
        reference_image_paths=refs,
    )


def _product(
    pid: str,
    *,
    name: str,
    weight: float,
    container: str | None = "jar",
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


def _ctx(source: StubSource, **overrides) -> ClassifierContext:
    return ClassifierContext(source=source, **overrides)


# --- Weight proximity scoring ---------------------------------------------


class TestWeightProximity:
    def test_exact_match_scores_one(self):
        assert weight_proximity_score(100, 100) == pytest.approx(1.0)

    def test_null_expected_scores_zero(self):
        assert weight_proximity_score(None, 100) == 0.0
        assert weight_proximity_score(0, 100) == 0.0

    def test_monotonic_decrease_with_distance(self):
        base = weight_proximity_score(100, 100)
        near = weight_proximity_score(100, 110)
        far = weight_proximity_score(100, 200)
        assert base > near > far

    def test_matches_weight_threshold(self):
        c = Candidate(
            candidate_id="x",
            name="t",
            brand=None,
            expected_weight_g=100,
            container_type=None,
            why_candidate="recently_out",
        )
        assert _matches_weight(c, 100) is True
        assert _matches_weight(c, 120) is True  # within 30%
        assert _matches_weight(c, 140) is False  # 40% off


# --- Ranking ---------------------------------------------------------------


class TestRanking:
    def test_tier_order_weighted_better_than_fallback(self):
        candidates = [
            Candidate(
                candidate_id="a",
                name="a",
                brand=None,
                expected_weight_g=100,
                container_type=None,
                why_candidate="recently_out",
            ),
            Candidate(
                candidate_id="b",
                name="b",
                brand=None,
                expected_weight_g=500,
                container_type=None,
                why_candidate="recently_out",
            ),
        ]
        ranked = _rank_candidates(candidates, observed_abs_delta=100)
        # Matching weight tier (1) comes before fallback tier (4).
        assert [c.candidate_id for c in ranked] == ["a", "b"]

    def test_top_up_between_recently_out_and_catalog(self):
        candidates = [
            Candidate(
                candidate_id="tu",
                name="tu",
                brand=None,
                expected_weight_g=100,
                container_type=None,
                why_candidate="top_up_target",
            ),
            Candidate(
                candidate_id="ro",
                name="ro",
                brand=None,
                expected_weight_g=100,
                container_type=None,
                why_candidate="recently_out",
            ),
            Candidate(
                candidate_id="cat",
                name="cat",
                brand=None,
                expected_weight_g=100,
                container_type=None,
                why_candidate="catalog_not_on_shelf",
            ),
        ]
        ranked = _rank_candidates(candidates, observed_abs_delta=100)
        assert [c.candidate_id for c in ranked] == ["ro", "tu", "cat"]

    def test_weight_proximity_order_within_tier(self):
        candidates = [
            Candidate(
                candidate_id="far",
                name="far",
                brand=None,
                expected_weight_g=200,
                container_type=None,
                why_candidate="currently_on_shelf",
            ),
            Candidate(
                candidate_id="near",
                name="near",
                brand=None,
                expected_weight_g=110,
                container_type=None,
                why_candidate="currently_on_shelf",
            ),
            Candidate(
                candidate_id="exact",
                name="exact",
                brand=None,
                expected_weight_g=100,
                container_type=None,
                why_candidate="currently_on_shelf",
            ),
        ]
        ranked = _rank_candidates(candidates, observed_abs_delta=100)
        assert [c.candidate_id for c in ranked] == ["exact", "near", "far"]


# --- ADD pool --------------------------------------------------------------


class TestPoolForAdd:
    def test_sentinel_always_last_even_with_empty_pool(self):
        source = StubSource()
        pool = pool_for_add(100, _ctx(source))
        assert len(pool) == 1
        assert pool[-1] is UNKNOWN_SENTINEL
        assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID

    def test_union_of_inventory_branches_excludes_catalog(self):
        """**2026-04-27 inventory-only matching (decisions.md #42):**

        The ADD pool unions in-inventory branches only. The
        ``catalog_not_on_shelf`` branch is INTENTIONALLY DROPPED — a
        place event on a product with no existing inventory must NOT
        mint a new lot. The user's design rule: "an item has to be in
        inventory for it to get matched."

        Test: even with a candidate-not-on-shelf product whose weight
        matches the delta exactly, it must NOT appear in the pool.
        """
        source = StubSource(
            on_shelf=[_lot("L1", name="Ketchup", weight=340, product_id="prod_K")],
            recently_out=[_lot("L2", name="Mustard", weight=200, status="out", product_id="prod_M")],
            certified_not_on_shelf=[_product("P1", name="Mayo", weight=450)],
        )
        pool = pool_for_add(450, _ctx(source))
        names = [c.name for c in pool]
        # Inventory branches only — Mustard (recently_out) is in pool.
        assert "Mustard" in names
        # Catalog product excluded under inventory-only rule.
        assert "Mayo" not in names
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_on_shelf_lots_appear_as_inventory_candidates(self):
        """**2026-04-27 (decisions.md #42):** every on-shelf lot of an
        inventory product is an ADD candidate. The pre-2026-04-27
        ``top_up_target`` weight-tolerance filter is removed because
        the user has directed that weight mismatches are EXPECTED on
        place-back events. The apply path branches into top-up vs
        revive vs in-flight-return based on lot status, not pool
        eligibility.
        """
        on_shelf_big = _lot("L1", name="Peanut Butter", weight=100, product_id="prod_pb")
        on_shelf_bigger = _lot("L2", name="Olive Oil", weight=1000, product_id="prod_oo")
        source = StubSource(on_shelf=[on_shelf_big, on_shelf_bigger])
        pool = pool_for_add(20, _ctx(source))
        reasons = {c.why_candidate for c in pool}
        assert "top_up_target" in reasons
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_on_shelf_lots_remain_eligible_regardless_of_delta_size(self):
        """**2026-04-27 (decisions.md #42):** weight tolerance no
        longer filters on-shelf lots from the ADD pool. A 500g placed
        item with a 100g on-shelf lot is now still a candidate — the
        classifier decides if the visual identity matches; the apply
        path handles the weight reconciliation.
        """
        source = StubSource(
            on_shelf=[_lot("L1", name="PB", weight=100, product_id="prod_pb")]
        )
        pool = pool_for_add(500, _ctx(source))
        # Inventory candidate + sentinel.
        assert len(pool) == 2
        assert pool[0].why_candidate == "top_up_target"
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_top_n_cap_keeps_sentinel(self):
        # Generate more than 10 candidates (the default cap). Each lot
        # uses a DISTINCT product_id so the product-collapse step doesn't
        # merge them (decisions.md #42 — collapse keys on product_id).
        recents = [
            _lot(
                f"L{i}", name=f"Item{i}", weight=100 + i,
                status="out", product_id=f"prod_{i}",
            )
            for i in range(20)
        ]
        source = StubSource(recently_out=recents)
        pool = pool_for_add(100, _ctx(source))
        assert len(pool) == 10
        assert pool[-1] is UNKNOWN_SENTINEL
        # The top 9 (excluding sentinel) should come from the recently_out set.
        non_sentinel = pool[:-1]
        assert all(c.why_candidate == "recently_out" for c in non_sentinel)

    def test_top_n_override(self):
        recents = [
            _lot(
                f"L{i}", name=f"Item{i}", weight=100 + i,
                status="out", product_id=f"prod_{i}",
            )
            for i in range(5)
        ]
        source = StubSource(recently_out=recents)
        pool = pool_for_add(100, _ctx(source), top_n=3)
        assert len(pool) == 3
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_dedup_by_product_id_collapses_duplicates(self):
        """**2026-04-27 (decisions.md #42):** dedup keys on ``product_id``.

        Multiple Candidates sharing the same product_id collapse to a
        single entry. Tier priority decides the winner (in_flight >
        recently_out > top_up_target > currently_on_shelf).
        """
        from server.classifier.candidate_pool import _dedupe_by_product

        dup = Candidate(
            candidate_id="prod_ketchup",
            name="Ketchup",
            brand=None,
            expected_weight_g=340,
            container_type="bottle",
            why_candidate="recently_out",
            product_id="prod_ketchup",
            lot_id="L1",
        )
        other = Candidate(
            candidate_id="prod_ketchup",  # same product_id
            name="Ketchup (alt view)",
            brand=None,
            expected_weight_g=340,
            container_type="bottle",
            why_candidate="top_up_target",
            product_id="prod_ketchup",
            lot_id="L2",
        )
        out = _dedupe_by_product([dup, other])
        assert [c.candidate_id for c in out] == ["prod_ketchup"]
        # Higher-priority tier wins (recently_out > top_up_target).
        assert out[0].why_candidate == "recently_out"

    def test_multiple_lots_of_same_product_collapse_to_one(self):
        """**2026-04-27 (decisions.md #42):** two distinct lots of the
        same SKU collapse to ONE entry in the pool — the classifier
        sees products only. Lot resolution is purely deterministic on
        the apply path via ``_pick_best_lot_for_product``.

        This INTENTIONALLY reverses the pre-2026-04-27 "Fix 4"
        behaviour, which preserved distinct lot_ids in the pool. Under
        the new contract, lot identity is invisible to the classifier
        and the apply-path picker chooses programmatically.
        """
        source = StubSource(
            recently_out=[
                _lot(
                    "L1", name="Ketchup", weight=340,
                    container="bottle", status="out",
                    product_id="prod_ketchup",
                ),
                _lot(
                    "L2", name="Ketchup", weight=340,
                    container="bottle", status="out",
                    product_id="prod_ketchup",
                ),
            ],
        )
        pool = pool_for_add(340, _ctx(source))
        ids = [c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        # Only the product_id appears, not lot_ids.
        assert ids == ["prod_ketchup"]
        # UNKNOWN last invariant preserved.
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_catalog_branch_excluded_under_inventory_only_rule(self):
        """**2026-04-27 (decisions.md #42):** catalog products are NEVER
        in the ADD pool — only products with existing inventory.

        A product with a recently_out lot AND a catalog entry of the
        same SKU now collapses to one entry sourced from the inventory
        side. A bare catalog product with no inventory does not appear
        at all.
        """
        source = StubSource(
            recently_out=[
                _lot(
                    "L1", name="Ketchup", weight=340,
                    container="bottle", status="out",
                    product_id="prod_ketchup",
                )
            ],
            certified_not_on_shelf=[
                _product("prod_mayo", name="Mayo (no inventory)", weight=450),
            ],
        )
        pool = pool_for_add(340, _ctx(source))
        non_sentinel = [
            c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID
        ]
        # Only prod_ketchup (has inventory) — Mayo (catalog-only) is dropped.
        assert non_sentinel == ["prod_ketchup"]
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_recently_out_window_is_forwarded(self):
        source = StubSource()
        pool_for_add(100, _ctx(source, recently_out_window_seconds=60))
        # Confirm the stub was called with the correct window.
        recently_out_calls = [c for c in source.calls if c[0] == "recently_out"]
        assert recently_out_calls == [("recently_out", (60,))]

    def test_weight_proximity_ranking_order(self):
        # Three recently-out candidates, varying distance from |delta|=300.
        # Each lot uses a distinct product_id so the product-collapse
        # step preserves them all (pool sees products, not lots).
        source = StubSource(
            recently_out=[
                _lot("L_far", name="FarThing", weight=1000, status="out", product_id="prod_far"),
                _lot("L_mid", name="MidThing", weight=600, status="out", product_id="prod_mid"),
                _lot("L_close", name="CloseThing", weight=310, status="out", product_id="prod_close"),
            ]
        )
        pool = pool_for_add(300, _ctx(source))
        # Drop the sentinel for ordering check. Pool entries are now
        # keyed by product_id (decisions.md #42).
        ordered_ids = [c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        assert ordered_ids[0] == "prod_close"
        # The 1000g candidate should rank after the 600g one.
        assert ordered_ids.index("prod_mid") < ordered_ids.index("prod_far")


# --- REMOVE pool -----------------------------------------------------------


class TestPoolForRemove:
    def test_returns_only_on_shelf_lots(self):
        # **2026-04-27 (decisions.md #42):** REMOVE pool keys on
        # product_id. Each lot needs its own product_id so the
        # collapse step preserves both.
        source = StubSource(
            on_shelf=[
                _lot("L1", name="Ketchup", weight=340, product_id="prod_K"),
                _lot("L2", name="Mustard", weight=200, product_id="prod_M"),
            ],
            # These must be ignored for REMOVE pools.
            recently_out=[_lot("L3", name="Mayo", weight=450, status="out", product_id="prod_Y")],
            certified_not_on_shelf=[_product("P9", name="Olive Oil", weight=900)],
        )
        pool = pool_for_remove(-340, _ctx(source))
        ids = {c.candidate_id for c in pool}
        assert ids == {"prod_K", "prod_M"}
        # No sentinel in REMOVE pools (§6.2).
        assert all(c.candidate_id != UNKNOWN_CANDIDATE_ID for c in pool)

    def test_ranked_by_weight_proximity(self):
        source = StubSource(
            on_shelf=[
                _lot("L_far", name="Far", weight=1000, product_id="prod_far"),
                _lot("L_close", name="Close", weight=105, product_id="prod_close"),
                _lot("L_mid", name="Mid", weight=300, product_id="prod_mid"),
            ]
        )
        pool = pool_for_remove(-100, _ctx(source))
        assert [c.candidate_id for c in pool] == ["prod_close", "prod_mid", "prod_far"]

    def test_empty_pool_when_shelf_empty(self):
        # No on-shelf lots → empty pool. Per the inventory-only rule
        # (decisions.md #42), there is no catalog fallback; a REMOVE
        # without inventory is a sensor anomaly that surfaces UNKNOWN.
        source = StubSource()
        pool = pool_for_remove(-100, _ctx(source))
        assert pool == []

    def test_no_catalog_fallback_under_inventory_only_rule(self):
        """**2026-04-27 (decisions.md #42):** the catalog fallback for
        REMOVE was removed for consistency with the ADD-side
        inventory-only rule. A REMOVE on an empty shelf returns an
        empty pool — the classifier short-circuits to UNKNOWN.
        """
        source = StubSource(
            certified_not_on_shelf=[
                _product("P1", name="Ketchup", weight=340),
                _product("P2", name="Mustard", weight=200),
            ]
        )
        pool = pool_for_remove(-340, _ctx(source))
        # Catalog fallback removed — empty pool.
        assert pool == []

    def test_top_n_truncation(self):
        # Distinct product_ids so the collapse step preserves them.
        lots = [
            _lot(f"L{i}", name=f"L{i}", weight=100 + i, product_id=f"prod_{i}")
            for i in range(15)
        ]
        source = StubSource(on_shelf=lots)
        pool = pool_for_remove(-100, _ctx(source))
        assert len(pool) == 10  # default cap
