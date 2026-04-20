"""Live Shelf classifier package.

Bundle D deliverable: candidate pool assembly + Anthropic multimodal
classifier that identifies which product moved onto or off of the shelf
for a given scale event.

Primary entry point: :func:`classify.classify_event`. Bundle H is
expected to supply a concrete :class:`models.CandidateSource` implementation
backed by Bundle A's storage layer.
"""

from .models import (
    Candidate,
    CandidateReason,
    CandidateSource,
    ClassificationResult,
    ClassifierContext,
    LotCandidate,
    ProductCandidate,
    ScaleEvent,
    UNKNOWN_CANDIDATE_ID,
)

__all__ = [
    "Candidate",
    "CandidateReason",
    "CandidateSource",
    "ClassificationResult",
    "ClassifierContext",
    "LotCandidate",
    "ProductCandidate",
    "ScaleEvent",
    "UNKNOWN_CANDIDATE_ID",
]
