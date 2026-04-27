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
    3. inventory_only — cloud-mirror product with no Pi shelf history.
       Ranked below top_up_target because the user has never placed
       this lot on the shelf before (no on-shelf evidence to lean on),
       but above the catalog branch because the product IS in cloud
       inventory (decision #45 + 2026-04-27 regression fix #53).
    4. catalog_not_on_shelf — catalog products with no inventory at
       all. Re-introduced 2026-04-27 for live_shelf only (decision
       #54). Ranked LAST among real branches so a weight-coincident
       catalog candidate can never beat an existing in_flight /
       on_shelf / inventory_only entry for the same product —
       _dedupe_by_product keeps the higher-tier representative.
    5. remaining items by weight proximity
    6. UNKNOWN always last
    """

    return {
        "in_flight": 0,
        "recently_out": 1,
        "top_up_target": 2,
        "inventory_only": 3,
        "catalog_not_on_shelf": 4,
        "currently_on_shelf": 5,
        "sentinel": 6,
    }.get(why, 5)


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
            lot_id=c.lot_id,
        )

        tier = _tier_rank(c.why_candidate)
        # Split priority tiers between "weight-matches" and "fallback" for
        # recently_out (catalog_not_on_shelf is dropped per the
        # inventory-only rule).
        if c.why_candidate == "recently_out":
            tier = 1 if _matches_weight(c, observed_abs_delta) else 5

        # Sort key: (tier ascending, score descending). UNKNOWN is forced to
        # tier 6 above so it always ends up last.
        scored.append(((tier, -score), c))

    scored.sort(key=lambda pair: pair[0])
    return [c for _, c in scored]


def _ensure_sentinel_last(candidates: list[Candidate]) -> list[Candidate]:
    """Guarantee the UNKNOWN sentinel is present exactly once, as the last entry."""

    non_sentinel = [c for c in candidates if c.candidate_id != UNKNOWN_CANDIDATE_ID]
    return non_sentinel + [UNKNOWN_SENTINEL]


# --- Adapters: storage row -> Candidate ------------------------------------


def _from_lot(lot: LotCandidate, why: str) -> Candidate:
    """Build a product-keyed Candidate from a lot row.

    **2026-04-27:** ``candidate_id`` is the lot's ``product_id``, NOT
    the ``lot_id``. The classifier sees products only; the apply path
    resolves the actual lot deterministically via
    ``_pick_best_lot_for_product`` (decisions.md #42).
    """
    return Candidate(
        candidate_id=lot.product_id,
        name=lot.name,
        brand=lot.brand,
        expected_weight_g=lot.expected_weight_g,
        container_type=lot.container_type,
        why_candidate=why,  # type: ignore[arg-type]
        reference_image_paths=lot.reference_image_paths,
        product_id=lot.product_id,
        lot_id=lot.lot_id,
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
        lot_id=None,
    )


def _from_inventory_only_product(product: ProductCandidate) -> Candidate:
    """Build a ``why_candidate='inventory_only'`` candidate from a cloud-only product.

    Identical projection to :func:`_from_product` except the reason
    code differs. Kept as a separate helper so the call sites read
    intent-clearly (``inventory_only`` vs the deprecated catalog
    branch).
    """
    return Candidate(
        candidate_id=product.product_id,
        name=product.name,
        brand=product.brand,
        expected_weight_g=product.expected_weight_g,
        container_type=product.container_type,
        why_candidate="inventory_only",
        reference_image_paths=product.reference_image_paths,
        product_id=product.product_id,
        # No Pi-local lot_id — the cloud lot lives in cloud_lots, the
        # apply path mints a Pi shadow lot when the classifier picks.
        lot_id=None,
    )


# Tier preference for collapsing multiple lots of the same product into one
# Candidate. Lower index = stronger evidence the lot is "the one" the user
# is interacting with. Mirrors ``_tier_rank`` but split out so the collapser
# can prefer in_flight/recently_out lots without depending on the ranking
# pipeline. See decisions.md #42 for the design rationale.
_PRODUCT_COLLAPSE_PRIORITY = {
    "in_flight": 0,
    "recently_out": 1,
    "top_up_target": 2,
    "currently_on_shelf": 3,
    # inventory_only is the lowest-priority real signal — the product
    # is in cloud inventory but has no Pi shelf history, so any other
    # branch with shelf evidence wins the collapse.
    "inventory_only": 4,
    "catalog_not_on_shelf": 5,
    "sentinel": 6,
}


def _dedupe_by_product(candidates: Iterable[Candidate]) -> list[Candidate]:
    """Collapse multiple lots of the same product into one Candidate.

    **2026-04-27 design (decisions.md #42):** the classifier sees one
    entry per product. When the union of ADD branches yields more than
    one candidate for the same ``product_id`` (e.g. an ``in_flight`` lot
    AND a ``catalog_not_on_shelf`` entry for the same SKU; or two
    ``recently_out`` lots of the same product on different shelves),
    we keep the strongest-tier representative and discard the rest.

    Stability: when two candidates of the same product have equal tier
    priority, the first-seen wins (callers pass branches in §6.1
    listing order, so the higher-tier branch is encountered first).

    Sentinel and catalog candidates with no ``product_id`` (e.g. the
    UNKNOWN sentinel itself) bypass collapse — they are unique by
    ``candidate_id``.
    """

    best_by_product: dict[str, Candidate] = {}
    other: list[Candidate] = []
    for c in candidates:
        # Sentinel + any candidate without a product_id is keyed by
        # candidate_id — preserves UNKNOWN exactly once.
        pid = c.product_id
        if pid is None:
            other.append(c)
            continue
        existing = best_by_product.get(pid)
        if existing is None:
            best_by_product[pid] = c
            continue
        new_pri = _PRODUCT_COLLAPSE_PRIORITY.get(c.why_candidate, 99)
        cur_pri = _PRODUCT_COLLAPSE_PRIORITY.get(existing.why_candidate, 99)
        if new_pri < cur_pri:
            best_by_product[pid] = c
    # Dedupe sentinel-or-no-pid by candidate_id to preserve UNKNOWN once.
    seen: set[str] = set()
    deduped_other: list[Candidate] = []
    for c in other:
        if c.candidate_id in seen:
            continue
        seen.add(c.candidate_id)
        deduped_other.append(c)
    return list(best_by_product.values()) + deduped_other


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

    **2026-04-27 three-shelf-three-pool design (decisions.md #45 +
    regression fix #53 + #54):** the ADD pool composition depends on
    the shelf kind. The pool is the union of:

    1. ``in_flight`` lots — items the user just lifted, expected to
       come back.
    2. ``recently_out`` lots — items removed within the last 24h.
    3. ``top_up_target`` lots — items currently on this shelf.
    4. ``inventory_only`` products — cloud-mirror ``cloud_lots`` row
       with ``qty_containers > 0`` and no Pi-local lot on this shelf
       yet. The "intaked-but-not-yet-placed" case. Apply path only
       mints a Pi-local lot mirroring the existing cloud lot; the
       cloud lot itself is promoted via ``resolve_add_to_shelf_lot``
       step 2/3, NOT minted.
    5. ``catalog_not_on_shelf`` products — gated on
       ``shelf_id == 'live_shelf'``. Re-introduced 2026-04-27 (decisions
       #54): the live_shelf is the "open multi-item shelf" mental model
       and the user expects fresh placements of catalog products to
       match without a prior intake step. Apply path mints both a
       Pi-local lot AND the cloud stock_lot via ``new_arrival`` →
       ``resolve_add_to_shelf_lot`` step 5. **Decision #45's
       inventory-only rule is preserved for the LiveTrack
       (single_item) scale path** — its cloud-side resolver is
       inventory-aware and that flow's user expectation is "one
       container per scale, must be intaked first." The catch_all
       path is owned by a separate workstream.

    Why: items normally arrive on the live-shelf weighing LESS than
    the original tracked weight (consumed untracked between purchase
    and shelf-pairing). The product-keyed dedupe + tier collapse means
    the lot picker prefers the in-flight / on-shelf / recently-out lot
    over a stale catalog entry of the same SKU when both exist, so a
    weight-mismatched catalog candidate cannot accidentally orphan a
    legitimate inventory lot. The ``catalog_not_on_shelf`` branch only
    wins when no other branch produced a candidate for that product.

    Why decision #54 (this branch's reintroduction): users have
    catalog products with no ``stock_lots`` rows (e.g. uncertified
    items, or items intaked through paths that don't create a lot).
    Without this branch on the live_shelf, a fresh placement returns
    UNKNOWN even though the user has the product in their catalog.
    The user's expectation: "general products to be matchable on the
    live_shelf even if no stock_lots exist yet" — codified in
    decisions.md #54.

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

    # Branch 2: every on-shelf lot is an inventory candidate for ADD.
    # Previously this branch was filtered to "top_up_targets" (small delta
    # relative to current weight), which excluded the most common ADD case
    # — placing a product back on the shelf that has on-shelf siblings.
    # Per the inventory-only rule, on-shelf lots are now candidates for
    # any ADD: the classifier picks a product, the apply path then
    # decides between top-up vs. revive-out vs. in-flight-return.
    top_up_targets: list[Candidate] = []
    for lot in _call_source(source.get_on_shelf_lots, shelf_id=shelf_id):
        if lot.expected_weight_g is None or lot.expected_weight_g <= 0:
            continue
        top_up_targets.append(_from_lot(lot, "top_up_target"))

    # Branch 3: inventory_only — products whose only inventory is in the
    # cloud_lots mirror (no Pi-local lots row on this shelf). This is
    # the regression fix from 2026-04-27: decision #45's "must be in
    # inventory" rule was being read as "must be in Pi local lots,"
    # which made every first-place-on-this-shelf event return UNKNOWN
    # because the user's cloud inventory wasn't visible to the pool
    # builder. The cloud-side resolver (``resolve_add_to_shelf_lot``
    # step 2/3) then promotes the existing cloud stock_lot to
    # live_shelf-tracked when the apply path emits the cloud event —
    # this is NOT minting a new cloud lot, just promoting an existing
    # one to "shelf-tracked" status.
    inventory_only_lots: list[Candidate] = []
    get_inventory_only = getattr(source, "get_inventory_only_products", None)
    if callable(get_inventory_only):
        try:
            inventory_only_rows = list(
                _call_source(get_inventory_only, shelf_id=shelf_id)
            )
        except Exception:  # noqa: BLE001 - defensive: pool must never crash
            # Stub or DB error — degrade gracefully (legacy single-shelf
            # behavior with cloud-only products invisible). Caller will
            # see the empty branch in the union and the existing
            # in_flight / recently_out / top_up branches still apply.
            inventory_only_rows = []
        inventory_only_lots = [
            _from_inventory_only_product(p) for p in inventory_only_rows
        ]

    # Branch 4: catalog_not_on_shelf — re-introduced 2026-04-27 for the
    # ``live_shelf`` shelf kind only (decisions.md #54). The user's
    # multi-item live-shelf is the "open shelf" mental model: any catalog
    # product can be placed there even if there's no existing inventory
    # lot. Decision #45's "must be in inventory" rule still applies to
    # the LiveTrack (single_item) scale path (its cloud-side resolver
    # was always inventory-aware), and the catch_all path is owned by a
    # separate workstream — we explicitly leave both UNCHANGED. This
    # branch is what lets a fresh container of a known catalog product
    # (e.g. user has Tortillas in catalog with no stock_lots) match on
    # the classifier without going through a barcode-scan first.
    #
    # The mint side is in
    # ``scale_events._mint_pi_lot_for_catalog_pick`` — gated on
    # ``shelf_id == 'live_shelf'`` defensively even if a non-live_shelf
    # event somehow surfaces a catalog candidate.
    catalog_lots: list[Candidate] = []
    if shelf_id == "live_shelf":
        get_certified = getattr(source, "get_certified_not_on_shelf", None)
        if callable(get_certified):
            try:
                catalog_rows = list(get_certified())
            except Exception:  # noqa: BLE001 - never crash the pool builder
                catalog_rows = []
            catalog_lots = [_from_product(p) for p in catalog_rows]

    # In-flight first so it wins duplicate-id collisions (same lot listed
    # as in_flight AND recently_out when the status just flipped).
    # inventory_only / catalog_not_on_shelf LAST so any branch with shelf
    # history wins the _dedupe_by_product collapse for the same product_id.
    union = (
        in_flight_lots
        + recently_out
        + top_up_targets
        + inventory_only_lots
        + catalog_lots
    )
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

    Returns the currently-on-shelf lots, collapsed by ``product_id``
    and ranked by weight proximity. The sentinel is NOT appended: §6.2
    specifies the classifier returns 1+ items summing to ``|delta|`` or
    ``"unknown"``, not a sentinel.

    **2026-04-27 lots-out-of-prompt (decisions.md #42):** REMOVE
    candidates are also collapsed to one per product. When the same
    product has multiple on-shelf lots (e.g. two yogurts of the same
    SKU), the classifier sees one entry; the apply path's
    ``_pick_best_lot_for_product`` picks the actual lot (FEFO).
    Multi_match for a single product picked twice is meaningless to
    the classifier under this contract — the model should populate
    multi_match with DISTINCT product_ids only.

    Fallback: when no on-shelf lots exist, the pool is empty. The
    pre-2026-04-27 catalog fallback is removed for consistency with
    the inventory-only ADD rule — a REMOVE with no inventory is a
    sensor anomaly, not something the classifier should guess at.
    """

    source: CandidateSource = ctx.source
    observed_abs = abs(delta_g)
    limit = top_n if top_n is not None else ctx.pool_top_n
    shelf_id = getattr(ctx, "shelf_id", None)

    on_shelf_lots = list(
        _call_source(source.get_on_shelf_lots, shelf_id=shelf_id)
    )
    raw_candidates = [_from_lot(lot, "currently_on_shelf") for lot in on_shelf_lots]
    # Collapse multiple lots of the same product so the classifier sees
    # products only.
    candidates = _dedupe_by_product(raw_candidates)

    ranked = _rank_candidates(candidates, observed_abs)
    return ranked[:limit]
