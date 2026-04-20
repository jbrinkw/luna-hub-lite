"""Shared lock primitives for the Live Shelf server.

A single :class:`NullLock` is re-exported from here so the adapters +
intake sync layer don't each carry their own copy of the pattern. The
class is a drop-in for ``threading.Lock`` in contexts where a caller
wants to keep the same ``with self._lock:`` shape even when no real
lock is needed (tests with single-threaded in-memory DBs, legacy call
sites that never wired a shared lock in the first place).
"""

from __future__ import annotations

from typing import Any


class NullLock:
    """No-op lock — satisfies the context-manager protocol + the minimal
    ``Lock``-style ``acquire``/``release`` surface.

    Previously each adapter module (``candidate_source.py``,
    ``intake_repo.py``, ``web_repo.py``, ``intake/cloud_sync.py``)
    defined its own ``_NullLock`` class with identical behavior. They're
    now all imported from here so future tweaks (logging, metrics, etc.)
    stay in one place.
    """

    def __enter__(self) -> "NullLock":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def acquire(self, *_a: Any, **_kw: Any) -> bool:
        return True

    def release(self) -> None:
        return None


__all__ = ["NullLock"]
