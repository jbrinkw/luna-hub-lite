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

    def test_union_of_three_branches(self):
        source = StubSource(
            on_shelf=[_lot("L1", name="Ketchup", weight=340)],
            recently_out=[_lot("L2", name="Mustard", weight=200, status="out")],
            certified_not_on_shelf=[_product("P1", name="Mayo", weight=450)],
        )
        # Delta of 450g: catalog product is the weight-match.
        pool = pool_for_add(450, _ctx(source))
        names = [c.name for c in pool]
        # All three branches + sentinel.
        assert "Mustard" in names
        assert "Mayo" in names
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_top_up_tolerance_respected(self):
        # A 20g top-up onto a 100g lot falls within 25% relative tolerance.
        on_shelf_big = _lot("L1", name="Peanut Butter", weight=100)
        # But a 20g add onto a 1000g lot is well under 25% * 1000=250 so it
        # also counts as a potential top-up.
        on_shelf_bigger = _lot("L2", name="Olive Oil", weight=1000)
        source = StubSource(on_shelf=[on_shelf_big, on_shelf_bigger])
        pool = pool_for_add(20, _ctx(source))
        reasons = {c.why_candidate for c in pool}
        assert "top_up_target" in reasons
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_top_up_skipped_when_delta_too_large(self):
        # A 500g add onto a 100g container is not a top-up.
        source = StubSource(on_shelf=[_lot("L1", name="PB", weight=100)])
        pool = pool_for_add(500, _ctx(source))
        # Only the sentinel should remain.
        assert len(pool) == 1
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_top_n_cap_keeps_sentinel(self):
        # Generate more than 10 candidates (the default cap).
        recents = [
            _lot(f"L{i}", name=f"Item{i}", weight=100 + i, status="out")
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
            _lot(f"L{i}", name=f"Item{i}", weight=100 + i, status="out")
            for i in range(5)
        ]
        source = StubSource(recently_out=recents)
        pool = pool_for_add(100, _ctx(source), top_n=3)
        assert len(pool) == 3
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_dedup_by_candidate_id_collapses_true_duplicates(self):
        """Fix 4: dedup now keys on ``candidate_id``, not name|container.

        When the same lot_id (or product_id) is produced by more than
        one branch, only the first occurrence survives the dedup step.
        Since each branch minted a distinct Candidate instance, the
        only way for ids to collide is an actual same-id duplicate —
        which the §6.1 union never produces. We assert this via a
        directly-constructed list containing a literal duplicate id.
        """
        from server.classifier.candidate_pool import _dedupe_by_product

        dup = Candidate(
            candidate_id="L1",
            name="Ketchup",
            brand=None,
            expected_weight_g=340,
            container_type="bottle",
            why_candidate="recently_out",
        )
        other = Candidate(
            candidate_id="L1",  # same id
            name="Ketchup (alt view)",
            brand=None,
            expected_weight_g=340,
            container_type="bottle",
            why_candidate="top_up_target",
        )
        out = _dedupe_by_product([dup, other])
        assert [c.candidate_id for c in out] == ["L1"]
        # First occurrence wins.
        assert out[0].why_candidate == "recently_out"

    def test_distinct_lots_of_same_product_both_preserved(self):
        """Fix 4 regression: two distinct lots of the same SKU must
        BOTH appear in the ADD pool.

        Before Fix 4 the dedup key was ``name|container_type``, which
        collapsed two distinct on-shelf/out lots of the same product
        into one entry — hiding the second lot from the classifier.
        Fix 4 switches dedup to ``candidate_id`` so distinct lot_ids
        survive.
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
        assert sorted(ids) == ["L1", "L2"]
        # UNKNOWN last invariant preserved.
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_same_product_lot_and_catalog_both_preserved(self):
        """Fix 4: a lot (recently_out) and a product (catalog) sharing
        a display name are kept separately because they have distinct
        candidate_ids (lot_id vs product_id).
        """
        source = StubSource(
            recently_out=[
                _lot("L1", name="Ketchup", weight=340, container="bottle", status="out")
            ],
            certified_not_on_shelf=[
                _product("P1", name="Ketchup", weight=340, container="bottle")
            ],
        )
        pool = pool_for_add(340, _ctx(source))
        # L1 + P1 + sentinel.
        assert len(pool) == 3
        non_sentinel_ids = [
            c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID
        ]
        assert sorted(non_sentinel_ids) == ["L1", "P1"]
        assert pool[-1] is UNKNOWN_SENTINEL

    def test_recently_out_window_is_forwarded(self):
        source = StubSource()
        pool_for_add(100, _ctx(source, recently_out_window_seconds=60))
        # Confirm the stub was called with the correct window.
        recently_out_calls = [c for c in source.calls if c[0] == "recently_out"]
        assert recently_out_calls == [("recently_out", (60,))]

    def test_weight_proximity_ranking_order(self):
        # Three recently-out candidates, varying distance from |delta|=300.
        source = StubSource(
            recently_out=[
                _lot("L_far", name="FarThing", weight=1000, status="out"),
                _lot("L_mid", name="MidThing", weight=600, status="out"),
                _lot("L_close", name="CloseThing", weight=310, status="out"),
            ]
        )
        pool = pool_for_add(300, _ctx(source))
        # Drop the sentinel for ordering check.
        ordered_ids = [c.candidate_id for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        assert ordered_ids[0] == "L_close"
        # The 1000g candidate should rank after the 600g one.
        assert ordered_ids.index("L_mid") < ordered_ids.index("L_far")


# --- REMOVE pool -----------------------------------------------------------


class TestPoolForRemove:
    def test_returns_only_on_shelf_lots(self):
        source = StubSource(
            on_shelf=[
                _lot("L1", name="Ketchup", weight=340),
                _lot("L2", name="Mustard", weight=200),
            ],
            # These must be ignored for REMOVE pools.
            recently_out=[_lot("L3", name="Mayo", weight=450, status="out")],
            certified_not_on_shelf=[_product("P9", name="Olive Oil", weight=900)],
        )
        pool = pool_for_remove(-340, _ctx(source))
        ids = {c.candidate_id for c in pool}
        assert ids == {"L1", "L2"}
        # No sentinel in REMOVE pools (§6.2).
        assert all(c.candidate_id != UNKNOWN_CANDIDATE_ID for c in pool)

    def test_ranked_by_weight_proximity(self):
        source = StubSource(
            on_shelf=[
                _lot("L_far", name="Far", weight=1000),
                _lot("L_close", name="Close", weight=105),
                _lot("L_mid", name="Mid", weight=300),
            ]
        )
        pool = pool_for_remove(-100, _ctx(source))
        assert [c.candidate_id for c in pool] == ["L_close", "L_mid", "L_far"]

    def test_empty_pool_when_shelf_and_catalog_empty(self):
        # No on-shelf lots AND no certified products → pool really is empty
        # and the classifier is right to fall back to UNKNOWN.
        source = StubSource()
        pool = pool_for_remove(-100, _ctx(source))
        assert pool == []

    def test_catalog_fallback_when_shelf_empty(self):
        # If no on-shelf lots exist but certified products are in the
        # catalog, the REMOVE pool falls back to catalog products so
        # the LLM can still attempt a multi_match. This covers the
        # "admin deleted the lots but physical items remain" case
        # where the session's scale events still need attribution.
        source = StubSource(
            certified_not_on_shelf=[
                _product("P1", name="Ketchup", weight=340),
                _product("P2", name="Mustard", weight=200),
            ]
        )
        pool = pool_for_remove(-340, _ctx(source))
        ids = [c.candidate_id for c in pool]
        assert set(ids) == {"P1", "P2"}
        # Closest weight match first.
        assert ids[0] == "P1"

    def test_on_shelf_lots_take_precedence_over_catalog(self):
        # When BOTH on-shelf lots and catalog exist, on-shelf wins —
        # the catalog fallback only triggers for a genuinely empty shelf.
        source = StubSource(
            on_shelf=[_lot("L1", name="Ketchup", weight=340)],
            certified_not_on_shelf=[
                _product("P1", name="Something", weight=340),
            ],
        )
        pool = pool_for_remove(-340, _ctx(source))
        assert [c.candidate_id for c in pool] == ["L1"]

    def test_top_n_truncation(self):
        lots = [_lot(f"L{i}", name=f"L{i}", weight=100 + i) for i in range(15)]
        source = StubSource(on_shelf=lots)
        pool = pool_for_remove(-100, _ctx(source))
        assert len(pool) == 10  # default cap
