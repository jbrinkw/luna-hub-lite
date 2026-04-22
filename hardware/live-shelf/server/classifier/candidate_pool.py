"""Candidate pool assembly.

Implements the rules in §6 of hardware/live-shelf/docs/plan.md:

  §6.1 ADD pool  — union(recently_out + top_up_target + catalog_not_on_shelf)
                   + UNKNOWN sentinel (always last).
  §6.2 REMOVE pool — currently on-shelf lots, ranked by weight proximity.
  §6.3 Weight-proximity scoring formula.

Rankings use a smooth 0..1 proximity score, but only *ordering* is fed to
the classifier (per the plan's "classifier gets ranks, not raw scores"
clause). The sentinel UNKNOWN entry is always present in the ADD pool and
is always the final entry after ranking.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

from .models import (
    UNKNOWN_CANDIDATE_ID,
    Candidate,
    CandidateSource,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
)

# §6.1: top-up matches when |expected_added_weight - add_delta| < 25% of expected.
# Interpreted as a tolerance on the *additive* weight: a refill of ~dN grams
# onto an existing container gets matched against lots whose expected refill
# range includes |delta|. Since we only know the lot's *current* weight, we
# treat any on-shelf lot as a possible top-up target when the delta is within
# a configurable fraction of its expected refill band. The band is proxied by
# the lot's current weight — in practice, a top-up is a small fraction of
# the container, not a full new placement.
TOP_UP_RELATIVE_TOLERANCE = 0.25

# Sentinel candidate — always included in the ADD pool. Kept as a module-level
# constant so tests can assert identity cheaply.
UNKNOWN_SENTINEL = Candidate(
    candidate_id=UNKNOWN_CANDIDATE_ID,
    name="Unknown / new item",
    brand=None,
    expected_weight_g=None,
    container_type=None,
    why_candidate="sentinel",
    reference_image_paths=(),
    rank_score=0.0,
)


# --- Ranking ---------------------------------------------------------------


def weight_proximity_score(expected: float | None, observed_abs_delta: float) -> float:
    """§6.3: smooth 0..1 proximity score.

    ``score = exp(-((|expected - |delta||) / expected)^2 * 4)``

    When ``expected`` is unknown or non-positive, we fall back to zero so
    those candidates rank last among their tier rather than crashing.
    """

    if expected is None or expected <= 0:
        return 0.0
    ratio = abs(expected - observed_abs_delta) / expected
    return math.exp(-(ratio * ratio) * 4)


def _tier_rank(why: str) -> int:
    """Lower number = higher priority (see §6.1 + in-flight plan §5.1).

    0. in_flight — item was just picked up; strictly most likely to be
       returning. Ranked above recently_out regardless of weight fit
       because the physical coupling (still in the user's hand) is
       stronger evidence than a loose weight match to an older lot.
    1. recently_out with matching weight
    2. top_up_target
    3. catalog_not_on_shelf with matching weight
    4. remaining items by weight proximity
    5. UNKNOWN always last
    """

    return {
        "in_flight": 0,
        "recently_out": 1,
        "top_up_target": 2,
        "catalog_not_on_shelf": 3,
        "currently_on_shelf": 4,
        "sentinel": 5,
    }.get(why, 4)


def _matches_weight(candidate: Candidate, observed_abs_delta: float) -> bool:
    """True if the candidate's expected weight is within 30% of |delta|.

    Threshold is a soft "within the right ballpark" filter used to split
    ``recently_out`` and ``catalog_not_on_shelf`` into "matching weight"
    (higher priority) vs "fallback by proximity" (lower priority).
    """

    if candidate.expected_weight_g is None or candidate.expected_weight_g <= 0:
        return False
    ratio = abs(candidate.expected_weight_g - observed_abs_delta) / candidate.expected_weight_g
    return ratio <= 0.30


def _rank_candidates(candidates: list[Candidate], observed_abs_delta: float) -> list[Candidate]:
    """Apply §6.1's ranking rules, keeping the sentinel last.

    Re-emits each input as a new dataclass instance with its ``rank_score``
    populated, because the dataclass is frozen.
    """

    scored: list[tuple[tuple[int, float], Candidate]] = []
    for c in candidates:
        score = weight_proximity_score(c.expected_weight_g, observed_abs_delta)
        c = Candidate(
            candidate_id=c.candidate_id,
            name=c.name,
            brand=c.brand,
            expected_weight_g=c.expected_weight_g,
            container_type=c.container_type,
            why_candidate=c.why_candidate,
            reference_image_paths=c.reference_image_paths,
            rank_score=score,
            product_id=c.product_id,
        )

        tier = _tier_rank(c.why_candidate)
        # Split priority tiers between "weight-matches" and "fallback" for
        # recently_out and catalog_not_on_shelf, per §6.1.
        if c.why_candidate == "recently_out":
            tier = 1 if _matches_weight(c, observed_abs_delta) else 4
        elif c.why_candidate == "catalog_not_on_shelf":
            tier = 3 if _matches_weight(c, observed_abs_delta) else 4

        # Sort key: (tier ascending, score descending). UNKNOWN is forced to
        # tier 5 above so it always ends up last.
        scored.append(((tier, -score), c))

    scored.sort(key=lambda pair: pair[0])
    return [c for _, c in scored]


def _ensure_sentinel_last(candidates: list[Candidate]) -> list[Candidate]:
    """Guarantee the UNKNOWN sentinel is present exactly once, as the last entry."""

    non_sentinel = [c for c in candidates if c.candidate_id != UNKNOWN_CANDIDATE_ID]
    return non_sentinel + [UNKNOWN_SENTINEL]


# --- Adapters: storage row -> Candidate ------------------------------------


def _from_lot(lot: LotCandidate, why: str) -> Candidate:
    return Candidate(
        candidate_id=lot.lot_id,
        name=lot.name,
        brand=lot.brand,
        expected_weight_g=lot.expected_weight_g,
        container_type=lot.container_type,
        why_candidate=why,  # type: ignore[arg-type]
        reference_image_paths=lot.reference_image_paths,
        product_id=lot.product_id,
    )


def _from_product(product: ProductCandidate) -> Candidate:
    return Candidate(
        candidate_id=product.product_id,
        name=product.name,
        brand=product.brand,
        expected_weight_g=product.expected_weight_g,
        container_type=product.container_type,
        why_candidate="catalog_not_on_shelf",
        reference_image_paths=product.reference_image_paths,
        product_id=product.product_id,
    )


def _dedupe_by_product(candidates: Iterable[Candidate]) -> list[Candidate]:
    """Dedupe the ADD pool union.

    Fix 4: dedupe on ``candidate_id`` (lot_id for LotCandidate sources,
    product_id for ProductCandidate sources). The previous key —
    ``name|container_type`` — collapsed two distinct lots of the same
    SKU into one entry, which hid a second on-shelf/out lot of the same
    product from the classifier. ``candidate_id`` is unique per lot and
    per product, so distinct instances are preserved while genuine
    duplicates (same lot appearing via two branches, or the UNKNOWN
    sentinel showing up pre-rank) still collapse.

    Stable preference order: the first occurrence in the union order
    wins. Callers pass recently_out first (§6.1 listing order), so
    lot-backed candidates take precedence over bare products naturally.
    """

    seen_keys: set[str] = set()
    out: list[Candidate] = []
    for c in candidates:
        key = c.candidate_id
        if key in seen_keys:
            continue
        seen_keys.add(key)
        out.append(c)
    return out


# --- Shelf-scoping compatibility helper ------------------------------------


def _call_source(fn, *args, shelf_id: str | None = None):
    """Invoke a CandidateSource method, passing ``shelf_id`` when accepted.

    The CandidateSource Protocol grew a ``shelf_id`` optional arg in
    CATCH_ALL_SCALE_PLAN.md §5.2. Older implementations and many test
    stubs pre-date that change and raise :class:`TypeError` when called
    with an unexpected kwarg. This helper prefers the shelf-aware call
    and falls back to the legacy signature on TypeError.

    When ``shelf_id`` is None, the function is called without the kwarg
    (preserves the legacy signature exactly).
    """
    if shelf_id is None:
        return fn(*args)
    try:
        return fn(*args, shelf_id=shelf_id)
    except TypeError:
        # Stub doesn't accept shelf_id — degrade gracefully. Callers still
        # pass ctx.shelf_id through the DB-backed adapter in production,
        # so this branch only matters for test stubs that never see
        # multi-shelf data anyway.
        return fn(*args)


# --- Public API ------------------------------------------------------------


def pool_for_add(
    delta_g: float,
    ctx: ClassifierContext,
    *,
    top_n: int | None = None,
) -> list[Candidate]:
    """Assemble the ADD candidate pool for an add-direction event.

    Follows §6.1 exactly: union the three branches, dedupe by product,
    rank by tier+weight-proximity, truncate to top-N, append UNKNOWN.

    Args:
        delta_g: Positive scale delta in grams.
        ctx: Classifier context carrying the :class:`CandidateSource`.
        top_n: Optional override for the pool cap (default ``ctx.pool_top_n``).
    """

    source: CandidateSource = ctx.source
    observed_abs = abs(delta_g)
    limit = top_n if top_n is not None else ctx.pool_top_n
    shelf_id = getattr(ctx, "shelf_id", None)

    # Branch 0: in-flight lots — items the user recently lifted and is
    # likely putting back. Ranked above recently_out. Retrieved via
    # getattr to stay compatible with older CandidateSource stubs in
    # tests that don't implement get_in_flight_lots.
    get_in_flight = getattr(source, "get_in_flight_lots", None)
    in_flight_lots: list[Candidate] = []
    in_flight_lot_rows: list[Any] = []
    if callable(get_in_flight):
        in_flight_lot_rows = list(_call_source(get_in_flight, shelf_id=shelf_id))
        in_flight_lots = [
            _from_lot(lot, "in_flight") for lot in in_flight_lot_rows
        ]

    # Branch 1: recently out lots — optionally shelf-scoped.
    recently_out = [
        _from_lot(lot, "recently_out")
        for lot in _call_source(
            source.get_recently_out_lots,
            ctx.recently_out_window_seconds,
            shelf_id=shelf_id,
        )
    ]

    # Branch 2: top-up targets — on-shelf lots whose expected refill tolerance
    # matches the observed delta. "expected refill" is approximated as the
    # lot's current weight range; treating it as a 0..current band, anything
    # within 25% of the lot's expected weight counts.
    top_up_targets: list[Candidate] = []
    for lot in _call_source(source.get_on_shelf_lots, shelf_id=shelf_id):
        if lot.expected_weight_g is None or lot.expected_weight_g <= 0:
            continue
        # A top-up is a small positive delta relative to the container — use
        # the relative tolerance against the lot's current weight as a proxy.
        tolerance = lot.expected_weight_g * TOP_UP_RELATIVE_TOLERANCE
        if observed_abs <= tolerance:
            top_up_targets.append(_from_lot(lot, "top_up_target"))

    # Branch 3: certified products not currently on the shelf. The catalog
    # is shared across shelves (CATCH_ALL_SCALE_PLAN.md §5.2) so we don't
    # thread shelf_id here.
    catalog_not_on_shelf = [
        _from_product(p) for p in source.get_certified_not_on_shelf()
    ]

    # In-flight reunite guard: when a product has a lot in-flight on this
    # shelf, suppress the product's catalog entry. Rationale: both the
    # in-flight lot and the catalog product carry the same SKU identity
    # but different expected_weight_g semantics (pickup_weight_g vs
    # full/gross weight). A partially-consumed returning bottle (|delta|
    # lighter than the catalog weight) lets the classifier reason its
    # way to the catalog entry with a "partially full" justification,
    # which mints a brand-new lot and orphans the in-flight one. By
    # dropping the catalog dup, the only way for the model to represent
    # "same SKU back on shelf" is via the in-flight lot_id — which the
    # handler routes to _apply_add_against_in_flight_lot correctly.
    in_flight_product_ids = {
        lot.product_id for lot in in_flight_lot_rows
    }
    if in_flight_product_ids:
        catalog_not_on_shelf = [
            c for c in catalog_not_on_shelf
            if c.candidate_id not in in_flight_product_ids
        ]

    # In-flight first so it wins duplicate-id collisions (same lot listed
    # as in_flight AND recently_out when the status just flipped).
    union = in_flight_lots + recently_out + top_up_targets + catalog_not_on_shelf
    deduped = _dedupe_by_product(union)

    ranked = _rank_candidates(deduped, observed_abs)
    # Keep top (limit - 1) so the sentinel fits in the final list.
    truncated = ranked[: max(0, limit - 1)]
    return _ensure_sentinel_last(truncated)


def pool_for_remove(
    delta_g: float,
    ctx: ClassifierContext,
    *,
    top_n: int | None = None,
) -> list[Candidate]:
    """Assemble the REMOVE candidate pool (§6.2).

    Returns the currently-on-shelf lots, ranked by individual weight
    proximity to ``|delta|``. The sentinel is NOT appended: §6.2 specifies
    the classifier is told to return 1+ items summing to ``|delta|`` or
    ``"unknown"``, not a sentinel candidate.

    Fallback: when no on-shelf lots exist (e.g. the user admin-deleted
    their lots but physical items are still on the shelf, or the demo
    was reset mid-session), fall back to the catalog of certified
    products. Without this, every REMOVE event during a no-lot period
    becomes a blanket UNKNOWN with no multi_match, losing the one bit
    of signal the LLM can still provide (identifying products visible
    in the before-frame whose combined weight sums to |delta|). The
    fallback entries are tagged ``why_candidate="currently_on_shelf"``
    so downstream reasoning about "what was visibly on the shelf"
    still makes sense — the classifier's job is to confirm presence
    in the before-frame either way.
    """

    source: CandidateSource = ctx.source
    observed_abs = abs(delta_g)
    limit = top_n if top_n is not None else ctx.pool_top_n
    shelf_id = getattr(ctx, "shelf_id", None)

    on_shelf_lots = list(
        _call_source(source.get_on_shelf_lots, shelf_id=shelf_id)
    )
    candidates = [_from_lot(lot, "currently_on_shelf") for lot in on_shelf_lots]

    if not candidates:
        # Catalog fallback: assemble Candidate rows from certified products.
        # Use the product_id as candidate_id — downstream minting in
        # scale_events.py already handles "id resolves to product_id
        # (minting new lot)" for ADD events; for REMOVE events we don't
        # mint, but the resolution/review-queue row still records the
        # attribution so the session timeline isn't empty.
        catalog = list(source.get_certified_not_on_shelf())
        candidates = [_from_product(p) for p in catalog]

    ranked = _rank_candidates(candidates, observed_abs)
    return ranked[:limit]
