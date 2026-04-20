"""Intermediate types for the reconciler.

These are intentionally loose (Protocols + dataclasses) so Bundle A's
storage layer and Bundle D's classifier can supply objects that
satisfy the shape without having to import from this module. The
reconciler reads fields; it never constructs domain entities that
must round-trip back to the database by itself (except via repo
methods).

Schemas below mirror §3 (scale_events, session_resolutions, lots,
sessions) and §4.5 (classifier output).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Protocol, runtime_checkable


# Sentinel values that the classifier uses when it cannot identify an item.
# §4.5: item_id = "<candidate_id>" | "unknown". We normalize case and also
# accept the literal sentinel "UNKNOWN" that may appear in candidate pools.
UNKNOWN_ITEM_IDS: frozenset[str] = frozenset({"unknown", "UNKNOWN", ""})


# --- Classifier output (mirrors §4.5 / §7.1) -----------------------------


Direction = Literal["add", "remove", "noise"]


Pattern = Literal[
    "use_return_no_consumption",
    "use_return_consumed",
    "topped_up",
    "consumed_or_removed",
    "new_arrival",
    "swap_out",
    "swap_in",
    "relocation",  # out of scope for single-shelf demo
    "unknown",
    "no_op",
]


ReviewKind = Literal[
    "unknown_item_add",
    "low_confidence",
    "weight_mismatch",
    "unpaired_remove",
    "multi_match",
    "failed_intake",
    "sensor_anomaly",
]


LotStatus = Literal["on_shelf", "out", "depleted", "relocated", "lost"]


@dataclass(frozen=True)
class MatchCandidate:
    """One element of ClassificationResult.multi_match."""

    candidate_id: str
    confidence: float


@dataclass(frozen=True)
class ClassificationResult:
    """Structured form of §4.5 classifier JSON.

    Stored in `scale_events.classification` as JSON. For the reconciler,
    only these fields are needed. Either a raw dict or this dataclass
    is acceptable input — the reconciler normalizes via
    `normalize_classification()`.
    """

    item_id: Optional[str]
    action: Optional[str] = None
    confidence: float = 0.0
    reasoning: Optional[str] = None
    multi_match: list[MatchCandidate] = field(default_factory=list)
    secondary_candidates: list[MatchCandidate] = field(default_factory=list)


def normalize_classification(raw: Any) -> ClassificationResult:
    """Accept a dict, a ClassificationResult, or None and return one.

    Bundle D stores classifier output as JSON in `scale_events.classification`.
    Depending on how Bundle H hydrates events, this field will arrive either
    as a dict (json.loads of the column) or already as a ClassificationResult.
    """
    if raw is None:
        return ClassificationResult(item_id=None)
    if isinstance(raw, ClassificationResult):
        return raw
    if isinstance(raw, dict):
        multi_raw = raw.get("multi_match") or []
        secondary_raw = raw.get("secondary_candidates") or []
        return ClassificationResult(
            item_id=raw.get("item_id"),
            action=raw.get("action"),
            confidence=float(raw.get("confidence", 0.0) or 0.0),
            reasoning=raw.get("reasoning"),
            multi_match=[
                MatchCandidate(
                    candidate_id=str(m.get("candidate_id")),
                    confidence=float(m.get("confidence", 0.0) or 0.0),
                )
                for m in multi_raw
                if m and m.get("candidate_id") is not None
            ],
            secondary_candidates=[
                MatchCandidate(
                    candidate_id=str(s.get("candidate_id")),
                    confidence=float(s.get("confidence", 0.0) or 0.0),
                )
                for s in secondary_raw
                if s and s.get("candidate_id") is not None
            ],
        )
    raise TypeError(
        f"Cannot normalize classification of type {type(raw).__name__}"
    )


# --- Domain shapes the reconciler reads from the repo --------------------


@runtime_checkable
class ScaleEventLike(Protocol):
    """Subset of `scale_events` that the reconciler needs.

    Implementations may be SQLite rows wrapped in a light dataclass,
    dicts coerced via attrgetter, or full ORM objects — all that matters
    is that these attributes resolve.
    """

    event_id: str
    session_id: Optional[str]
    ts: str  # ISO8601 UTC
    delta_g: float
    before_weight_g: float
    after_weight_g: float
    direction: Direction
    classification: Any  # raw JSON/dict/ClassificationResult


@runtime_checkable
class SessionLike(Protocol):
    """Subset of `sessions`."""

    session_id: str
    started_at: str
    ended_at: Optional[str]
    initial_shelf_weight_g: Optional[float]
    final_shelf_weight_g: Optional[float]


@runtime_checkable
class LotLike(Protocol):
    """Subset of `lots`."""

    lot_id: str
    product_id: str
    status: LotStatus
    current_weight_g: Optional[float]


# --- Write-side shapes (consumed by repo) --------------------------------


@dataclass
class SessionResolution:
    """Payload the reconciler hands to `repo.write_resolution`.

    Mirrors the `session_resolutions` table columns minus
    `resolution_id` (assigned by storage) and `created_at`.
    """

    session_id: str
    pattern: Pattern
    lot_id: Optional[str] = None
    consumed_g: Optional[float] = None
    confidence: Optional[float] = None
    add_event_id: Optional[str] = None
    remove_event_id: Optional[str] = None


@dataclass
class ReviewQueueItem:
    """Payload the reconciler hands to `repo.enqueue_review`."""

    kind: ReviewKind
    session_id: Optional[str] = None
    event_id: Optional[str] = None
    resolution_id: Optional[str] = None
    proposed: Optional[dict] = None  # serialized to JSON by storage
    images: Optional[list[str]] = None  # list of relative paths


# --- Intermediate types used internally by reconcile.py ------------------


@dataclass
class PairingCandidate:
    """A (remove, add) pair the reconciler is considering in Pass 1.

    Retained as a named intermediate so the logic is debuggable and
    so test authors can assert on it if they want to unit-test the
    pairing step in isolation.
    """

    remove_event: ScaleEventLike
    add_event: ScaleEventLike
    lot_id: str
    consumed_g: float


@dataclass
class PatternClassification:
    """Output of `classify_pair()` — pattern + the computed consumption."""

    pattern: Pattern
    consumed_g: float
