"""Typed input/output models for the classifier.

These dataclasses define the interface between Bundle D and its callers.
They are intentionally small, immutable where possible, and independent
of Bundle A's storage implementation. Bundle H is expected to adapt
Bundle A's rows into these models through a :class:`CandidateSource`.

Reference: hardware/live-shelf/docs/plan.md
  - §4.5 classifier input/output schemas
  - §6 candidate pool assembly rules
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, Sequence

# Sentinel id for the "unknown / new item" escape hatch. Always included in
# the ADD candidate pool (see §6.1) as the final candidate.
UNKNOWN_CANDIDATE_ID = "UNKNOWN"


# --- Candidate shapes ------------------------------------------------------

CandidateReason = Literal[
    "currently_on_shelf",
    "recently_out",
    "top_up_target",
    "catalog_not_on_shelf",
    "sentinel",
    # In-flight tracker (IN_FLIGHT_TRACKER_PLAN.md §5.1). A lot that was
    # picked up from the shelf and is expected back. Ranked above
    # ``recently_out`` on the ADD pool.
    "in_flight",
    # 2026-04-27 fix: product has at least one cloud-side stock_lot with
    # qty_containers>0 (mirrored to the Pi's ``cloud_lots`` table) but no
    # Pi-local ``lots`` row on this shelf yet. This is the
    # "general-inventory → live-shelf" case that decision #45 referred to
    # when it said "the user must intake the product first" — once intaked
    # (cloud lot exists), placing it on the shelf must match against that
    # cloud inventory, not return UNKNOWN. Ranked below top_up_target
    # because the cloud lot has not been physically observed on the shelf
    # before, but above the dropped catalog branch.
    "inventory_only",
]


@dataclass(frozen=True)
class ProductCandidate:
    """A product that is eligible but has no live lot currently on the shelf.

    Used for the "catalog not-on-shelf" branch of the ADD pool (§6.1). The
    classifier treats this as a potential match for a brand-new placement.
    """

    product_id: str
    name: str
    brand: str | None
    expected_weight_g: float | None
    container_type: str | None
    reference_image_paths: Sequence[str] = field(default_factory=tuple)


@dataclass(frozen=True)
class LotCandidate:
    """A lot backed by a physical instance currently tracked on the shelf.

    Covers status='on_shelf' (REMOVE pool + top-up targets), 'out' (ADD
    pool recently_out branch), and 'in_flight' (ADD pool in_flight branch,
    IN_FLIGHT_TRACKER_PLAN.md §5.1). For in-flight lots the adapter sets
    ``expected_weight_g`` to ``pickup_weight_g`` so the classifier scores
    against the mass the user took off — exactly what the returning ADD
    event's delta should match (minus consumption).
    """

    lot_id: str
    product_id: str
    name: str
    brand: str | None
    expected_weight_g: float | None  # current_weight_g for on-shelf, pickup_weight_g for in-flight, last known for out
    container_type: str | None
    status: Literal["on_shelf", "in_flight", "out"]
    reference_image_paths: Sequence[str] = field(default_factory=tuple)
    # Catch-all auto-import (2026-05-02): the new Tier 2 source
    # ``get_catch_all_user_inventory_lots`` populates these so the
    # pool builder can derive ``Candidate.needs_tare_estimate``
    # without a second SQL round-trip. ``None`` for legacy callers
    # (``get_catch_all_inventory_lots``, live-shelf branches) — those
    # paths don't drive auto-import tare estimation.
    tare_weight_g: float | None = None
    net_weight_g: float | None = None


@dataclass(frozen=True)
class Candidate:
    """A single entry in the ranked candidate list sent to the classifier.

    **2026-04-27 invariant:** ``candidate_id`` is the underlying
    ``product_id`` for every non-sentinel entry. The classifier never
    sees lot-level identifiers — lot resolution is purely deterministic
    on the apply-path side (see ``_pick_best_lot_for_product`` in
    ``handlers/scale_events.py``). The user's design intent is captured
    in decisions.md #42: classifier picks a product, programmatic
    matcher picks the lot.

    The internal ``lot_id`` field below preserves the underlying lot
    identity for the *single* most-likely lot a product was sourced
    from — the apply path uses it as a fast-path hint but is allowed
    to override it via ``_pick_best_lot_for_product`` when fresh
    inventory state is more authoritative (e.g. a lot status changed
    between pool assembly and classification return).
    """

    candidate_id: str
    name: str
    brand: str | None
    expected_weight_g: float | None
    container_type: str | None
    why_candidate: CandidateReason
    reference_image_paths: Sequence[str] = field(default_factory=tuple)
    # Score used for ranking. Not serialised into the prompt — the classifier
    # only sees the ranked order (see §6.3 "classifier gets ranks, not raw
    # scores").
    rank_score: float = 0.0
    # Underlying product_id. After the 2026-04-27 lots-out-of-prompt fix
    # this ALWAYS equals ``candidate_id`` for non-sentinel candidates.
    # Kept as an explicit field for backwards-compat with apply-path
    # validation that grew ``valid_product_ids`` cross-checks.
    product_id: str | None = None
    # Underlying lot_id for lot-backed candidates (``in_flight``,
    # ``recently_out``, ``top_up_target``, ``currently_on_shelf``).
    # ``None`` for ``catalog_not_on_shelf`` and the UNKNOWN sentinel.
    # NEVER serialised into the prompt — see ``to_prompt_dict`` below.
    # The candidate_pool builder collapses multiple lots of the same
    # product into one ``Candidate``; this field carries the
    # representative lot's id for diagnostics + as a hint to the
    # apply-path lot picker. The picker is authoritative when a lot's
    # state has shifted since pool assembly.
    lot_id: str | None = None
    # Catch-all auto-import (2026-05-02): the apply path needs to know
    # whether the picked candidate's product has a tare captured yet,
    # so it can ask the AI for an estimate when missing. The flag is
    # surfaced into ``to_prompt_dict`` ONLY when True — set-once means
    # already-captured products don't waste prompt tokens on the flag.
    # Paired with ``net_weight_g`` so the AI has the full container's
    # net mass to compare against the visual.
    needs_tare_estimate: bool = False
    net_weight_g: float | None = None

    def to_prompt_dict(self) -> dict[str, Any]:
        """Project into the JSON payload the classifier sees.

        Reference images are injected as separate image blocks in the user
        message, so only a count+placeholder marker is included here to keep
        the JSON compact and debuggable.

        **Invariant:** the dict NEVER contains lot-level keys
        (``lot_id``, ``expires_on``, ``qty_containers``, ``in_flight_since``,
        ``pickup_weight_g``, ``current_weight_g``, ``status``, ``last_out_at``,
        ``placed_at``, ``last_seen_at``). Test
        ``test_prompt::test_prompt_never_leaks_lot_fields`` pins this
        contract — failing it means the classifier is being shown
        per-lot state again, which the user has explicitly forbidden
        (decisions.md #42).

        Catch-all auto-import (2026-05-02): when ``needs_tare_estimate``
        is True, the dict carries ``needs_tare_estimate=True`` and
        ``net_weight_g`` so the model is told to provide an
        ``estimated_tare_g`` in its response. When False (default for
        already-captured products), neither key is emitted.
        """

        out: dict[str, Any] = {
            "candidate_id": self.candidate_id,
            "name": self.name,
            "brand": self.brand,
            "expected_weight_g": self.expected_weight_g,
            "container_type": self.container_type,
            "why_candidate": self.why_candidate,
            "reference_image_count": len(self.reference_image_paths),
        }
        if self.needs_tare_estimate:
            out["needs_tare_estimate"] = True
            out["net_weight_g"] = self.net_weight_g
        return out


# --- Event + context ------------------------------------------------------


@dataclass(frozen=True)
class ScaleEvent:
    """Minimal scale event the classifier needs.

    This is a subset of storage's ScaleEvent row (§3). Bundle H adapts the
    DB row into this shape before calling :func:`classify_event`.
    """

    event_id: str
    session_id: str | None
    ts: str
    delta_g: float
    before_weight_g: float
    after_weight_g: float
    direction: Literal["add", "remove", "noise"]
    before_frame_path: str | None
    after_frame_path: str | None


class CandidateSource(Protocol):
    """Protocol the candidate-pool module depends on.

    Bundle D never imports Bundle A's storage module directly. Instead,
    Bundle H injects a concrete implementation of this protocol at startup
    (typically backed by ``server.storage.repo``). Tests use a stub.

    All methods are read-only snapshots; they MUST be safe to call
    repeatedly within one classifier invocation.

    Shelf scoping (CATCH_ALL_SCALE_PLAN.md §5.2): lot-backed branches
    accept an optional ``shelf_id`` argument to restrict returns to one
    physical shelf. Older stubs/implementations that don't accept the
    kwarg still work — the candidate_pool module calls with getattr /
    try-except to stay compatible. The catalog branch
    (:meth:`get_certified_not_on_shelf`) is intentionally left unscoped
    because the certified product catalog is shared across shelves.
    """

    def get_on_shelf_lots(
        self, shelf_id: str | None = None
    ) -> Sequence[LotCandidate]:
        """Return every lot currently on the shelf.

        Used as:
          - The REMOVE pool in its entirety (§6.2).
          - The top-up-target pool for ADD events (§6.1).

        ``shelf_id`` optionally scopes to a single physical shelf.
        """

        ...

    def get_recently_out_lots(
        self, window_seconds: int, shelf_id: str | None = None
    ) -> Sequence[LotCandidate]:
        """Lots with ``status='out'`` where ``last_out_at > now - window_seconds``.

        Default window in §6.1 is 24h (``86_400`` seconds). ``shelf_id``
        optionally restricts to a single physical shelf.
        """

        ...

    def get_in_flight_lots(
        self,
        max_age_seconds: int | None = None,
        shelf_id: str | None = None,
    ) -> Sequence[LotCandidate]:
        """Lots with ``status='in_flight'`` — expected to return soon.

        Returns LotCandidate objects whose ``expected_weight_g`` is the
        pickup weight (not current_weight_g). ``max_age_seconds`` lets
        callers optionally scope to a freshness window (defaults to None =
        every in-flight lot regardless of age; the sweeper's TTL reaper is
        the authoritative cleanup path, so we don't filter here unless
        explicitly asked).

        ``shelf_id`` optionally restricts the query to a single physical
        shelf. When omitted, returns in-flight lots across both shelves.

        Returns an empty sequence when no lots are in-flight — tests can
        stub this to ``return []`` without implementing a real backing
        store, and pre-feature callers that don't implement it at all
        fall back via ``getattr`` in the candidate_pool module.
        """

        ...

    def get_inventory_only_products(
        self, shelf_id: str | None = None
    ) -> Sequence[ProductCandidate]:
        """Products with cloud-mirror inventory but no Pi lots on this shelf.

        Returns one ``ProductCandidate`` per (user, product) that has at
        least one row in the Pi's ``cloud_lots`` mirror table with
        ``qty_containers > 0`` AND has no live ``lots`` row scoped to
        ``shelf_id`` (in_flight / recently_out / on_shelf — these are
        already covered by the other branches). When ``shelf_id`` is
        ``None``, the absence-check covers every shelf.

        Rationale (decisions.md #45 + 2026-04-27 regression fix): the
        inventory-only matching rule is "product must be in inventory."
        Inventory means cloud ``stock_lots`` (mirrored as ``cloud_lots``
        on the Pi), NOT Pi-local ``lots``. A product the user intaked
        through the inventory page (creating a cloud stock_lot) but has
        not yet placed on the shelf must still be a valid ADD candidate
        — otherwise the very first place event for any newly-intaked
        product hits an empty pool and returns UNKNOWN.

        Returns an empty sequence when no cloud_lots rows exist or when
        every cloud_lots row has a corresponding Pi lot already.
        Implementations that don't support cloud mirroring (test stubs)
        may return ``[]``; the candidate_pool module's ``getattr``
        fallback treats a missing method as an empty result.
        """

        ...

    def get_certified_not_on_shelf(self) -> Sequence[ProductCandidate]:
        """Certified products eligible as ADD catalog candidates.

        Despite the historical method name, concrete implementations
        (see ``RepoCandidateSource.get_certified_not_on_shelf`` in
        ``server/adapters/candidate_source.py``) now return ALL
        certified products — including SKUs that already have an
        on-shelf lot. The name is preserved for protocol stability,
        but the semantics widened so the classifier can still match
        a second-unit placement of an already-on-shelf SKU.

        Rationale: the candidate pool dedupes on ``candidate_id``
        (lot_id vs product_id), so a product appearing as both a
        top-up target (keyed by its existing lot_id) and a catalog
        entry (keyed by its product_id) is preserved in both roles
        without collision — the per-SKU "is it already on shelf?"
        filter that motivated the original name is no longer needed.
        See ``storage.repo.get_all_certified_products`` for the full
        rationale.

        Deliberately NOT shelf-scoped: the certified catalog is shared
        across shelves (CATCH_ALL_SCALE_PLAN.md §5.2 — "everything on the
        catch-all is pre-intake'd via the same catalog"). A product
        that's on-shelf on the live_shelf can still be a catch-all
        catalog candidate and vice versa.
        """

        ...


@dataclass
class ClassifierContext:
    """Bag of dependencies :func:`classify.classify_event` needs.

    Kept as a plain dataclass (not frozen) so the orchestrator can swap
    mocks in tests without fiddly typing gymnastics.
    """

    source: CandidateSource
    # Optional override for the Anthropic client. Tests pass a fake here.
    anthropic_client: Any | None = None
    # Optional override for what "now" means when filtering recently-out lots.
    now_seconds: float | None = None
    # Window in seconds for "recently_out" candidates (see §6.1).
    recently_out_window_seconds: int = 24 * 60 * 60
    # Max candidates to include in a pool (see §6.1 "keep top 10").
    pool_top_n: int = 10
    # Shelf scoping (CATCH_ALL_SCALE_PLAN.md §5.2). When set, the
    # candidate pool restricts lot-backed branches (on_shelf,
    # recently_out, in_flight) to one physical shelf. The catalog
    # branch is always un-scoped. ``None`` preserves pre-catch-all
    # behavior — every existing live-shelf callsite leaves this unset.
    shelf_id: str | None = None


# --- Classifier output ----------------------------------------------------


@dataclass(frozen=True)
class SecondaryCandidate:
    """A non-primary candidate the classifier flagged (see §4.5)."""

    candidate_id: str
    confidence: float


ClassifierAction = Literal[
    "removed",
    "added",
    "added_to_existing",
    "unknown",
]


@dataclass(frozen=True)
class ClassificationResult:
    """Parsed, validated classifier response (see §4.5).

    Either ``secondary_candidates`` or ``multi_match`` is populated, never
    both. ``multi_match`` only makes sense for REMOVE events that pick up
    several items at once.
    """

    item_id: str  # candidate_id of the primary match, or UNKNOWN_CANDIDATE_ID
    action: ClassifierAction
    confidence: float
    reasoning: str
    secondary_candidates: Sequence[SecondaryCandidate] = field(default_factory=tuple)
    multi_match: Sequence[SecondaryCandidate] = field(default_factory=tuple)
    # Which candidate pool was sent to the model. Useful for audit + the
    # reconciler's "did I have the right options?" debug view.
    candidate_pool_used: Sequence[Candidate] = field(default_factory=tuple)
    # Free-form metadata (model id, cache stats, raw JSON, …). Not part of
    # the §4.5 spec but helpful for debugging.
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def unknown(
        cls,
        reasoning: str,
        candidate_pool_used: Sequence[Candidate] = (),
        meta: dict[str, Any] | None = None,
    ) -> "ClassificationResult":
        """Construct a safe "we don't know" result.

        Used when the model output is malformed and retry has been
        exhausted (see §4.5 / error-handling requirements).
        """

        return cls(
            item_id=UNKNOWN_CANDIDATE_ID,
            action="unknown",
            confidence=0.0,
            reasoning=reasoning,
            candidate_pool_used=tuple(candidate_pool_used),
            meta=meta or {},
        )
