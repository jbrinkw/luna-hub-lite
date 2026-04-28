"""Design-intent invariant — three-shelf-three-pool composition.

Pins decisions.md #45 + #54 + #56: the ADD candidate-pool composition
depends on shelf kind, and any drift here re-introduces the bugs that
motivated those decisions (catalog products silently invisible on the
live_shelf, classifier-driven mints on the LiveTrack scale, and so on).

The pattern: enumerate the three shelf kinds, assert the pool builders
either include OR exclude each tier, and verify mutating the production
code trips the corresponding assertion.

DO NOT relax these assertions to make a future refactor easier — the
correct workflow when these fail is to update the code OR write a new
decision-log entry that supersedes the pinned decision and update this
test alongside it.
"""

from __future__ import annotations

from typing import Sequence

from server.classifier.candidate_pool import (
    pool_for_add,
    pool_for_catch_all,
)
from server.classifier.models import (
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
)


# --- Stub source covering every branch -----------------------------------


class _Source:
    """In-memory stub returning one candidate per branch.

    Distinct product_ids per branch so the dedupe collapse cannot hide
    a missing tier. Every branch returns exactly ONE row so a tier
    appearing or vanishing changes the pool length deterministically.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_on_shelf_lots(
        self, shelf_id: str | None = None
    ) -> Sequence[LotCandidate]:
        self.calls.append("on_shelf")
        return [
            LotCandidate(
                lot_id="lot_on_shelf",
                product_id="prod_on_shelf",
                name="On-Shelf Item",
                brand=None,
                expected_weight_g=300.0,
                container_type="bottle",
                status="on_shelf",
                reference_image_paths=(),
            )
        ]

    def get_recently_out_lots(
        self, window_seconds: int, shelf_id: str | None = None
    ) -> Sequence[LotCandidate]:
        self.calls.append("recently_out")
        return [
            LotCandidate(
                lot_id="lot_recently_out",
                product_id="prod_recently_out",
                name="Recently Out Item",
                brand=None,
                expected_weight_g=200.0,
                container_type="bottle",
                status="out",
                reference_image_paths=(),
            )
        ]

    def get_in_flight_lots(
        self,
        max_age_seconds: int | None = None,
        shelf_id: str | None = None,
    ) -> Sequence[LotCandidate]:
        self.calls.append("in_flight")
        return [
            LotCandidate(
                lot_id="lot_in_flight",
                product_id="prod_in_flight",
                name="In-Flight Item",
                brand=None,
                expected_weight_g=150.0,
                container_type="bottle",
                status="in_flight",
                reference_image_paths=(),
            )
        ]

    def get_inventory_only_products(
        self, shelf_id: str | None = None
    ) -> Sequence[ProductCandidate]:
        self.calls.append("inventory_only")
        return [
            ProductCandidate(
                product_id="prod_inventory_only",
                name="Inventory-Only Item",
                brand=None,
                expected_weight_g=100.0,
                container_type="bottle",
                reference_image_paths=(),
            )
        ]

    def get_certified_not_on_shelf(self) -> Sequence[ProductCandidate]:
        self.calls.append("catalog")
        return [
            ProductCandidate(
                product_id="prod_catalog",
                name="Catalog Item",
                brand=None,
                expected_weight_g=50.0,
                container_type="bottle",
                reference_image_paths=(),
            )
        ]

    # Catch-all sources — separate product_ids so the pool composition
    # is unambiguous when this stub serves a catch-all event.

    def get_catch_all_in_flight_lots(self) -> Sequence[LotCandidate]:
        self.calls.append("catch_all_in_flight")
        return [
            LotCandidate(
                lot_id="lot_ca_in_flight",
                product_id="prod_ca_in_flight",
                name="Catch-All In-Flight",
                brand=None,
                expected_weight_g=120.0,
                container_type="bottle",
                status="in_flight",
                reference_image_paths=(),
            )
        ]

    def get_catch_all_inventory_lots(self) -> Sequence[LotCandidate]:
        self.calls.append("catch_all_inventory")
        return [
            LotCandidate(
                lot_id="lot_ca_inventory",
                product_id="prod_ca_inventory",
                name="Catch-All Inventory",
                brand=None,
                expected_weight_g=110.0,
                container_type="bottle",
                status="on_shelf",
                reference_image_paths=(),
            )
        ]


def _ctx(shelf_id: str | None) -> tuple[ClassifierContext, _Source]:
    src = _Source()
    return ClassifierContext(source=src, shelf_id=shelf_id), src


def _candidate_ids(pool) -> list[str]:
    return [c.candidate_id for c in pool]


def _whys(pool) -> set[str]:
    return {c.why_candidate for c in pool}


# --- live_shelf — every tier MUST contribute ------------------------------


class TestLiveShelfPoolComposition:
    """Decision #45 + regression fix #53 + #54.

    The live_shelf is the multi-item open shelf and its ADD pool MUST
    include catalog_not_on_shelf so a fresh placement of a known SKU
    matches without a prior intake. Removing the catalog branch is the
    bug decision #54 fixes; this test pins it.
    """

    def test_live_shelf_pool_includes_every_tier(self):
        ctx, src = _ctx("live_shelf")
        pool = pool_for_add(delta_g=300.0, ctx=ctx)
        whys = _whys(pool)

        # Decision #45 + #53 + #54: every tier must be present for the
        # live_shelf. If a tier is silently dropped from the union,
        # this assertion fails with the missing tier name spelled out.
        for required in (
            "in_flight",
            "recently_out",
            "top_up_target",
            "inventory_only",
            "catalog_not_on_shelf",
        ):
            assert required in whys, (
                f"live_shelf ADD pool MUST include the {required!r} tier "
                f"(decisions.md #45/#53/#54). Got tiers: {sorted(whys)}. "
                f"Drop in pool_for_add → silent regression of the "
                f"chicken/Gatorade case fix."
            )

        # UNKNOWN sentinel last — required by the classifier prompt
        # contract.
        assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID

    def test_live_shelf_pool_calls_catalog_branch(self):
        """The catalog branch was DROPPED for non-live_shelf shelves
        in decision #54. Pin that the live_shelf still asks for it —
        a stub that asks "did you query catalog?" is the most direct
        way to detect the gate flipping closed.
        """
        ctx, src = _ctx("live_shelf")
        pool_for_add(delta_g=300.0, ctx=ctx)
        assert "catalog" in src.calls, (
            "live_shelf ADD pool MUST query the catalog source "
            "(decisions.md #54). Failure here means pool_for_add's "
            "shelf gate flipped closed for live_shelf."
        )


# --- single_item — catalog/inventory_only behavior pinned -----------------


class TestSingleItemPoolComposition:
    """Decision #45 (preserved): the LiveTrack single_item scale path
    must NOT mint from a place event, so the catalog_not_on_shelf
    branch MUST stay closed. Re-opening it is exactly the chicken-case
    bug.
    """

    def test_single_item_pool_excludes_catalog(self):
        ctx, src = _ctx("single_item")
        pool = pool_for_add(delta_g=300.0, ctx=ctx)
        whys = _whys(pool)

        # Decision #45: single_item NEVER includes catalog_not_on_shelf.
        # If this fires, decision #45 has been silently regressed.
        assert "catalog_not_on_shelf" not in whys, (
            "single_item ADD pool MUST NOT include catalog_not_on_shelf "
            "(decisions.md #45 — the chicken case). The LiveTrack flow "
            "requires intake-first; classifier-driven minting from a "
            "place event is forbidden on this path."
        )

        # And the catalog source MUST NOT have been queried at all —
        # a strong negative-side assertion.
        assert "catalog" not in src.calls, (
            "single_item ADD pool MUST NOT query the catalog source "
            "(decisions.md #45). pool_for_add's shelf gate is leaking."
        )

    def test_single_item_pool_keeps_inventory_branches(self):
        ctx, _ = _ctx("single_item")
        pool = pool_for_add(delta_g=300.0, ctx=ctx)
        whys = _whys(pool)

        # The inventory-driven tiers MUST still be present — decision
        # #45's "inventory-only matching" rule, not "no candidates."
        for required in (
            "in_flight",
            "recently_out",
            "top_up_target",
            "inventory_only",
        ):
            assert required in whys, (
                f"single_item ADD pool MUST include {required!r} "
                f"(decisions.md #45 — inventory-only matching). "
                f"Pool dropped this tier — classifier will UNKNOWN-out "
                f"every legit placement."
            )


# --- catch_all — single-pool spec from decision #56 -----------------------


class TestCatchAllPoolComposition:
    """Decision #56: the catch-all pool is a SINGLE pool used for both
    first and second events. Composition is in-flight catch_all + cert
    not-on-any-shelf + UNKNOWN. Adding live_shelf-shape branches here
    re-introduces the cross-shelf bleed bug #56 was designed against.
    """

    def test_catch_all_pool_is_single_pool_with_correct_tiers(self):
        ctx, src = _ctx("catch_all")
        pool = pool_for_catch_all(delta_g=120.0, ctx=ctx)
        whys = _whys(pool)

        # Decision #56: only the catch-all-specific sources contribute.
        assert "in_flight" in whys, (
            "catch_all pool MUST include in_flight catch-all lots "
            "(decisions.md #56 Tier 1)."
        )
        assert "inventory_only" in whys, (
            "catch_all pool MUST include certified-not-on-any-shelf lots "
            "(decisions.md #56 Tier 2)."
        )

        # Live-shelf branches MUST NOT bleed in — a hand of catch-all
        # bugs (#55, #56) relate to mixing pool semantics.
        forbidden = {
            "recently_out",
            "top_up_target",
            "catalog_not_on_shelf",
        }
        leaked = forbidden & whys
        assert not leaked, (
            f"catch_all pool MUST NOT include {leaked!r} — these are "
            f"live_shelf-only branches (decisions.md #56). Bleed = "
            f"cross-shelf state corruption."
        )

        # UNKNOWN sentinel last.
        assert pool[-1].candidate_id == UNKNOWN_CANDIDATE_ID

    def test_catch_all_pool_is_lot_keyed_not_product_keyed(self):
        """Decision #56: the catch-all uses lot_id as candidate_id (not
        product_id). The Pi state machine inspects the picked lot's
        in_flight_kind to decide first vs second event — collapsing
        to product_id loses that discriminator.
        """
        ctx, _ = _ctx("catch_all")
        pool = pool_for_catch_all(delta_g=120.0, ctx=ctx)
        # Filter sentinel out.
        non_sentinel = [c for c in pool if c.candidate_id != UNKNOWN_CANDIDATE_ID]
        assert non_sentinel, (
            "catch_all pool returned only the sentinel — stub source "
            "should have produced two real candidates."
        )
        for c in non_sentinel:
            assert c.candidate_id.startswith("lot_"), (
                f"catch_all candidate {c.candidate_id!r} appears to be "
                f"keyed by product_id, but decision #56 mandates "
                f"lot-keyed candidates so the apply path can route "
                f"first-vs-second events from in_flight_kind."
            )

    def test_catch_all_pool_does_not_query_live_shelf_sources(self):
        """The catch-all pool builder MUST NOT call live_shelf-only
        sources. Calling them is dead-code in the best case, and a
        cross-shelf data leak in the worst.
        """
        ctx, src = _ctx("catch_all")
        pool_for_catch_all(delta_g=120.0, ctx=ctx)
        for forbidden_call in ("on_shelf", "recently_out", "catalog"):
            assert forbidden_call not in src.calls, (
                f"catch_all pool builder MUST NOT call {forbidden_call!r} "
                f"(decisions.md #56 — single-pool composition). The "
                f"live_shelf branches bleed into catch-all if this fires."
            )
