"""Concrete protocol implementations wiring Bundle A (storage) into the
other bundles that depend on narrow protocols.

Each adapter is a thin, storage-agnostic class exposing only the methods
its consumer needs. The orchestrator constructs them in app.py.

Nothing outside Bundle H should import these directly — callers receive
instances via the factories that accept the matching Protocol.
"""

from __future__ import annotations

from .candidate_source import RepoCandidateSource
from .camera_source import CameraDaemonSource
from .intake_repo import RepoIntakeFacade
from .reconciler_repo import RepoReconcilerAdapter
from .web_repo import RepoWebAdapter

__all__ = [
    "CameraDaemonSource",
    "RepoCandidateSource",
    "RepoIntakeFacade",
    "RepoReconcilerAdapter",
    "RepoWebAdapter",
]
