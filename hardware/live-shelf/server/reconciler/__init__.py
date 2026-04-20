"""Bundle E — Session reconciler.

Closes out a scale session by pairing REMOVE/ADD events into resolutions,
detecting consumption, new arrivals, swaps, etc.

Public surface:
    - reconcile_session(session_id, repo) -> list[SessionResolution]
    - ReconcilerRepo  (Protocol injected by Bundle H)
    - models: PairingCandidate, PatternClassification, SessionResolution, etc.
"""

from .models import (
    PairingCandidate,
    PatternClassification,
    ClassificationResult,
    MatchCandidate,
    ScaleEventLike,
    SessionLike,
    LotLike,
    SessionResolution,
    ReviewQueueItem,
    UNKNOWN_ITEM_IDS,
)
from .reconcile import (
    ReconcilerRepo,
    reconcile_session,
    classify_pair,
)

__all__ = [
    "PairingCandidate",
    "PatternClassification",
    "ClassificationResult",
    "MatchCandidate",
    "ScaleEventLike",
    "SessionLike",
    "LotLike",
    "SessionResolution",
    "ReviewQueueItem",
    "ReconcilerRepo",
    "reconcile_session",
    "classify_pair",
    "UNKNOWN_ITEM_IDS",
]
