"""Per-user classifier settings cached in-memory on the Pi.

The Pi normally treats the cloud as authoritative for inventory + lots,
but classifier behavior toggles live on ``hub.profiles`` and only ever
flow one way (cloud → Pi). This module is a tiny thread-safe holder
that the lot-snapshot poller refreshes on each tick (60s) and the
classifier reads on each event.

Single-process, single-user — the live-shelf demo runs as one Pi
serving one user, so we don't bother with per-user keying. If/when the
demo grows multi-user, the holder API stays the same; just add a
``user_id -> ClassifierSettings`` dict inside.

Why an in-memory cache (not SQLite + a poller table):

  * Settings are tiny + scalar — overhead of a table + migration is
    pure ceremony.
  * A 60s staleness window is fine for these flags. The user just
    flipped the toggle in the web UI; they can wait one minute for
    the Pi to pick it up.
  * Restart-on-crash returns to default (FALSE). The first poller
    tick re-fetches the live value within 60s of boot. The brief
    explicitly says "default OFF — explicit opt-in" so a brief
    no-fallback window post-reboot is acceptable.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ClassifierSettings:
    """Snapshot of per-user classifier toggles."""

    # When TRUE, the classifier runs a second pass against all
    # certified LiveTrack-tracked products if pass-1 returns UNKNOWN
    # / low confidence. Default FALSE — explicit opt-in.
    chefbyte_classifier_fallback_enabled: bool = False


class ClassifierSettingsCache:
    """Thread-safe holder for the latest :class:`ClassifierSettings`.

    The lot-snapshot poller calls :meth:`update` once per tick with the
    freshly-fetched cloud value. The classifier calls :meth:`get` on
    every event. Both operations are O(1) and synchronised via a
    plain :class:`threading.Lock` — read traffic is well under once
    per second so there's no contention worth optimising.
    """

    def __init__(
        self,
        initial: Optional[ClassifierSettings] = None,
    ) -> None:
        self._lock = threading.Lock()
        self._settings: ClassifierSettings = initial or ClassifierSettings()
        # Track whether at least one successful refresh has happened —
        # used by /api/state diagnostics to distinguish "we never
        # synced" from "we synced and the user has it off."
        self._synced: bool = initial is not None

    def get(self) -> ClassifierSettings:
        with self._lock:
            return self._settings

    def update(self, settings: ClassifierSettings) -> bool:
        """Replace the cached settings; return True iff the value changed.

        Logs at INFO when a flag flips so operators can correlate
        behaviour changes against the user's web-UI actions.
        """
        with self._lock:
            prev = self._settings
            self._settings = settings
            self._synced = True
        changed = prev != settings
        if changed:
            log.info(
                "classifier-settings: refreshed (fallback_enabled %s -> %s)",
                prev.chefbyte_classifier_fallback_enabled,
                settings.chefbyte_classifier_fallback_enabled,
            )
        return changed

    @property
    def synced(self) -> bool:
        with self._lock:
            return self._synced


# ---------------------------------------------------------------------------
# Module-level singleton — wired by app.py at boot. Tests typically
# instantiate their own ClassifierSettingsCache instead of touching the
# global; but a default global is convenient for codepaths that just
# need to query "is fallback on?" without plumbing the cache reference
# through every layer.
# ---------------------------------------------------------------------------

_GLOBAL_CACHE: ClassifierSettingsCache = ClassifierSettingsCache()


def get_global_cache() -> ClassifierSettingsCache:
    return _GLOBAL_CACHE


def set_global_cache(cache: ClassifierSettingsCache) -> None:
    global _GLOBAL_CACHE
    _GLOBAL_CACHE = cache


__all__ = [
    "ClassifierSettings",
    "ClassifierSettingsCache",
    "get_global_cache",
    "set_global_cache",
]
